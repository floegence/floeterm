package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	terminal "github.com/floegence/floeterm/terminal-go"
)

type fixedShellResolver struct {
	shell string
}

func (r fixedShellResolver) ResolveShell(terminal.Logger) string { return r.shell }

type fixedShellArgsProvider struct {
	args []string
}

func (p fixedShellArgsProvider) GetShellArgs(string, string) ([]string, []string) { return p.args, nil }

type logEntry struct {
	level string
	msg   string
	kv    []any
}

type recordingLogger struct {
	mu      sync.Mutex
	entries []logEntry
}

func (l *recordingLogger) Debug(msg string, kv ...any) { l.add("debug", msg, kv...) }
func (l *recordingLogger) Info(msg string, kv ...any)  { l.add("info", msg, kv...) }
func (l *recordingLogger) Warn(msg string, kv ...any)  { l.add("warn", msg, kv...) }
func (l *recordingLogger) Error(msg string, kv ...any) { l.add("error", msg, kv...) }

func (l *recordingLogger) add(level, msg string, kv ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, logEntry{level: level, msg: msg, kv: append([]any(nil), kv...)})
}

func (l *recordingLogger) hasKV(level, msg string, key string, value string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, entry := range l.entries {
		if entry.level != level || entry.msg != msg {
			continue
		}
		for i := 0; i+1 < len(entry.kv); i += 2 {
			k, ok := entry.kv[i].(string)
			if !ok || k != key {
				continue
			}
			if v, ok := entry.kv[i+1].(string); ok && v == value {
				return true
			}
		}
	}
	return false
}

func TestServer_EndToEndWebsocketEcho(t *testing.T) {
	srv := New(Config{
		ManagerConfig: terminal.ManagerConfig{
			Logger:                        terminal.NopLogger{},
			ShellResolver:                 fixedShellResolver{shell: "/bin/sh"},
			ShellArgsProvider:             fixedShellArgsProvider{args: []string{"-c", "cat"}},
			InitialResizeSuppressDuration: time.Millisecond,
			ResizeSuppressDuration:        time.Millisecond,
		},
	})
	t.Cleanup(srv.Close)

	httpSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(httpSrv.Close)

	// Create session.
	createReqBody := bytes.NewBufferString(`{"cols":80,"rows":24}`)
	resp, err := http.Post(httpSrv.URL+"/api/sessions", "application/json", createReqBody)
	if err != nil {
		t.Fatalf("create session request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected create status: %d", resp.StatusCode)
	}

	var created apiSessionInfo
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode create response failed: %v", err)
	}
	if created.ID == "" {
		t.Fatalf("expected non-empty session id")
	}

	// Subscribe websocket for output events.
	wsURL := "ws" + httpSrv.URL[len("http"):] + "/ws?sessionId=" + created.ID
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsConn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket dial failed: %v", err)
	}
	defer wsConn.Close(websocket.StatusNormalClosure, "done")

	// Attach connection (enables better resize coordination).
	attachBody := bytes.NewBufferString(`{"connId":"c1","cols":80,"rows":24}`)
	attachResp, err := http.Post(httpSrv.URL+"/api/sessions/"+created.ID+"/attach", "application/json", attachBody)
	if err != nil {
		t.Fatalf("attach failed: %v", err)
	}
	attachResp.Body.Close()
	if attachResp.StatusCode != http.StatusNoContent {
		t.Fatalf("unexpected attach status: %d", attachResp.StatusCode)
	}

	// Send input which cat will echo back.
	inputBody := bytes.NewBufferString(`{"connId":"c1","input":"hello\\n"}`)
	inputResp, err := http.Post(httpSrv.URL+"/api/sessions/"+created.ID+"/input", "application/json", inputBody)
	if err != nil {
		t.Fatalf("send input failed: %v", err)
	}
	inputResp.Body.Close()
	if inputResp.StatusCode != http.StatusNoContent {
		t.Fatalf("unexpected input status: %d", inputResp.StatusCode)
	}

	// Expect at least one data event containing "hello".
	for {
		_, msg, err := wsConn.Read(ctx)
		if err != nil {
			t.Fatalf("websocket read failed: %v", err)
		}

		var evt wsEvent
		if err := json.Unmarshal(msg, &evt); err != nil {
			t.Fatalf("invalid websocket json: %v", err)
		}
		if evt.Type != "data" {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(evt.DataBase64)
		if err != nil {
			t.Fatalf("decode data failed: %v", err)
		}
		if bytes.Contains(data, []byte("hello")) {
			return
		}
	}
}

