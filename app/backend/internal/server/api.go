package server

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	terminal "github.com/floegence/floeterm/terminal-go"
)

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
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
}

type renameSessionRequest struct {
	NewName string `json:"newName"`
}

type attachRequest struct {
	ConnID string `json:"connId"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
}

type inputRequest struct {
	ConnID string `json:"connId"`
	Input  string `json:"input"`
}

type historyChunk struct {
	Sequence    int64  `json:"sequence"`
	DataBase64  string `json:"data"`
	TimestampMs int64  `json:"timestampMs"`
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
			if err := readJSON(r, &req); err != nil && !errors.Is(err, io.EOF) {
				http.Error(w, "invalid payload", http.StatusBadRequest)
				return
			}
		}

		cols := req.Cols
		rows := req.Rows
		if cols <= 0 {
			cols = 80
		}
		if rows <= 0 {
			rows = 24
		}

		session, err := s.manager.CreateSession(req.Name, req.WorkingDir, cols, rows)
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
		if err := readJSON(r, &req); err != nil || strings.TrimSpace(req.NewName) == "" {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		if err := s.manager.RenameSession(sessionID, req.NewName); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return

	case "attach":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req attachRequest
		if err := readJSON(r, &req); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(req.ConnID) == "" {
			http.Error(w, "connId is required", http.StatusBadRequest)
			return
		}
		cols, rows := req.Cols, req.Rows
		if cols <= 0 {
			cols = 80
		}
		if rows <= 0 {
			rows = 24
		}

		session, ok := s.manager.GetSession(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		if !session.IsActive() {
			if err := s.manager.ActivateSession(sessionID, cols, rows); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}

		session.AddConnection(req.ConnID, cols, rows)
		w.WriteHeader(http.StatusNoContent)
		return

	case "resize":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req attachRequest
		if err := readJSON(r, &req); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		if req.Cols <= 0 || req.Rows <= 0 {
			http.Error(w, "invalid cols/rows", http.StatusBadRequest)
			return
		}

		session, ok := s.manager.GetSession(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		if strings.TrimSpace(req.ConnID) != "" {
			session.UpdateConnectionSize(req.ConnID, req.Cols, req.Rows)
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if err := session.ResizePTY(req.Cols, req.Rows); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return

	case "input":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req inputRequest
		if err := readJSON(r, &req); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}

		session, ok := s.manager.GetSession(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		if err := session.WriteDataWithSource([]byte(req.Input), req.ConnID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
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

		session, ok := s.manager.GetSession(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		chunks, err := session.GetHistoryFromSequence(startSeq)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		out := make([]historyChunk, 0, len(chunks))
		for _, chunk := range chunks {
			if endSeq > 0 && chunk.Sequence > endSeq {
				break
			}
			out = append(out, historyChunk{
				Sequence:    chunk.Sequence,
				DataBase64:  base64.StdEncoding.EncodeToString(chunk.Data),
				TimestampMs: chunk.Timestamp,
			})
		}

		writeJSON(w, http.StatusOK, out)
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
