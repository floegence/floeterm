package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
