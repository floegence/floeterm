package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	terminal "github.com/floegence/floeterm/terminal-go"
	"github.com/floegence/floeterm/terminal-go/livev1"
)

type fixedShellResolver struct {
	shell string
}

func (r fixedShellResolver) ResolveShell(terminal.Logger) string { return r.shell }

type fixedShellArgsProvider struct {
	args []string
}

func (p fixedShellArgsProvider) GetShellArgs(string, string) ([]string, []string) { return p.args, nil }

func newTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	srv := New(Config{
		ManagerConfig: terminal.ManagerConfig{
			Logger:            terminal.NopLogger{},
			ShellResolver:     fixedShellResolver{shell: "/bin/sh"},
			ShellArgsProvider: fixedShellArgsProvider{args: []string{"-c", "cat"}},
			HistorySpoolRoot:  t.TempDir(),
		},
	})
	httpSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		httpSrv.Close()
		srv.Close()
	})
	return srv, httpSrv
}

func checkpointRequestForRecord(record livev1.OutputRecord, parserEpoch uint64, checkpointBytes []byte) historyCheckpointRequest {
	checksum := sha256.Sum256(checkpointBytes)
	return historyCheckpointRequest{
		FormatVersion:          1,
		EngineID:               "floegence-ghostty-web",
		CoveredThroughSequence: int64(record.Sequence),
		GeometryGeneration:     record.GeometryGeneration,
		ParserEpoch:            parserEpoch,
		Cols:                   int(record.Cols),
		Rows:                   int(record.Rows),
		ChecksumSHA256:         fmt.Sprintf("%x", checksum),
		StateDigestSHA256:      strings.Repeat("c", 64),
		BytesBase64:            base64.StdEncoding.EncodeToString(checkpointBytes),
	}
}

