package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	terminal "github.com/floegence/floeterm/terminal-go"
	"github.com/floegence/floeterm/terminal-go/livev1"
)

func newTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	srv := New(Config{ManagerConfig: terminal.ManagerConfig{Logger: terminal.NopLogger{}}})
	httpSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { httpSrv.Close(); srv.Close() })
	return srv, httpSrv
}

func createTestSession(t *testing.T, baseURL string) apiSessionInfo {
	t.Helper()
	response, err := http.Post(baseURL+"/api/sessions", "application/json", strings.NewReader(`{"name":"semantic"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d", response.StatusCode)
	}
	var session apiSessionInfo
	if err := json.NewDecoder(response.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	return session
}

type liveTestConnection struct {
	conn    *websocket.Conn
	decoder *livev1.Decoder
	pending []livev1.Frame
}

func readLiveFrame(t *testing.T, ctx context.Context, connection *liveTestConnection) livev1.Frame {
	t.Helper()
	for len(connection.pending) == 0 {
		messageType, data, err := connection.conn.Read(ctx)
		if err != nil {
			t.Fatalf("read websocket: %v", err)
		}
		if messageType != websocket.MessageBinary {
			t.Fatalf("message type = %v", messageType)
		}
		frames, err := connection.decoder.Push(data)
		if err != nil {
			t.Fatal(err)
		}
		connection.pending = append(connection.pending, frames...)
	}
	frame := connection.pending[0]
	connection.pending = connection.pending[1:]
	return frame
}

func attachLive(t *testing.T, ctx context.Context, baseURL, sessionID, connectionID string) *liveTestConnection {
	t.Helper()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(baseURL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "test complete") })
	encoded, err := livev1.EncodeAttach(livev1.Attach{AttachGeneration: 1, Cols: 80, Rows: 24, SessionID: sessionID, ConnectionID: connectionID})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, encoded); err != nil {
		t.Fatal(err)
	}
	live := &liveTestConnection{conn: conn, decoder: livev1.NewDecoder()}
	if _, err := livev1.DecodeAttached(readLiveFrame(t, ctx, live)); err != nil {
		t.Fatal(err)
	}
	return live
}

func waitPresentationContaining(t *testing.T, ctx context.Context, connection *liveTestConnection, marker []byte) livev1.Frame {
	t.Helper()
	for {
		frame := readLiveFrame(t, ctx, connection)
		if frame.Type != livev1.FramePresentation {
			continue
		}
		var presentation struct {
			Frame struct {
				Rows [][][]json.RawMessage `json:"rows"`
			} `json:"frame"`
		}
		if err := json.Unmarshal(frame.Payload, &presentation); err != nil {
			t.Fatalf("decode semantic presentation: %v", err)
		}
		for _, row := range presentation.Frame.Rows {
			var text strings.Builder
			for _, cell := range row {
				if len(cell) == 0 {
					continue
				}
				var value string
				if err := json.Unmarshal(cell[0], &value); err != nil {
					t.Fatalf("decode semantic cell text: %v", err)
				}
				text.WriteString(value)
			}
			if bytes.Contains([]byte(text.String()), marker) {
				return frame
			}
		}
	}
}

func waitPresentationContentEpoch(t *testing.T, ctx context.Context, connection *liveTestConnection, epoch uint64) uint64 {
	t.Helper()
	for {
		frame := readLiveFrame(t, ctx, connection)
		if frame.Type != livev1.FramePresentation {
			continue
		}
		var presentation struct {
			Sequence uint64 `json:"sequence"`
			State    struct {
				ContentEpoch uint64 `json:"contentEpoch"`
			} `json:"state"`
		}
		if err := json.Unmarshal(frame.Payload, &presentation); err != nil {
			t.Fatalf("decode semantic presentation: %v", err)
		}
		if presentation.State.ContentEpoch == epoch {
			return presentation.Sequence
		}
	}
}

func waitForInitialPresentation(t *testing.T, ctx context.Context, session *terminal.Session) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if presentation, ok := session.LatestPresentation(); ok && presentation.Sequence > 1 {
			for _, row := range presentation.Frame.Rows {
				for _, cell := range row.Cells {
					if strings.TrimSpace(cell.Text) != "" {
						return
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			t.Fatalf("initial semantic presentation readiness: %v", ctx.Err())
		case <-ticker.C:
		}
	}
}

func TestServerSemanticLiveInputResizeAndPresentation(t *testing.T) {
	srv, httpSrv := newTestServer(t)
	session := createTestSession(t, httpSrv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	productSession, ok := srv.manager.GetSession(session.ID)
	if !ok {
		t.Fatal("session disappeared")
	}
	if _, ready := productSession.LatestPresentation(); !ready {
		t.Skip("semantic product E2E requires -tags floeterm_native")
	}
	live := attachLive(t, ctx, httpSrv.URL, session.ID, "view")
	waitForInitialPresentation(t, ctx, productSession)

	input, _ := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("printf SEMANTIC_ECHO\r")})
	if err := live.conn.Write(ctx, websocket.MessageBinary, input); err != nil {
		t.Fatal(err)
	}
	waitPresentationContaining(t, ctx, live, []byte("SEMANTIC_ECHO"))

	resize, _ := livev1.EncodeResize(livev1.Resize{Sequence: 1, Cols: 120, Rows: 40})
	if err := live.conn.Write(ctx, websocket.MessageBinary, resize); err != nil {
		t.Fatal(err)
	}
	for {
		frame := readLiveFrame(t, ctx, live)
		if frame.Type != livev1.FrameResizeApplied {
			continue
		}
		applied, err := livev1.DecodeResizeApplied(frame)
		if err != nil {
			t.Fatal(err)
		}
		if applied.Cols != 120 || applied.Rows != 40 || applied.GeometryGeneration == 0 {
			t.Fatalf("resize applied = %+v", applied)
		}
		break
	}
}

func TestServerKeepsTwoSemanticViewsOnOneSessionUsable(t *testing.T) {
	srv, httpSrv := newTestServer(t)
	session := createTestSession(t, httpSrv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	productSession, ok := srv.manager.GetSession(session.ID)
	if !ok {
		t.Fatal("session disappeared")
	}
	if _, ready := productSession.LatestPresentation(); !ready {
		t.Skip("semantic product E2E requires -tags floeterm_native")
	}
	first := attachLive(t, ctx, httpSrv.URL, session.ID, "first")
	waitForInitialPresentation(t, ctx, productSession)
	second := attachLive(t, ctx, httpSrv.URL, session.ID, "second")
	input, _ := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("printf MULTI_VIEW\r")})
	if err := second.conn.Write(ctx, websocket.MessageBinary, input); err != nil {
		t.Fatal(err)
	}
	waitPresentationContaining(t, ctx, first, []byte("MULTI_VIEW"))
	waitPresentationContaining(t, ctx, second, []byte("MULTI_VIEW"))
}

func TestServerSemanticClearPublishesOneContentEpochToEveryViewAndRejectsStaleTransport(t *testing.T) {
	srv, httpSrv := newTestServer(t)
	session := createTestSession(t, httpSrv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	productSession, ok := srv.manager.GetSession(session.ID)
	if !ok {
		t.Fatal("session disappeared")
	}
	if _, ready := productSession.LatestPresentation(); !ready {
		t.Skip("semantic product E2E requires -tags floeterm_native")
	}
	first := attachLive(t, ctx, httpSrv.URL, session.ID, "first")
	waitForInitialPresentation(t, ctx, productSession)
	second := attachLive(t, ctx, httpSrv.URL, session.ID, "second")
	input, _ := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("printf CLEAR_ME\\r")})
	if err := first.conn.Write(ctx, websocket.MessageBinary, input); err != nil {
		t.Fatal(err)
	}
	waitPresentationContaining(t, ctx, first, []byte("CLEAR_ME"))
	waitPresentationContaining(t, ctx, second, []byte("CLEAR_ME"))

	response, err := http.Post(
		httpSrv.URL+"/api/sessions/"+session.ID+"/semantic-clear",
		"application/json",
		strings.NewReader(`{"connectionId":"second","transportGeneration":1}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("semantic clear status=%d", response.StatusCode)
	}
	var settlement semanticClearResponse
	if err := json.NewDecoder(response.Body).Decode(&settlement); err != nil {
		t.Fatal(err)
	}
	if settlement.ContentEpoch != 1 || settlement.PresentationSequence == 0 {
		t.Fatalf("semantic clear settlement=%+v", settlement)
	}
	if got := waitPresentationContentEpoch(t, ctx, first, 1); got != settlement.PresentationSequence {
		t.Fatalf("first view clear sequence=%d settlement=%d", got, settlement.PresentationSequence)
	}
	if got := waitPresentationContentEpoch(t, ctx, second, 1); got != settlement.PresentationSequence {
		t.Fatalf("second view clear sequence=%d settlement=%d", got, settlement.PresentationSequence)
	}

	before, _ := productSession.LatestPresentation()
	stale, err := http.Post(
		httpSrv.URL+"/api/sessions/"+session.ID+"/semantic-clear",
		"application/json",
		strings.NewReader(`{"connectionId":"second","transportGeneration":2}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	_ = stale.Body.Close()
	if stale.StatusCode != http.StatusGone {
		t.Fatalf("stale semantic clear status=%d", stale.StatusCode)
	}
	after, _ := productSession.LatestPresentation()
	// The shell may emit ordinary bytes concurrently, so presentation sequence
	// can advance independently. A stale clear must not advance the reset epoch.
	if after.State.ContentEpoch != before.State.ContentEpoch {
		t.Fatalf("stale semantic clear changed presentation: before=%+v after=%+v", before.State, after.State)
	}
}

func TestServerRejectsRemovedRawHistoryEndpoints(t *testing.T) {
	_, httpSrv := newTestServer(t)
	session := createTestSession(t, httpSrv.URL)
	for _, request := range []struct{ method, path string }{
		{http.MethodGet, "/api/sessions/" + session.ID + "/history"},
		{http.MethodPost, "/api/sessions/" + session.ID + "/checkpoint"},
		{http.MethodGet, "/api/sessions/" + session.ID + "/stats"},
		{http.MethodPost, "/api/sessions/" + session.ID + "/clear"},
	} {
		req, _ := http.NewRequest(request.method, httpSrv.URL+request.path, nil)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s %s status = %d", request.method, request.path, response.StatusCode)
		}
	}
}

func TestPerformanceDiagnosticsRequireExplicitOptIn(t *testing.T) {
	_, httpSrv := newTestServer(t)
	response, err := http.Get(httpSrv.URL + "/api/performance/runtime")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("disabled diagnostics status = %d", response.StatusCode)
	}

	srv := New(Config{EnablePerformanceDiagnostics: true, ManagerConfig: terminal.ManagerConfig{Logger: terminal.NopLogger{}}})
	enabled := httptest.NewServer(srv.Handler())
	defer enabled.Close()
	defer srv.Close()
	response, err = http.Get(enabled.URL + "/api/performance/runtime")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("enabled diagnostics status = %d", response.StatusCode)
	}
	var payload performanceRuntimeResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Goroutines <= 0 {
		t.Fatalf("diagnostics = %+v", payload)
	}
}

func TestAPISessionInfoIncludesOutputActivity(t *testing.T) {
	got := toAPISessionInfo(terminal.TerminalSessionInfo{ID: "session", OutputActivity: terminal.TerminalOutputActivityInfo{Phase: terminal.OutputActivitySettled, Revision: 7, UpdatedAt: 99}})
	if got.OutputActivity.Phase != "settled" || got.OutputActivity.Revision != 7 || got.OutputActivity.UpdatedAtMs != 99 {
		t.Fatalf("output activity = %#v", got.OutputActivity)
	}
}

func TestServerJSONBodyLimitReturns413(t *testing.T) {
	_, httpSrv := newTestServer(t)
	body := fmt.Sprintf(`{"name":"%s"}`, strings.Repeat("x", int(maxJSONBodyBytesDefault)+1))
	response, err := http.Post(httpSrv.URL+"/api/sessions", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d", response.StatusCode)
	}
}