func TestServer_WebsocketDisconnectRemovesConnection(t *testing.T) {
	logger := &recordingLogger{}
	srv := New(Config{
		ManagerConfig: terminal.ManagerConfig{
			Logger:                        logger,
			ShellResolver:                 fixedShellResolver{shell: "/bin/sh"},
			ShellArgsProvider:             fixedShellArgsProvider{args: []string{"-c", "cat"}},
			InitialResizeSuppressDuration: time.Millisecond,
			ResizeSuppressDuration:        time.Millisecond,
		},
	})
	t.Cleanup(srv.Close)

	httpSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(httpSrv.Close)

	createReqBody := bytes.NewBufferString(`{"cols":80,"rows":24}`)
	resp, err := http.Post(httpSrv.URL+"/api/sessions", "application/json", createReqBody)
	if err != nil {
		t.Fatalf("create session request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected create status: %d", resp.StatusCode)
	}

	var created apiSessionInfo
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode create response failed: %v", err)
	}

	attachBody := bytes.NewBufferString(`{"connId":"c1","cols":80,"rows":24}`)
	attachResp, err := http.Post(httpSrv.URL+"/api/sessions/"+created.ID+"/attach", "application/json", attachBody)
	if err != nil {
		t.Fatalf("attach failed: %v", err)
	}
	attachResp.Body.Close()
	if attachResp.StatusCode != http.StatusNoContent {
		t.Fatalf("unexpected attach status: %d", attachResp.StatusCode)
	}

	wsURL := "ws" + httpSrv.URL[len("http"):] + "/ws?sessionId=" + created.ID + "&connId=c1"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsConn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket dial failed: %v", err)
	}
	_ = wsConn.Close(websocket.StatusNormalClosure, "done")

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if logger.hasKV("debug", "Removed connection", "connectionID", "c1") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected connection to be removed on websocket disconnect")
}

func TestServer_WebsocketDisconnectRefCount(t *testing.T) {
	logger := &recordingLogger{}
	srv := New(Config{
		ManagerConfig: terminal.ManagerConfig{
			Logger:                        logger,
			ShellResolver:                 fixedShellResolver{shell: "/bin/sh"},
			ShellArgsProvider:             fixedShellArgsProvider{args: []string{"-c", "cat"}},
			InitialResizeSuppressDuration: time.Millisecond,
			ResizeSuppressDuration:        time.Millisecond,
		},
	})
	t.Cleanup(srv.Close)

	httpSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(httpSrv.Close)

	createReqBody := bytes.NewBufferString(`{"cols":80,"rows":24}`)
	resp, err := http.Post(httpSrv.URL+"/api/sessions", "application/json", createReqBody)
	if err != nil {
		t.Fatalf("create session request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected create status: %d", resp.StatusCode)
	}

	var created apiSessionInfo
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode create response failed: %v", err)
	}

	attachBody := bytes.NewBufferString(`{"connId":"c1","cols":80,"rows":24}`)
	attachResp, err := http.Post(httpSrv.URL+"/api/sessions/"+created.ID+"/attach", "application/json", attachBody)
	if err != nil {
		t.Fatalf("attach failed: %v", err)
	}
	attachResp.Body.Close()
	if attachResp.StatusCode != http.StatusNoContent {
		t.Fatalf("unexpected attach status: %d", attachResp.StatusCode)
	}

	wsURL := "ws" + httpSrv.URL[len("http"):] + "/ws?sessionId=" + created.ID + "&connId=c1"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsConn1, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket dial failed: %v", err)
	}
	wsConn2, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket dial failed: %v", err)
	}

	_ = wsConn1.Close(websocket.StatusNormalClosure, "done")
	time.Sleep(50 * time.Millisecond)
	if logger.hasKV("debug", "Removed connection", "connectionID", "c1") {
		t.Fatalf("did not expect connection to be removed while another websocket is still connected")
	}

	_ = wsConn2.Close(websocket.StatusNormalClosure, "done")

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if logger.hasKV("debug", "Removed connection", "connectionID", "c1") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected connection to be removed after last websocket disconnect")
}
