package server

import (
	"context"
	"net/http"

	"github.com/coder/websocket"
)

type wsClient struct {
	conn      *websocket.Conn
	sessionID string
	send      chan []byte
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

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("sessionId")
	if sessionID == "" {
		http.Error(w, "missing sessionId", http.StatusBadRequest)
		return
	}

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "closed")

	client := &wsClient{
		conn:      conn,
		sessionID: sessionID,
		send:      make(chan []byte, 64),
	}

	s.registerWS(client)
	defer s.unregisterWS(client)

	ctx := r.Context()
	go client.writeLoop(ctx)

	// We don't expect client -> server messages; just read to detect close.
	for {
		_, _, err := conn.Read(ctx)
		if err != nil {
			return
		}
	}
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

func (s *Server) registerWS(client *wsClient) {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()

	set := s.wsBySession[client.sessionID]
	if set == nil {
		set = make(map[*wsClient]struct{})
		s.wsBySession[client.sessionID] = set
	}
	set[client] = struct{}{}
}

func (s *Server) unregisterWS(client *wsClient) {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()

	set := s.wsBySession[client.sessionID]
	if set == nil {
		return
	}
	delete(set, client)
	if len(set) == 0 {
		delete(s.wsBySession, client.sessionID)
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
		select {
		case client.send <- payload:
		default:
			// Slow consumer: best-effort close. The read loop will exit and cleanup will unregister.
			_ = client.conn.Close(websocket.StatusPolicyViolation, "slow consumer")
		}
	}
}
