package terminal

import (
	"fmt"
	"time"

	"github.com/creack/pty"
)

// AddConnection registers a client connection with the session.
func (s *Session) AddConnection(connectionID string, cols, rows int) {
	if connectionID == "" {
		s.config.logger.Error("Cannot add connection with empty ID", "sessionID", s.ID)
		return
	}

	s.config.logger.Debug("Adding connection", "sessionID", s.ID, "connectionID", connectionID, "cols", cols, "rows", rows)

	s.mu.Lock()
	existing := s.connections[connectionID]

	s.connections[connectionID] = &ConnectionInfo{
		ConnID:   connectionID,
		JoinedAt: time.Now(),
		Cols:     cols,
		Rows:     rows,
	}
	s.mu.Unlock()

	if existing != nil {
		s.config.logger.Debug("Replacing existing connection", "sessionID", s.ID, "connectionID", connectionID, "oldJoinedAt", existing.JoinedAt)
	}

	go func() {
		if err := s.resizePTYToMinimumSize(); err != nil {
			s.config.logger.Warn("Failed to resize after adding connection", "sessionID", s.ID, "error", err)
		}
	}()
}

// RemoveConnection unregisters a client connection.
func (s *Session) RemoveConnection(connectionID string) {
	if connectionID == "" {
		return
	}

	s.config.logger.Debug("Removing connection", "sessionID", s.ID, "connectionID", connectionID)

	s.mu.Lock()
	conn, exists := s.connections[connectionID]
	if exists {
		delete(s.connections, connectionID)
	}
	s.mu.Unlock()

	if !exists {
		return
	}

	s.config.logger.Debug("Removed connection", "sessionID", s.ID, "connectionID", connectionID, "joinedAt", conn.JoinedAt)

	go func() {
		if err := s.resizePTYToMinimumSize(); err != nil {
			s.config.logger.Warn("Failed to resize after removing connection", "sessionID", s.ID, "error", err)
		}
	}()
}

// UpdateConnectionSize updates a connection's terminal size.
func (s *Session) UpdateConnectionSize(connectionID string, cols, rows int) {
	if connectionID == "" {
		return
	}

	s.config.logger.Debug("Updating connection size", "sessionID", s.ID, "connectionID", connectionID, "cols", cols, "rows", rows)

	s.mu.Lock()
	conn, exists := s.connections[connectionID]
	if exists {
		conn.Cols = cols
		conn.Rows = rows
	}
	s.mu.Unlock()

	if !exists {
		// This can happen if a resize arrives before the corresponding attach completes
		// or if the client disconnects/reconnects quickly (e.g. during dev reloads).
		s.config.logger.Debug("Connection not found for size update", "sessionID", s.ID, "connectionID", connectionID)
		return
	}

	go func() {
		if err := s.resizePTYToMinimumSize(); err != nil {
			s.config.logger.Warn("Failed to resize after update", "sessionID", s.ID, "error", err)
		}
	}()
}

func (s *Session) getMinimumTerminalSize() (int, int) {
	if len(s.connections) == 0 {
		return 80, 24
	}

	minCols := 999999
	minRows := 999999
	for _, conn := range s.connections {
		if conn.Cols < minCols {
			minCols = conn.Cols
		}
		if conn.Rows < minRows {
			minRows = conn.Rows
		}
	}

	if minCols < 20 {
		minCols = 20
	}
	if minRows < 5 {
		minRows = 5
	}

	return minCols, minRows
}

func (s *Session) resizePTYToMinimumSize() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.PTY == nil {
		return fmt.Errorf("PTY not available")
	}

	minCols, minRows := s.getMinimumTerminalSize()
	s.isResizing = true
	s.resizeEndTime = time.Now().Add(s.config.resizeSuppressDuration)

	if err := pty.Setsize(s.PTY, &pty.Winsize{Rows: uint16(minRows), Cols: uint16(minCols)}); err != nil {
		s.isResizing = false
		return fmt.Errorf("failed to resize PTY: %w", err)
	}

	s.config.logger.Debug("PTY resized to minimum size", "sessionID", s.ID, "cols", minCols, "rows", minRows)
	return nil
}

// ResizePTY resizes the PTY to the specified dimensions.
func (s *Session) ResizePTY(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.PTY == nil {
		return fmt.Errorf("PTY not available")
	}

	s.isResizing = true
	s.resizeEndTime = time.Now().Add(s.config.resizeSuppressDuration)

	if err := pty.Setsize(s.PTY, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}); err != nil {
		s.isResizing = false
		return fmt.Errorf("failed to resize PTY: %w", err)
	}

	s.config.logger.Info("PTY resized", "sessionID", s.ID, "cols", cols, "rows", rows)
	return nil
}
