package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
		},
	})
	httpSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		httpSrv.Close()
		srv.Close()
	})
	return srv, httpSrv
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

func readLiveFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) livev1.Frame {
	t.Helper()
	messageType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read websocket: %v", err)
	}
	if messageType != websocket.MessageBinary {
		t.Fatalf("message type=%v, want binary", messageType)
	}
	decoder := livev1.NewDecoder()
	frames, err := decoder.Push(data)
	if err != nil || len(frames) != 1 {
		t.Fatalf("decode frames=%d err=%v", len(frames), err)
	}
	return frames[0]
}

func attachLiveTestConnection(
	t *testing.T,
	ctx context.Context,
	baseURL string,
	sessionID string,
	connectionID string,
) *websocket.Conn {
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
	if _, err := livev1.DecodeAttached(readLiveFrame(t, ctx, conn)); err != nil {
		_ = conn.Close(websocket.StatusInternalError, "attach decode failed")
		t.Fatal(err)
	}
	return conn
}

func readOutputContaining(t *testing.T, ctx context.Context, conn *websocket.Conn, marker []byte) livev1.OutputRecord {
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
	defer conn.Close(websocket.StatusNormalClosure, "done")

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
	attached, err := livev1.DecodeAttached(readLiveFrame(t, ctx, conn))
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
		frame := readLiveFrame(t, ctx, conn)
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
		frame := readLiveFrame(t, ctx, conn)
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
	for index, connection := range []*websocket.Conn{first, second} {
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
	attach, _ := livev1.EncodeAttach(livev1.Attach{AttachGeneration: 1, Cols: 80, Rows: 24, SessionID: created.ID, ConnectionID: "c1"})
	if err := conn.Write(ctx, websocket.MessageBinary, attach); err != nil {
		t.Fatal(err)
	}
	_ = readLiveFrame(t, ctx, conn)
	input, _ := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("history-line\n")})
	if err := conn.Write(ctx, websocket.MessageBinary, input); err != nil {
		t.Fatal(err)
	}
	for {
		frame := readLiveFrame(t, ctx, conn)
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
