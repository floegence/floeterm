package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type wsClient struct {
	conn      *websocket.Conn
	sessionID string
	connID    string
	send      chan []byte
	sendMu    sync.Mutex
}

type wsEvent struct {
	Type           string `json:"type"`
	SessionID      string `json:"sessionId"`
	DataBase64     string `json:"data,omitempty"`
	Sequence       int64  `json:"sequence,omitempty"`
	TimestampMs    int64  `json:"timestampMs,omitempty"`
	EchoOfInput    bool   `json:"echoOfInput,omitempty"`
	OriginalSource string `json:"originalSource,omitempty"`
	NewName        string `json:"newName,omitempty"`
	WorkingDir     string `json:"workingDir,omitempty"`
	Error          string `json:"error,omitempty"`
}

const wsConnectionRemovalGrace = 100 * time.Millisecond

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("sessionId")
	if sessionID == "" {
		http.Error(w, "missing sessionId", http.StatusBadRequest)
		return
	}
	connID := r.URL.Query().Get("connId")
	lastSeq := parseLastSeq(r.URL.Query().Get("lastSeq"))

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "closed")

	client := &wsClient{
		conn:      conn,
		sessionID: sessionID,
		connID:    connID,
		send:      make(chan []byte, 4096),
	}

	client.sendMu.Lock()
	s.registerWS(client)
	defer s.unregisterWS(client)

	ctx := r.Context()
	go client.writeLoop(ctx)
	s.replayHistoryToWSClient(client, lastSeq)
	client.sendMu.Unlock()

	// We don't expect client -> server messages; just read to detect close.
	for {
		_, _, err := conn.Read(ctx)
		if err != nil {
			return
		}
	}
}

func parseLastSeq(raw string) int64 {
	if strings.TrimSpace(raw) == "" {
		return 0
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 0
	}
	return value
}

func (c *wsClient) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			if err := c.conn.Write(ctx, websocket.MessageText, msg); err != nil {
				return
			}
		}
	}
}

func (c *wsClient) enqueue(payload []byte) bool {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	select {
	case c.send <- payload:
		return true
	default:
		_ = c.conn.Close(websocket.StatusPolicyViolation, "slow consumer")
		return false
	}
}

func (s *Server) replayHistoryToWSClient(client *wsClient, lastSeq int64) {
	session, ok := s.manager.GetSession(client.sessionID)
	if !ok {
		payload, err := json.Marshal(wsEvent{
			Type:        "error",
			SessionID:   client.sessionID,
			Error:       "session not found",
			TimestampMs: time.Now().UnixMilli(),
		})
		if err == nil {
			select {
			case client.send <- payload:
			default:
			}
		}
		return
	}

	chunks, err := session.GetHistoryFromSequence(lastSeq + 1)
	if err != nil {
		payload, marshalErr := json.Marshal(wsEvent{
			Type:        "error",
			SessionID:   client.sessionID,
			Error:       err.Error(),
			TimestampMs: time.Now().UnixMilli(),
		})
		if marshalErr == nil {
			select {
			case client.send <- payload:
			default:
			}
		}
		return
	}

	replaySeq := lastSeq
	for _, chunk := range chunks {
		if chunk.Sequence <= lastSeq {
			continue
		}
		payload, err := json.Marshal(wsEvent{
			Type:        "data",
			SessionID:   client.sessionID,
			DataBase64:  base64.StdEncoding.EncodeToString(chunk.Data),
			Sequence:    chunk.Sequence,
			TimestampMs: chunk.Timestamp,
		})
		if err != nil {
			continue
		}
		if !client.enqueueReplayLocked(payload) {
			return
		}
		if chunk.Sequence > replaySeq {
			replaySeq = chunk.Sequence
		}
	}

	payload, err := json.Marshal(wsEvent{
		Type:        "replay-complete",
		SessionID:   client.sessionID,
		Sequence:    replaySeq,
		TimestampMs: time.Now().UnixMilli(),
	})
	if err == nil {
		_ = client.enqueueReplayLocked(payload)
	}
}

func (c *wsClient) enqueueReplayLocked(payload []byte) bool {
	select {
	case c.send <- payload:
		return true
	default:
		_ = c.conn.Close(websocket.StatusPolicyViolation, "slow consumer")
		return false
	}
}

func (s *Server) registerWS(client *wsClient) {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()

	if client.connID != "" {
		sessionRefs := s.wsConnRefs[client.sessionID]
		if sessionRefs == nil {
			sessionRefs = make(map[string]int)
			s.wsConnRefs[client.sessionID] = sessionRefs
		}
		sessionRefs[client.connID]++
	}

	set := s.wsBySession[client.sessionID]
	if set == nil {
		set = make(map[*wsClient]struct{})
		s.wsBySession[client.sessionID] = set
	}
	set[client] = struct{}{}
}

func (s *Server) unregisterWS(client *wsClient) {
	var shouldRemoveConn bool

	s.wsMu.Lock()
	if client.connID != "" {
		sessionRefs := s.wsConnRefs[client.sessionID]
		if sessionRefs != nil {
			if sessionRefs[client.connID] <= 1 {
				delete(sessionRefs, client.connID)
				shouldRemoveConn = true
			} else {
				sessionRefs[client.connID]--
			}
			if len(sessionRefs) == 0 {
				delete(s.wsConnRefs, client.sessionID)
			}
		}
	}

	set := s.wsBySession[client.sessionID]
	if set == nil {
		s.wsMu.Unlock()
		if shouldRemoveConn {
			s.removeTerminalConnectionAfterGrace(client.sessionID, client.connID)
		}
		return
	}
	delete(set, client)
	if len(set) == 0 {
		delete(s.wsBySession, client.sessionID)
	}
	s.wsMu.Unlock()

	if shouldRemoveConn {
		s.removeTerminalConnectionAfterGrace(client.sessionID, client.connID)
	}
}

func (s *Server) broadcast(sessionID string, payload []byte) {
	s.wsMu.RLock()
	set := s.wsBySession[sessionID]
	if len(set) == 0 {
		s.wsMu.RUnlock()
		return
	}

	clients := make([]*wsClient, 0, len(set))
	for client := range set {
		clients = append(clients, client)
	}
	s.wsMu.RUnlock()

	for _, client := range clients {
		client.enqueue(payload)
	}
}

func (s *Server) removeTerminalConnection(sessionID, connID string) {
	if strings.TrimSpace(connID) == "" {
		return
	}
	session, ok := s.manager.GetSession(sessionID)
	if !ok {
		return
	}
	session.RemoveConnection(connID)
}

func (s *Server) removeTerminalConnectionAfterGrace(sessionID, connID string) {
	if strings.TrimSpace(connID) == "" {
		return
	}

	time.AfterFunc(wsConnectionRemovalGrace, func() {
		s.wsMu.RLock()
		sessionRefs := s.wsConnRefs[sessionID]
		stillReferenced := sessionRefs != nil && sessionRefs[connID] > 0
		s.wsMu.RUnlock()

		if stillReferenced {
			return
		}
		s.removeTerminalConnection(sessionID, connID)
	})
}
