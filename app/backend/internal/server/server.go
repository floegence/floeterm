package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	terminal "github.com/floegence/floeterm/terminal-go"
	"github.com/floegence/floeterm/terminal-go/livev1"
)

type Config struct {
	// StaticDir is the directory that contains the built web assets (index.html, JS, CSS).
	// When empty, the server only exposes APIs.
	StaticDir string

	// ManagerConfig is forwarded to terminal-go.
	ManagerConfig terminal.ManagerConfig

	// EnablePerformanceDiagnostics exposes process-local metrics for controlled test runs.
	EnablePerformanceDiagnostics bool
}

// Server is a runnable HTTP/WebSocket server that bridges terminal-go sessions to terminal-web clients.
type Server struct {
	manager *terminal.Manager

	staticDir              string
	logger                 terminal.Logger
	live                   *livev1.Service
	performanceDiagnostics bool
}

func New(cfg Config) *Server {
	logger := cfg.ManagerConfig.Logger
	if logger == nil {
		logger = terminal.NopLogger{}
	}

	manager := terminal.NewManager(cfg.ManagerConfig)
	s := &Server{
		manager:                manager,
		staticDir:              cfg.StaticDir,
		logger:                 logger,
		live:                   livev1.NewService(livev1.NewManagerBackend(manager, livev1.ManagerBackendOptions{})),
		performanceDiagnostics: cfg.EnablePerformanceDiagnostics,
	}
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/sessions", s.handleSessions)
	mux.HandleFunc("/api/sessions/", s.handleSessionByID)
	mux.HandleFunc("/ws", s.handleWS)
	if s.performanceDiagnostics {
		mux.HandleFunc("/api/performance/runtime", s.handlePerformanceRuntime)
		mux.HandleFunc("/api/performance/goroutines", s.handlePerformanceGoroutines)
	}

	if strings.TrimSpace(s.staticDir) != "" {
		mux.Handle("/", spaFileServer(s.staticDir))
	}

	return mux
}

func (s *Server) Close() {
	s.manager.Cleanup()
}

// --- API helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64) error {
	if maxBytes > 0 {
		r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	err := dec.Decode(dst)
	if err == nil {
		return nil
	}

	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return &httpError{status: http.StatusRequestEntityTooLarge, message: "payload too large"}
	}
	return err
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

type httpError struct {
	status  int
	message string
}

func (e *httpError) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}
