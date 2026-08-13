//go:build floeterm_native

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	terminal "github.com/floegence/floeterm/terminal-go"
	"github.com/floegence/floeterm/terminal-go/livev1"
)

func TestRealSessionExposesSemanticPresentationAfterPTYOutput(t *testing.T) {
	_, httpSrv := newTestServer(t)
	created := createTestSession(t, httpSrv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection := attachLiveTestConnection(t, ctx, httpSrv.URL, created.ID, "semantic-http")
	defer connection.Close(1000, "done")
	input, _ := livev1.EncodeInput(livev1.Input{Sequence: 1, Data: []byte("semantic界\n")})
	if err := connection.Write(ctx, 2, input); err != nil {
		t.Fatal(err)
	}
	_ = readOutputContaining(t, ctx, connection, []byte("semantic"))
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