func postCheckpoint(t *testing.T, baseURL, sessionID string, request historyCheckpointRequest) *http.Response {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(
		baseURL+"/api/sessions/"+sessionID+"/checkpoint",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func TestCheckpointHTTPCommitReturnsCheckpointWithContiguousDelta(t *testing.T) {
	_, httpSrv := newTestServer(t)
	created := createTestSession(t, httpSrv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection := attachLiveTestConnection(t, ctx, httpSrv.URL, created.ID, "checkpoint-http")
	defer connection.Close(websocket.StatusNormalClosure, "done")

	firstInput, err := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("checkpoint-one\n")})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Write(ctx, websocket.MessageBinary, firstInput); err != nil {
		t.Fatal(err)
	}
	first := readOutputContaining(t, ctx, connection, []byte("checkpoint-one"))
	checkpointBytes := []byte("opaque-self-restored-checkpoint")
	response := postCheckpoint(t, httpSrv.URL, created.ID, checkpointRequestForRecord(first, 1, checkpointBytes))
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("checkpoint status=%d body=%s", response.StatusCode, body)
	}

	secondInput, err := livev1.EncodeInput(livev1.Input{Sequence: 2, Data: []byte("checkpoint-two\n")})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Write(ctx, websocket.MessageBinary, secondInput); err != nil {
		t.Fatal(err)
	}
	second := readOutputContaining(t, ctx, connection, []byte("checkpoint-two"))

	historyResponse, err := http.Get(fmt.Sprintf(
		"%s/api/sessions/%s/history?startSeq=1&endSeq=%d&historyGeneration=1",
		httpSrv.URL, created.ID, second.Sequence,
	))
	if err != nil {
		t.Fatal(err)
	}
	defer historyResponse.Body.Close()
	if historyResponse.StatusCode != http.StatusOK {
		t.Fatalf("history status=%d", historyResponse.StatusCode)
	}
	var page historyPageResponse
	if err := json.NewDecoder(historyResponse.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if page.Checkpoint == nil || page.Checkpoint.CoveredThroughSequence != int64(first.Sequence) {
		t.Fatalf("checkpoint page = %+v", page.Checkpoint)
	}
	if page.DeltaStartSequence != int64(first.Sequence+1) || len(page.Chunks) == 0 || page.Chunks[0].Sequence != int64(first.Sequence+1) {
		t.Fatalf("checkpoint delta is not contiguous: %+v", page)
	}
}

func TestCheckpointHTTPRejectsInvalidPayloadsWithoutAdvancingRetention(t *testing.T) {
	srv, httpSrv := newTestServer(t)
	created := createTestSession(t, httpSrv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection := attachLiveTestConnection(t, ctx, httpSrv.URL, created.ID, "checkpoint-invalid")
	defer connection.Close(websocket.StatusNormalClosure, "done")
	input, err := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("checkpoint-invalid\n")})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Write(ctx, websocket.MessageBinary, input); err != nil {
		t.Fatal(err)
	}
	record := readOutputContaining(t, ctx, connection, []byte("checkpoint-invalid"))
	valid := checkpointRequestForRecord(record, 1, []byte("checkpoint"))

	wrongChecksum := valid
	wrongChecksum.ChecksumSHA256 = strings.Repeat("0", 64)
	wrongEpoch := valid
	wrongEpoch.ParserEpoch = 2
	invalidBase64 := valid
	invalidBase64.BytesBase64 = "%%%"
	emptyBytes := valid
	emptyBytes.BytesBase64 = ""
	for _, testCase := range []struct {
		name    string
		request historyCheckpointRequest
		status  int
	}{
		{name: "checksum", request: wrongChecksum, status: http.StatusConflict},
		{name: "parser epoch", request: wrongEpoch, status: http.StatusConflict},
		{name: "base64", request: invalidBase64, status: http.StatusBadRequest},
		{name: "empty bytes", request: emptyBytes, status: http.StatusBadRequest},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			response := postCheckpoint(t, httpSrv.URL, created.ID, testCase.request)
			defer response.Body.Close()
			if response.StatusCode != testCase.status {
				body, _ := io.ReadAll(response.Body)
				t.Fatalf("status=%d want=%d body=%s", response.StatusCode, testCase.status, body)
			}
		})
	}

	unknownFieldBody, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	unknownFieldBody = append(unknownFieldBody[:len(unknownFieldBody)-1], []byte(`,"legacyPsk":"forbidden"}`)...)
	unknownResponse, err := http.Post(httpSrv.URL+"/api/sessions/"+created.ID+"/checkpoint", "application/json", bytes.NewReader(unknownFieldBody))
	if err != nil {
		t.Fatal(err)
	}
	defer unknownResponse.Body.Close()
	if unknownResponse.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown field status=%d", unknownResponse.StatusCode)
	}

	oversized := valid
	oversized.BytesBase64 = base64.StdEncoding.EncodeToString(make([]byte, maxCheckpointBytes+1))
	oversizedResponse := postCheckpoint(t, httpSrv.URL, created.ID, oversized)
	defer oversizedResponse.Body.Close()
	if oversizedResponse.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status=%d", oversizedResponse.StatusCode)
	}

	session, ok := srv.manager.GetSession(created.ID)
	if !ok {
		t.Fatal("session disappeared")
	}
	page, err := session.GetHistoryPage(terminal.HistoryPageOptions{StartSeq: 1})
	if err != nil {
		t.Fatal(err)
	}
	if page.Checkpoint != nil || page.FirstRetainedSequence != 1 || len(page.Chunks) == 0 {
		t.Fatalf("invalid checkpoint advanced retention: %+v", page)
	}
}

