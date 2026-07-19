package server

import (
	"bytes"
	"encoding/base64"
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
	ID             string `json:"id"`
	Name           string `json:"name"`
	WorkingDir     string `json:"workingDir"`
	CreatedAtMs    int64  `json:"createdAtMs"`
	LastActiveAtMs int64  `json:"lastActiveAtMs"`
	IsActive       bool   `json:"isActive"`
}

type createSessionRequest struct {
	Name       string `json:"name"`
	WorkingDir string `json:"workingDir"`
}

type renameSessionRequest struct {
	NewName string `json:"newName"`
}

type historyChunk struct {
	Sequence    int64  `json:"sequence"`
	DataBase64  string `json:"data"`
	TimestampMs int64  `json:"timestampMs"`
}

type historyPageResponse struct {
	Chunks                 []historyChunk `json:"chunks"`
	FirstRetainedSequence  int64          `json:"firstRetainedSequence"`
	NextStartSequence      int64          `json:"nextStartSequence"`
	HasMore                bool           `json:"hasMore"`
	CoveredThroughSequence int64          `json:"coveredThroughSequence"`
	SnapshotEndSequence    int64          `json:"snapshotEndSequence"`
	HistoryGeneration      int64          `json:"historyGeneration"`
	HistoryReset           bool           `json:"historyReset"`
	HistoryTruncated       bool           `json:"historyTruncated"`
	TotalBytes             int64          `json:"totalBytes"`
}

type sessionStatsResponse struct {
	History historyStats `json:"history"`
}

type historyStats struct {
	TotalBytes int64 `json:"totalBytes"`
}

func toAPISessionInfo(info terminal.TerminalSessionInfo) apiSessionInfo {
	return apiSessionInfo{
		ID:             info.ID,
		Name:           info.Name,
		WorkingDir:     info.WorkingDir,
		CreatedAtMs:    info.CreatedAt,
		LastActiveAtMs: info.LastActive,
		IsActive:       info.IsActive,
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

	case "history":
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		startSeq, err := parseIntQuery(r.URL.Query(), "startSeq", 0)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		endSeq, err := parseIntQuery(r.URL.Query(), "endSeq", -1)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		historyGeneration, err := parseIntQuery(r.URL.Query(), "historyGeneration", 0)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		maxBytes, err := parseIntQuery(r.URL.Query(), "maxBytes", defaultHistoryPageBytes)
		if err != nil || maxBytes <= 0 || maxBytes > maxHistoryPageBytes {
			http.Error(w, "invalid maxBytes", http.StatusBadRequest)
			return
		}

		session, ok := s.manager.GetSession(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		page, err := session.GetHistoryPage(terminal.HistoryPageOptions{
			StartSeq:          startSeq,
			EndSeq:            endSeq,
			HistoryGeneration: historyGeneration,
			LimitChunks:       maxHistoryPageChunks,
			MaxBytes:          int(maxBytes),
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		out := make([]historyChunk, 0, len(page.Chunks))
		for _, chunk := range page.Chunks {
			out = append(out, historyChunk{
				Sequence:    chunk.Sequence,
				DataBase64:  base64.StdEncoding.EncodeToString(chunk.Data),
				TimestampMs: chunk.Timestamp,
			})
		}

		writeJSON(w, http.StatusOK, historyPageResponse{
			Chunks:                 out,
			FirstRetainedSequence:  page.FirstRetainedSequence,
			NextStartSequence:      page.NextStartSeq,
			HasMore:                page.HasMore,
			CoveredThroughSequence: page.CoveredThroughSequence,
			SnapshotEndSequence:    page.SnapshotEndSequence,
			HistoryGeneration:      page.HistoryGeneration,
			HistoryReset:           page.HistoryReset,
			HistoryTruncated:       page.HistoryTruncated,
			TotalBytes:             page.TotalBytes,
		})
		return

	case "stats":
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		session, ok := s.manager.GetSession(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		stats, err := session.GetHistoryStats()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusOK, sessionStatsResponse{
			History: historyStats{
				TotalBytes: stats.TotalBytes,
			},
		})
		return

	case "clear":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := s.manager.ClearSessionHistory(sessionID); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return

	default:
		http.Error(w, fmt.Sprintf("unknown action: %s", action), http.StatusNotFound)
		return
	}
}
