//go:build floeterm_native

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	terminal "github.com/floegence/floeterm/terminal-go"
	"github.com/floegence/floeterm/terminal-go/livev1"
)

func TestRealSessionExposesSemanticPresentationAfterPTYOutput(t *testing.T) {
	srv, httpSrv := newTestServer(t)
	created := createTestSession(t, httpSrv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection := attachLive(t, ctx, httpSrv.URL, created.ID, "semantic-http")
	session, ok := srv.manager.GetSession(created.ID)
	if !ok {
		t.Fatal("session disappeared")
	}
	waitForInitialPresentation(t, ctx, session)
	input, _ := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("printf 'semantic界'\r")})
	if err := connection.conn.Write(ctx, websocket.MessageBinary, input); err != nil {
		t.Fatal(err)
	}
	_ = waitPresentationContaining(t, ctx, connection, []byte("semantic"))
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get(httpSrv.URL + "/api/sessions/" + created.ID + "/presentation")
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode == http.StatusOK {
			var wire map[string]json.RawMessage
			err = json.NewDecoder(response.Body).Decode(&wire)
			response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"sequence", "geometry", "state", "frame"} {
				if _, ok := wire[key]; !ok {
					t.Fatalf("presentation JSON lacks camelCase %q: keys=%v", key, wire)
				}
			}
			var p terminal.SemanticPresentation
			encoded, _ := json.Marshal(wire)
			if err := json.Unmarshal(encoded, &p); err != nil {
				t.Fatal(err)
			}
			var text strings.Builder
			for _, row := range p.Frame.Rows {
				for _, cell := range row.Cells {
					text.WriteString(cell.Text)
				}
			}
			if strings.Contains(text.String(), "semantic界") {
				return
			}
		} else {
			response.Body.Close()
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("semantic presentation never contained PTY output")
}