func createTestSession(t *testing.T, baseURL string) apiSessionInfo {
	t.Helper()
	resp, err := http.Post(baseURL+"/api/sessions", "application/json", bytes.NewBufferString(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create status=%d", resp.StatusCode)
	}
	var created apiSessionInfo
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	return created
}

func TestAPISessionInfoIncludesOutputActivity(t *testing.T) {
	got := toAPISessionInfo(terminal.TerminalSessionInfo{
		ID: "session-output",
		OutputActivity: terminal.TerminalOutputActivityInfo{
			Phase:     terminal.OutputActivitySettled,
			Revision:  7,
			UpdatedAt: 99,
		},
	})
	if got.OutputActivity.Phase != "settled" || got.OutputActivity.Revision != 7 || got.OutputActivity.UpdatedAtMs != 99 {
		t.Fatalf("output activity = %#v", got.OutputActivity)
	}
}

func TestHistoryPageResponseSerializesAuthoritativeCheckpoint(t *testing.T) {
	response := historyPageResponse{
		DeltaStartSequence: 5,
		Checkpoint: &historyCheckpointResponse{
			FormatVersion:          1,
			EngineID:               "floegence-ghostty-web",
			CoveredThroughSequence: 7,
			GeometryGeneration:     2,
			ParserEpoch:            11,
			Cols:                   80,
			Rows:                   24,
			ChecksumSHA256:         "a" + strings.Repeat("0", 63),
			StateDigestSHA256:      "b" + strings.Repeat("0", 63),
			BytesBase64:            base64.StdEncoding.EncodeToString([]byte("checkpoint")),
		},
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var decoded historyPageResponse
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.DeltaStartSequence != 5 || decoded.Checkpoint == nil || decoded.Checkpoint.BytesBase64 == "" || decoded.Checkpoint.CoveredThroughSequence != 7 {
		t.Fatalf("checkpoint response = %+v", decoded.Checkpoint)
	}
}

type liveTestConnection struct {
	conn    *websocket.Conn
	decoder *livev1.Decoder
	pending []livev1.Frame
}

func newLiveTestConnection(conn *websocket.Conn) *liveTestConnection {
	conn.SetReadLimit(livev1.MaxFramePayloadBytes + livev1.HeaderSize)
	return &liveTestConnection{
		conn:    conn,
		decoder: livev1.NewDecoder(),
	}
}

func (c *liveTestConnection) Write(ctx context.Context, messageType websocket.MessageType, data []byte) error {
	return c.conn.Write(ctx, messageType, data)
}

func (c *liveTestConnection) Close(status websocket.StatusCode, reason string) error {
	return c.conn.Close(status, reason)
}

func readLiveFrame(t *testing.T, ctx context.Context, conn *liveTestConnection) livev1.Frame {
	t.Helper()
	for len(conn.pending) == 0 {
		messageType, data, err := conn.conn.Read(ctx)
		if err != nil {
			t.Fatalf("read websocket: %v", err)
		}
		if messageType != websocket.MessageBinary {
			t.Fatalf("message type=%v, want binary", messageType)
		}
		frames, err := conn.decoder.Push(data)
		if err != nil {
			t.Fatalf("decode live frames: %v", err)
		}
		conn.pending = append(conn.pending, frames...)
	}
	frame := conn.pending[0]
	conn.pending = conn.pending[1:]
	return frame
}

func attachLiveTestConnection(
	t *testing.T,
	ctx context.Context,
	baseURL string,
	sessionID string,
	connectionID string,
) *liveTestConnection {
	t.Helper()
	conn, _, err := websocket.Dial(ctx, "ws"+baseURL[len("http"):]+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	attach, err := livev1.EncodeAttach(livev1.Attach{
		AttachGeneration: 1,
		Cols:             80,
		Rows:             24,
		SessionID:        sessionID,
		ConnectionID:     connectionID,
	})
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "attach encode failed")
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, attach); err != nil {
		_ = conn.Close(websocket.StatusInternalError, "attach write failed")
		t.Fatal(err)
	}
	liveConn := newLiveTestConnection(conn)
	if _, err := livev1.DecodeAttached(readLiveFrame(t, ctx, liveConn)); err != nil {
		_ = conn.Close(websocket.StatusInternalError, "attach decode failed")
		t.Fatal(err)
	}
	return liveConn
}

func readOutputContaining(t *testing.T, ctx context.Context, conn *liveTestConnection, marker []byte) livev1.OutputRecord {
	t.Helper()
	for {
		frame := readLiveFrame(t, ctx, conn)
		if frame.Type != livev1.FrameOutputBatch {
			continue
		}
		batch, err := livev1.DecodeOutputBatch(frame)
		if err != nil {
			t.Fatal(err)
		}
		for _, record := range batch.Records {
			if bytes.Contains(record.Data, marker) {
				return record
			}
		}
	}
}

func TestServerEndToEndBinaryLiveEchoAndResize(t *testing.T) {
	_, httpSrv := newTestServer(t)
	created := createTestSession(t, httpSrv.URL)
	if created.IsActive {
		t.Fatal("new session must remain dormant before live attach")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + httpSrv.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	liveConn := newLiveTestConnection(conn)
	defer liveConn.Close(websocket.StatusNormalClosure, "done")

	attach, err := livev1.EncodeAttach(livev1.Attach{
		AttachGeneration: 1,
		Cols:             80,
		Rows:             24,
		SessionID:        created.ID,
		ConnectionID:     "c1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, attach); err != nil {
		t.Fatal(err)
	}
	attached, err := livev1.DecodeAttached(readLiveFrame(t, ctx, liveConn))
	if err != nil || attached.HistoryGeneration == 0 {
		t.Fatalf("attached=%+v err=%v", attached, err)
	}

	input, err := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("hello\n")})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, input); err != nil {
		t.Fatal(err)
	}
	for {
		frame := readLiveFrame(t, ctx, liveConn)
		if frame.Type != livev1.FrameOutputBatch {
			continue
		}
		batch, err := livev1.DecodeOutputBatch(frame)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, record := range batch.Records {
			found = found || bytes.Contains(record.Data, []byte("hello"))
		}
		if found {
			break
		}
	}

	resize, err := livev1.EncodeResize(livev1.Resize{Sequence: 1, Cols: 120, Rows: 40})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, resize); err != nil {
		t.Fatal(err)
	}
	for {
		frame := readLiveFrame(t, ctx, liveConn)
		if frame.Type != livev1.FrameResizeApplied {
			continue
		}
		applied, err := livev1.DecodeResizeApplied(frame)
		if err != nil || applied.Sequence != 1 {
			t.Fatalf("resize applied=%+v err=%v", applied, err)
		}
		break
	}
}

