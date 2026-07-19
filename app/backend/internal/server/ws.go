package server

import (
	"net/http"

	"github.com/coder/websocket"
)

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(8 * 1024 * 1024)
	stream := websocket.NetConn(r.Context(), conn, websocket.MessageBinary)
	if err := s.live.Serve(r.Context(), stream); err != nil {
		s.logger.Debug("terminal live websocket closed", "error", err)
	}
}
