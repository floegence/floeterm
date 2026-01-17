package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	terminal "github.com/floegence/floeterm/terminal-go"
)

type Config struct {
	// StaticDir is the directory that contains the built web assets (index.html, JS, CSS).
	// When empty, the server only exposes APIs.
	StaticDir string

	// ManagerConfig is forwarded to terminal-go.
	ManagerConfig terminal.ManagerConfig
}

// Server is a runnable HTTP/WebSocket server that bridges terminal-go sessions to terminal-web clients.
type Server struct {
	manager *terminal.Manager

	staticDir string
	logger    terminal.Logger

	wsMu        sync.RWMutex
	wsBySession map[string]map[*wsClient]struct{}
}

func New(cfg Config) *Server {
	logger := cfg.ManagerConfig.Logger
	if logger == nil {
		logger = terminal.NopLogger{}
	}

	s := &Server{
		manager:     terminal.NewManager(cfg.ManagerConfig),
		staticDir:   cfg.StaticDir,
		logger:      logger,
		wsBySession: make(map[string]map[*wsClient]struct{}),
	}
	s.manager.SetEventHandler(s)
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/sessions", s.handleSessions)
	mux.HandleFunc("/api/sessions/", s.handleSessionByID)
	mux.HandleFunc("/ws", s.handleWS)

	if strings.TrimSpace(s.staticDir) != "" {
		mux.Handle("/", spaFileServer(s.staticDir))
	}

	return mux
}

func (s *Server) Close() {
	s.manager.Cleanup()

	s.wsMu.Lock()
	clients := s.wsBySession
	s.wsBySession = make(map[string]map[*wsClient]struct{})
	s.wsMu.Unlock()

	for _, set := range clients {
		for client := range set {
			_ = client.conn.Close(websocket.StatusNormalClosure, "server shutting down")
		}
	}
}

// --- terminal.TerminalEventHandler implementation ---

func (s *Server) OnTerminalData(sessionID string, data []byte, sequenceNumber int64, isEcho bool, originalSource string) {
	payload, err := json.Marshal(wsEvent{
		Type:           "data",
		SessionID:      sessionID,
		DataBase64:     base64.StdEncoding.EncodeToString(data),
		Sequence:       sequenceNumber,
		TimestampMs:    time.Now().UnixMilli(),
		EchoOfInput:    isEcho,
		OriginalSource: originalSource,
	})
	if err != nil {
		return
	}
	s.broadcast(sessionID, payload)
}

func (s *Server) OnTerminalNameChanged(sessionID string, _ string, newName string, workingDir string) {
	payload, err := json.Marshal(wsEvent{
		Type:        "name",
		SessionID:   sessionID,
		NewName:     newName,
		WorkingDir:  workingDir,
		TimestampMs: time.Now().UnixMilli(),
	})
	if err != nil {
		return
	}
	s.broadcast(sessionID, payload)
}

func (s *Server) OnTerminalSessionCreated(*terminal.Session) {}

func (s *Server) OnTerminalSessionClosed(sessionID string) {
	// Drop all websocket clients for this session so the web UI doesn't keep reconnecting.
	s.wsMu.Lock()
	clients := s.wsBySession[sessionID]
	delete(s.wsBySession, sessionID)
	s.wsMu.Unlock()

	for client := range clients {
		_ = client.conn.Close(websocket.StatusNormalClosure, "session closed")
	}
}

func (s *Server) OnTerminalError(sessionID string, err error) {
	payload, marshalErr := json.Marshal(wsEvent{
		Type:        "error",
		SessionID:   sessionID,
		Error:       err.Error(),
		TimestampMs: time.Now().UnixMilli(),
	})
	if marshalErr != nil {
		return
	}
	s.broadcast(sessionID, payload)
}

// --- API helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}

func parseIntQuery(q map[string][]string, key string, def int64) (int64, error) {
	val := ""
	if raw := q[key]; len(raw) > 0 {
		val = raw[0]
	}
	if strings.TrimSpace(val) == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(val, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid %s", key)
	}
	return n, nil
}