func TestServerKeepsDistinctLiveConnectionsOnTheSameSessionUsable(t *testing.T) {
	srv, httpSrv := newTestServer(t)
	created := createTestSession(t, httpSrv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	first := attachLiveTestConnection(t, ctx, httpSrv.URL, created.ID, "page-a")
	defer first.Close(websocket.StatusNormalClosure, "done")
	second := attachLiveTestConnection(t, ctx, httpSrv.URL, created.ID, "page-b")
	defer second.Close(websocket.StatusNormalClosure, "done")

	input, err := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("MULTI_PAGE_ONE\n")})
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Write(ctx, websocket.MessageBinary, input); err != nil {
		t.Fatal(err)
	}
	firstRecord := readOutputContaining(t, ctx, first, []byte("MULTI_PAGE_ONE"))
	secondRecord := readOutputContaining(t, ctx, second, []byte("MULTI_PAGE_ONE"))
	if firstRecord.Sequence != secondRecord.Sequence || !bytes.Equal(firstRecord.Data, secondRecord.Data) {
		t.Fatalf("multi-page output diverged: first=%+v second=%+v", firstRecord, secondRecord)
	}
	for index, connection := range []*liveTestConnection{first, second} {
		resize, err := livev1.EncodeResize(livev1.Resize{
			Sequence: 1,
			Cols:     uint32(100 + index*20),
			Rows:     uint32(30 + index*10),
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := connection.Write(ctx, websocket.MessageBinary, resize); err != nil {
			t.Fatal(err)
		}
		for {
			frame := readLiveFrame(t, ctx, connection)
			if frame.Type != livev1.FrameResizeApplied {
				continue
			}
			applied, err := livev1.DecodeResizeApplied(frame)
			if err != nil || applied.Sequence != 1 {
				t.Fatalf("page %d resize acknowledgement=%+v err=%v", index+1, applied, err)
			}
			break
		}
	}
	if got := srv.manager.GetDiagnostics().ConnectionCount; got != 2 {
		t.Fatalf("multi-page connection count=%d, want 2", got)
	}

	if err := first.Close(websocket.StatusNormalClosure, "page closed"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if srv.manager.GetDiagnostics().LiveAttachmentCount == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if got := srv.manager.GetDiagnostics().LiveAttachmentCount; got != 1 {
		t.Fatalf("live attachments after one page closed=%d, want 1", got)
	}

	input, err = livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("MULTI_PAGE_TWO\n")})
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Write(ctx, websocket.MessageBinary, input); err != nil {
		t.Fatal(err)
	}
	_ = readOutputContaining(t, ctx, second, []byte("MULTI_PAGE_TWO"))
}

func TestServerRemovesLegacyLiveHTTPEndpoints(t *testing.T) {
	_, httpSrv := newTestServer(t)
	created := createTestSession(t, httpSrv.URL)
	for _, action := range []string{"attach", "resize", "input"} {
		resp, err := http.Post(
			httpSrv.URL+"/api/sessions/"+created.ID+"/"+action,
			"application/json",
			bytes.NewBufferString(`{}`),
		)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s status=%d, want 404", action, resp.StatusCode)
		}
	}
}

