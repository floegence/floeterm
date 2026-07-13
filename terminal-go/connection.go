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
	defer s.mu.Unlock()
	existing := s.connections[connectionID]
	s.connections[connectionID] = &ConnectionInfo{
		ConnID:   connectionID,
		JoinedAt: time.Now(),
		Cols:     cols,
		Rows:     rows,
	}

	if existing != nil {
		s.config.logger.Debug("Replacing existing connection", "sessionID", s.ID, "connectionID", connectionID, "oldJoinedAt", existing.JoinedAt)
	}
	if s.isActive {
		s.schedulePTYSizeReconcileLocked("connection-added")
	}
}

// RemoveConnection unregisters a client connection.
func (s *Session) RemoveConnection(connectionID string) {
	if connectionID == "" {
		return
	}

	s.config.logger.Debug("Removing connection", "sessionID", s.ID, "connectionID", connectionID)

	s.mu.Lock()
	defer s.mu.Unlock()
	conn, exists := s.connections[connectionID]
	if !exists {
		return
	}
	delete(s.connections, connectionID)
	s.config.logger.Debug("Removed connection", "sessionID", s.ID, "connectionID", connectionID, "joinedAt", conn.JoinedAt)

	// IMPORTANT: A detached session keeps the last applied PTY size. Resetting
	// to 80x24 would reflow the shell and create output without a user resize.
	if s.isActive && len(s.connections) > 0 {
		s.schedulePTYSizeReconcileLocked("connection-removed")
	}
}

// UpdateConnectionSize updates a connection's terminal size.
func (s *Session) UpdateConnectionSize(connectionID string, cols, rows int) {
	if connectionID == "" {
		return
	}

	s.config.logger.Debug("Updating connection size", "sessionID", s.ID, "connectionID", connectionID, "cols", cols, "rows", rows)

	s.mu.Lock()
	defer s.mu.Unlock()
	conn, exists := s.connections[connectionID]
	if !exists {
		// A resize may race ahead of attach or arrive after a fast reconnect.
		s.config.logger.Debug("Connection not found for size update", "sessionID", s.ID, "connectionID", connectionID)
		return
	}
	conn.Cols = cols
	conn.Rows = rows
	if s.isActive {
		s.schedulePTYSizeReconcileLocked("connection-updated")
	}
}

func (s *Session) hasConnections() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.connections) > 0
}

func (s *Session) getMinimumTerminalSizeLocked() (int, int, bool) {
	if len(s.connections) == 0 {
		return 0, 0, false
	}

	minCols := int(^uint(0) >> 1)
	minRows := int(^uint(0) >> 1)
	for _, conn := range s.connections {
		if conn.Cols < minCols {
			minCols = conn.Cols
		}
		if conn.Rows < minRows {
			minRows = conn.Rows
		}
	}

	minCols, minRows = clampTerminalSize(minCols, minRows)
	return minCols, minRows, true
}

func (s *Session) getMinimumTerminalSize() (int, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cols, rows, ok := s.getMinimumTerminalSizeLocked()
	if !ok {
		if s.lastAppliedCols > 0 && s.lastAppliedRows > 0 {
			return s.lastAppliedCols, s.lastAppliedRows
		}
		return 80, 24
	}
	return cols, rows
}

func (s *Session) reconcilePTYSizeLocked(reason string) error {
	cols, rows, ok := s.getMinimumTerminalSizeLocked()
	if !ok {
		return nil
	}
	return s.applyPTYSizeLocked(cols, rows, reason)
}

func (s *Session) schedulePTYSizeReconcileLocked(reason string) {
	s.resizeQueued = true
	s.resizeReason = reason
	if s.resizeRunning {
		return
	}
	s.resizeRunning = true
	go s.runPTYSizeReconciler()
}

func (s *Session) runPTYSizeReconciler() {
	for {
		s.mu.Lock()
		if !s.resizeQueued || !s.isActive || s.PTY == nil {
			s.resizeQueued = false
			s.resizeRunning = false
			s.mu.Unlock()
			return
		}
		reason := s.resizeReason
		s.resizeQueued = false
		cols, rows, ok := s.getMinimumTerminalSizeLocked()
		ptyFile := s.PTY
		setSize := s.setPTYSize
		if setSize == nil {
			setSize = pty.Setsize
		}
		unchanged := ok && s.lastAppliedCols == cols && s.lastAppliedRows == rows
		s.mu.Unlock()

		if !ok || unchanged {
			continue
		}
		err := setSize(ptyFile, buildWinSize(cols, rows))

		s.mu.Lock()
		stillCurrent := s.isActive && s.PTY == ptyFile
		if err == nil && stillCurrent {
			s.lastAppliedCols = cols
			s.lastAppliedRows = rows
		}
		s.mu.Unlock()

		if err != nil && stillCurrent {
			s.config.logger.Warn("Failed to reconcile PTY size", "sessionID", s.ID, "reason", reason, "error", err)
		}
	}
}

func (s *Session) resizePTYToMinimumSize() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reconcilePTYSizeLocked("connection-reconcile")
}

func (s *Session) applyPTYSizeLocked(cols, rows int, reason string) error {
	if s.PTY == nil {
		return fmt.Errorf("PTY not available")
	}
	if err := validateTerminalSize(cols, rows); err != nil {
		return err
	}
	if s.lastAppliedCols == cols && s.lastAppliedRows == rows {
		s.config.logger.Debug("PTY resize skipped", "sessionID", s.ID, "cols", cols, "rows", rows, "reason", reason)
		return nil
	}

	setSize := s.setPTYSize
	if setSize == nil {
		setSize = pty.Setsize
	}
	if err := setSize(s.PTY, buildWinSize(cols, rows)); err != nil {
		return fmt.Errorf("failed to resize PTY: %w", err)
	}
	s.lastAppliedCols = cols
	s.lastAppliedRows = rows
	s.config.logger.Debug("PTY resized", "sessionID", s.ID, "cols", cols, "rows", rows, "reason", reason)
	return nil
}

// ResizePTY resizes the PTY to the specified dimensions.
func (s *Session) ResizePTY(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := validateTerminalSize(cols, rows); err != nil {
		return err
	}
	if len(s.connections) > 0 {
		return s.reconcilePTYSizeLocked("legacy-resize-with-connections")
	}
	return s.applyPTYSizeLocked(cols, rows, "legacy-resize")
}
