package server

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"runtime/pprof"
	"strings"

	terminal "github.com/floegence/floeterm/terminal-go"
)

type performanceRuntimeResponse struct {
	Goroutines          int    `json:"goroutines"`
	HeapBytes           uint64 `json:"heap_bytes"`
	SessionCount        int    `json:"session_count"`
	ActiveSessionCount  int    `json:"active_session_count"`
	ConnectionCount     int    `json:"connection_count"`
	LiveAttachmentCount int    `json:"live_attachment_count"`
}

type apiSessionInfo struct {
	ID                string                   `json:"id"`
	Name              string                   `json:"name"`
	WorkingDir        string                   `json:"workingDir"`
	CreatedAtMs       int64                    `json:"createdAtMs"`
	LastActiveAtMs    int64                    `json:"lastActiveAtMs"`
	IsActive          bool                     `json:"isActive"`
	ForegroundCommand apiForegroundCommandInfo `json:"foregroundCommand"`
	OutputActivity    apiOutputActivityInfo    `json:"outputActivity"`
	ExecutionContext  apiExecutionContextInfo  `json:"executionContext"`
	WorkState         apiWorkStateInfo         `json:"workState"`
}

type apiForegroundCommandInfo struct {
	Phase       string `json:"phase"`
	DisplayName string `json:"displayName"`
	Revision    uint64 `json:"revision"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

type apiOutputActivityInfo struct {
	Phase       string `json:"phase"`
	Revision    uint64 `json:"revision"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

type apiExecutionContextInfo struct {
	Location    apiTerminalLocationInfo    `json:"location"`
	Application apiTerminalApplicationInfo `json:"application"`
	Revision    uint64                     `json:"revision"`
	UpdatedAtMs int64                      `json:"updatedAtMs"`
}

type apiTerminalLocationInfo struct {
	Kind             string `json:"kind"`
	Phase            string `json:"phase"`
	Label            string `json:"label"`
	Authority        string `json:"authority"`
	WorkingDirectory string `json:"workingDirectory"`
	Source           string `json:"source"`
}

type apiTerminalApplicationInfo struct {
	Kind        string `json:"kind"`
	Identity    string `json:"identity"`
	DisplayName string `json:"displayName"`
}

type apiWorkStateInfo struct {
	Phase                     string `json:"phase"`
	Source                    string `json:"source"`
	ContextRevision           uint64 `json:"contextRevision"`
	ForegroundCommandRevision uint64 `json:"foregroundCommandRevision"`
	Revision                  uint64 `json:"revision"`
	UpdatedAtMs               int64  `json:"updatedAtMs"`
}

type createSessionRequest struct {
	Name       string `json:"name"`
	WorkingDir string `json:"workingDir"`
}

type renameSessionRequest struct {
	NewName string `json:"newName"`
}

type semanticHistoryRequest struct {
	ConnectionID        string                            `json:"connectionId"`
	TransportGeneration uint64                            `json:"transportGeneration"`
	Continuation        string                            `json:"continuation,omitempty"`
	Anchor              string                            `json:"anchor,omitempty"`
	Direction           terminal.SemanticHistoryDirection `json:"direction,omitempty"`
	Offset              int                               `json:"offset,omitempty"`
	ScrollDeltaRows     int                               `json:"scrollDeltaRows,omitempty"`
	ViewportRows        int                               `json:"viewportRows,omitempty"`
}

type semanticClearRequest struct {
	ConnectionID        string `json:"connectionId"`
	TransportGeneration uint64 `json:"transportGeneration"`
}

type semanticClearResponse struct {
	PresentationSequence uint64 `json:"presentationSequence"`
	ContentEpoch         uint64 `json:"contentEpoch"`
}

func toAPISessionInfo(info terminal.TerminalSessionInfo) apiSessionInfo {
	return apiSessionInfo{
		ID:             info.ID,
		Name:           info.Name,
		WorkingDir:     info.WorkingDir,
		CreatedAtMs:    info.CreatedAt,
		LastActiveAtMs: info.LastActive,
		IsActive:       info.IsActive,
		ForegroundCommand: apiForegroundCommandInfo{
			Phase:       string(info.ForegroundCommand.Phase),
			DisplayName: info.ForegroundCommand.DisplayName,
			Revision:    info.ForegroundCommand.Revision,
			UpdatedAtMs: info.ForegroundCommand.UpdatedAt,
		},
		OutputActivity: apiOutputActivityInfo{
			Phase:       string(info.OutputActivity.Phase),
			Revision:    info.OutputActivity.Revision,
			UpdatedAtMs: info.OutputActivity.UpdatedAt,
		},
		ExecutionContext: apiExecutionContextInfo{
			Location: apiTerminalLocationInfo{
				Kind:             string(info.ExecutionContext.Location.Kind),
				Phase:            string(info.ExecutionContext.Location.Phase),
				Label:            info.ExecutionContext.Location.Label,
				Authority:        info.ExecutionContext.Location.Authority,
				WorkingDirectory: info.ExecutionContext.Location.WorkingDirectory,
				Source:           string(info.ExecutionContext.Location.Source),
			},
			Application: apiTerminalApplicationInfo{
				Kind:        string(info.ExecutionContext.Application.Kind),
				Identity:    info.ExecutionContext.Application.Identity,
				DisplayName: info.ExecutionContext.Application.DisplayName,
			},
			Revision:    info.ExecutionContext.Revision,
			UpdatedAtMs: info.ExecutionContext.UpdatedAt,
		},
		WorkState: apiWorkStateInfo{
			Phase:                     string(info.WorkState.Phase),
			Source:                    info.WorkState.Source,
			ContextRevision:           info.WorkState.ContextRevision,
			ForegroundCommandRevision: info.WorkState.ForegroundCommandRevision,
			Revision:                  info.WorkState.Revision,
			UpdatedAtMs:               info.WorkState.UpdatedAt,
		},
	}
}

func (s *Server) handlePerformanceRuntime(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	diagnostics := s.manager.GetDiagnostics()
	w.Header().Set("Connection", "close")
	writeJSON(w, http.StatusOK, performanceRuntimeResponse{
		Goroutines:          runtime.NumGoroutine(),
		HeapBytes:           memory.HeapAlloc,
		SessionCount:        diagnostics.SessionCount,
		ActiveSessionCount:  diagnostics.ActiveSessionCount,
		ConnectionCount:     diagnostics.ConnectionCount,
		LiveAttachmentCount: diagnostics.LiveAttachmentCount,
	})
}

func (s *Server) handlePerformanceGoroutines(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	profile := pprof.Lookup("goroutine")
	if profile == nil {
		http.Error(w, "goroutine profile unavailable", http.StatusInternalServerError)
		return
	}
	var output bytes.Buffer
	if err := profile.WriteTo(&output, 2); err != nil {
		http.Error(w, "goroutine profile unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Connection", "close")
	_, _ = w.Write(output.Bytes())
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		sessions := s.manager.ListSessions()
		out := make([]apiSessionInfo, 0, len(sessions))
		for _, session := range sessions {
			out = append(out, toAPISessionInfo(session.ToSessionInfo()))
		}
		writeJSON(w, http.StatusOK, out)
		return

	case http.MethodPost:
		var req createSessionRequest
		if r.Body != nil {
			if err := readJSON(w, r, &req, maxJSONBodyBytesDefault); err != nil && !errors.Is(err, io.EOF) {
				var httpErr *httpError
				if errors.As(err, &httpErr) {
					http.Error(w, httpErr.message, httpErr.status)
					return
				}
				http.Error(w, "invalid payload", http.StatusBadRequest)
				return
			}
		}

		session, err := s.manager.CreateSession(req.Name, req.WorkingDir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusOK, toAPISessionInfo(session.ToSessionInfo()))
		return

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
}

func (s *Server) handleSessionByID(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		http.NotFound(w, r)
		return
	}

	parts := strings.Split(path, "/")
	sessionID := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	switch action {
	case "":
		if r.Method != http.MethodDelete {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := s.manager.DeleteSession(sessionID); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return

	case "rename":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req renameSessionRequest
		if err := readJSON(w, r, &req, maxJSONBodyBytesDefault); err != nil {
			var httpErr *httpError
			if errors.As(err, &httpErr) {
				http.Error(w, httpErr.message, httpErr.status)
				return
			}
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(req.NewName) == "" {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		if err := s.manager.RenameSession(sessionID, req.NewName); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return

	case "presentation":
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		session, ok := s.manager.GetSession(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		presentation, ok := session.LatestPresentation()
		if !ok {
			http.Error(w, "presentation not ready", http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, http.StatusOK, presentation)
		return

	case "semantic-history":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var request semanticHistoryRequest
		if err := readJSON(w, r, &request, maxJSONBodyBytesDefault); err != nil {
			http.Error(w, "invalid semantic history request", http.StatusBadRequest)
			return
		}
		session, ok := s.manager.GetSession(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		page, err := session.ReadSemanticHistory(request.ConnectionID, request.TransportGeneration, terminal.SemanticHistoryRequest{
			Continuation: request.Continuation, Anchor: request.Anchor, Direction: request.Direction,
			Offset: request.Offset, ScrollDeltaRows: request.ScrollDeltaRows, ViewportRows: request.ViewportRows,
		})
		if err != nil {
			status := http.StatusConflict
			if errors.Is(err, terminal.ErrControllerTransport) {
				status = http.StatusGone
			} else if !errors.Is(err, terminal.ErrSemanticHistoryAnchor) {
				status = http.StatusBadRequest
			}
			http.Error(w, err.Error(), status)
			return
		}
		writeJSON(w, http.StatusOK, page)
		return

	case "semantic-clear":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var request semanticClearRequest
		if err := readJSON(w, r, &request, maxJSONBodyBytesDefault); err != nil {
			http.Error(w, "invalid semantic clear request", http.StatusBadRequest)
			return
		}
		session, ok := s.manager.GetSession(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		presentation, err := session.ClearSemanticScreen(
			request.ConnectionID, "local", request.TransportGeneration,
		)
		if err != nil {
			status := http.StatusConflict
			switch {
			case errors.Is(err, terminal.ErrControllerTransport):
				status = http.StatusGone
			case errors.Is(err, terminal.ErrControllerPrincipal):
				status = http.StatusForbidden
			}
			http.Error(w, err.Error(), status)
			return
		}
		writeJSON(w, http.StatusOK, semanticClearResponse{
			PresentationSequence: presentation.Sequence,
			ContentEpoch:         presentation.State.ContentEpoch,
		})
		return

	default:
		http.Error(w, fmt.Sprintf("unknown action: %s", action), http.StatusNotFound)
		return
	}
}