func TestPerformanceDiagnosticsRequireExplicitServerOptIn(t *testing.T) {
	_, defaultServer := newTestServer(t)
	resp, err := http.Get(defaultServer.URL + "/api/performance/runtime")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("default diagnostics status=%d, want 404", resp.StatusCode)
	}
	resp, err = http.Get(defaultServer.URL + "/api/performance/goroutines")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("default goroutine diagnostics status=%d, want 404", resp.StatusCode)
	}

	srv := New(Config{
		EnablePerformanceDiagnostics: true,
		ManagerConfig: terminal.ManagerConfig{
			Logger:            terminal.NopLogger{},
			ShellResolver:     fixedShellResolver{shell: "/bin/sh"},
			ShellArgsProvider: fixedShellArgsProvider{args: []string{"-c", "cat"}},
		},
	})
	httpSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		httpSrv.Close()
		srv.Close()
	})
	createTestSession(t, httpSrv.URL)

	resp, err = http.Get(httpSrv.URL + "/api/performance/runtime")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enabled diagnostics status=%d, want 200", resp.StatusCode)
	}
	var diagnostics map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&diagnostics); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"goroutines", "heap_bytes", "session_count", "connection_count", "live_attachment_count"} {
		if _, ok := diagnostics[key]; !ok {
			t.Fatalf("diagnostics omitted %q: %#v", key, diagnostics)
		}
	}

	profileResponse, err := http.Get(httpSrv.URL + "/api/performance/goroutines")
	if err != nil {
		t.Fatal(err)
	}
	defer profileResponse.Body.Close()
	if profileResponse.StatusCode != http.StatusOK {
		t.Fatalf("goroutine diagnostics status=%d, want 200", profileResponse.StatusCode)
	}
	if !profileResponse.Close {
		t.Fatal("goroutine diagnostics must close its intrusive profiling connection")
	}
	profile, err := io.ReadAll(profileResponse.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(profile, []byte("goroutine ")) {
		t.Fatalf("goroutine diagnostics omitted stack profile: %q", profile)
	}
}

func TestServerHistoryRemainsControlPlaneAfterLiveDisconnect(t *testing.T) {
	_, httpSrv := newTestServer(t)
	created := createTestSession(t, httpSrv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+httpSrv.URL[len("http"):]+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	liveConn := newLiveTestConnection(conn)
	attach, _ := livev1.EncodeAttach(livev1.Attach{AttachGeneration: 1, Cols: 80, Rows: 24, SessionID: created.ID, ConnectionID: "c1"})
	if err := conn.Write(ctx, websocket.MessageBinary, attach); err != nil {
		t.Fatal(err)
	}
	_ = readLiveFrame(t, ctx, liveConn)
	input, _ := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("history-line\n")})
	if err := conn.Write(ctx, websocket.MessageBinary, input); err != nil {
		t.Fatal(err)
	}
	for {
		frame := readLiveFrame(t, ctx, liveConn)
		if frame.Type != livev1.FrameOutputBatch {
			continue
		}
		batch, _ := livev1.DecodeOutputBatch(frame)
		seen := false
		for _, record := range batch.Records {
			seen = seen || bytes.Contains(record.Data, []byte("history-line"))
		}
		if seen {
			break
		}
	}
	_ = conn.Close(websocket.StatusNormalClosure, "done")

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(httpSrv.URL + "/api/sessions/" + created.ID + "/history?startSeq=1&endSeq=-1")
		if err != nil {
			t.Fatal(err)
		}
		var page historyPageResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&page)
		resp.Body.Close()
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		for _, chunk := range page.Chunks {
			data, err := base64.StdEncoding.DecodeString(chunk.DataBase64)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(data, []byte("history-line")) {
				if chunk.GeometryGeneration == 0 || chunk.Cols <= 0 || chunk.Rows <= 0 {
					t.Fatalf("history geometry was not serialized: %+v", chunk)
				}
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("history did not retain live output")
}

func TestServerJSONBodyLimitReturns413(t *testing.T) {
	_, httpSrv := newTestServer(t)
	oversized := append([]byte(`{"name":"`), bytes.Repeat([]byte("a"), int(maxJSONBodyBytesDefault)+1)...)
	oversized = append(oversized, []byte(`"}`)...)
	resp, err := http.Post(httpSrv.URL+"/api/sessions", "application/json", bytes.NewReader(oversized))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d, want 413", resp.StatusCode)
	}
}
