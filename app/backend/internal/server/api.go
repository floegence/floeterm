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

type historyChunk struct {
	Sequence           int64  `json:"sequence"`
	DataBase64         string `json:"data"`
	TimestampMs        int64  `json:"timestampMs"`
	GeometryGeneration uint64 `json:"geometryGeneration"`
	Cols               int    `json:"cols"`
	Rows               int    `json:"rows"`
}

type historyPageResponse struct {
	Chunks                 []historyChunk             `json:"chunks"`
	Checkpoint             *historyCheckpointResponse `json:"checkpoint,omitempty"`
	DeltaStartSequence     int64                      `json:"deltaStartSequence"`
	FirstRetainedSequence  int64                      `json:"firstRetainedSequence"`
	NextStartSequence      int64                      `json:"nextStartSequence"`
	HasMore                bool                       `json:"hasMore"`
	CoveredThroughSequence int64                      `json:"coveredThroughSequence"`
	SnapshotEndSequence    int64                      `json:"snapshotEndSequence"`
	HistoryGeneration      int64                      `json:"historyGeneration"`
	HistoryReset           bool                       `json:"historyReset"`
	HistoryTruncated       bool                       `json:"historyTruncated"`
	TotalBytes             int64                      `json:"totalBytes"`
}

type historyCheckpointResponse struct {
	FormatVersion          uint32 `json:"formatVersion"`
	EngineID               string `json:"engineId"`
	CoveredThroughSequence int64  `json:"coveredThroughSequence"`
	GeometryGeneration     uint64 `json:"geometryGeneration"`
	ParserEpoch            uint64 `json:"parserEpoch"`
	Cols                   int    `json:"cols"`
	Rows                   int    `json:"rows"`
	ChecksumSHA256         string `json:"checksumSha256"`
	StateDigestSHA256      string `json:"stateDigestSha256"`
	BytesBase64            string `json:"bytes"`
}

type historyCheckpointRequest struct {
	FormatVersion          uint32 `json:"formatVersion"`
	EngineID               string `json:"engineId"`
	CoveredThroughSequence int64  `json:"coveredThroughSequence"`
	GeometryGeneration     uint64 `json:"geometryGeneration"`
	ParserEpoch            uint64 `json:"parserEpoch"`
	Cols                   int    `json:"cols"`
	Rows                   int    `json:"rows"`
	ChecksumSHA256         string `json:"checksumSha256"`
	StateDigestSHA256      string `json:"stateDigestSha256"`
	BytesBase64            string `json:"bytes"`
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
				Sequence:           chunk.Sequence,
				DataBase64:         base64.StdEncoding.EncodeToString(chunk.Data),
				TimestampMs:        chunk.Timestamp,
				GeometryGeneration: chunk.GeometryGeneration,
				Cols:               chunk.Cols,
				Rows:               chunk.Rows,
			})
		}

		var checkpoint *historyCheckpointResponse
		if page.Checkpoint != nil {
			checkpoint = &historyCheckpointResponse{
				FormatVersion:          page.Checkpoint.FormatVersion,
				EngineID:               page.Checkpoint.EngineID,
				CoveredThroughSequence: page.Checkpoint.CoveredThroughSequence,
				GeometryGeneration:     page.Checkpoint.GeometryGeneration,
				ParserEpoch:            page.Checkpoint.ParserEpoch,
				Cols:                   page.Checkpoint.Cols,
				Rows:                   page.Checkpoint.Rows,
				ChecksumSHA256:         page.Checkpoint.ChecksumSHA256,
				StateDigestSHA256:      page.Checkpoint.StateDigestSHA256,
				BytesBase64:            base64.StdEncoding.EncodeToString(page.Checkpoint.Bytes),
			}
		}

		writeJSON(w, http.StatusOK, historyPageResponse{
			Chunks:                 out,
			Checkpoint:             checkpoint,
			DeltaStartSequence:     page.DeltaStartSequence,
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

	case "checkpoint":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req historyCheckpointRequest
		if err := readJSON(w, r, &req, maxCheckpointJSONBodyBytes); err != nil {
			var httpErr *httpError
			if errors.As(err, &httpErr) {
				http.Error(w, httpErr.message, httpErr.status)
				return
			}
			http.Error(w, "invalid checkpoint payload", http.StatusBadRequest)
			return
		}
		checkpointBytes, err := base64.StdEncoding.Strict().DecodeString(req.BytesBase64)
		if err != nil || len(checkpointBytes) == 0 {
			http.Error(w, "invalid checkpoint bytes", http.StatusBadRequest)
			return
		}
		if len(checkpointBytes) > maxCheckpointBytes {
			http.Error(w, "checkpoint bytes exceed limit", http.StatusRequestEntityTooLarge)
			return
		}
		checkpoint := terminal.TerminalHistoryCheckpoint{
			FormatVersion:          req.FormatVersion,
			EngineID:               req.EngineID,
			CoveredThroughSequence: req.CoveredThroughSequence,
			GeometryGeneration:     req.GeometryGeneration,
			ParserEpoch:            req.ParserEpoch,
			Cols:                   req.Cols,
			Rows:                   req.Rows,
			ChecksumSHA256:         req.ChecksumSHA256,
			StateDigestSHA256:      req.StateDigestSHA256,
			Bytes:                  checkpointBytes,
		}
		if err := s.manager.CommitSessionHistoryCheckpoint(sessionID, checkpoint); err != nil {
			if strings.Contains(err.Error(), "session not found") {
				http.Error(w, "session not found", http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
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
