package terminal

import (
	"fmt"
	"os"
	"time"

	"github.com/creack/pty"
)

// AddConnection registers a client connection with the session.
func (s *Session) AddConnection(connectionID string, cols, rows int) {
	s.AddConnectionWithHistoryBoundary(connectionID, cols, rows)
}

// AddConnectionWithHistoryBoundary registers a client and returns the last
// committed source sequence that belongs to its initial history snapshot.
func (s *Session) AddConnectionWithHistoryBoundary(connectionID string, cols, rows int) int64 {
	if connectionID == "" {
		s.config.logger.Error("Cannot add connection with empty ID", "sessionID", s.ID)
		return 0
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
	return s.committedSequence
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

// ApplyConnectionSize records one view's dimensions and returns only after the
// shared PTY reflects the minimum rows and columns required by all live views.
func (s *Session) ApplyConnectionSize(connectionID string, cols, rows int) (TerminalGeometry, error) {
	return s.applyConnectionSize(connectionID, cols, rows, false)
}

// ApplyConnectionSizeForAttach applies the initial live attachment size. The
// attach path may request one same-size foreground redraw so a client whose
// retained history is incomplete can receive a fresh post-boundary frame.
func (s *Session) ApplyConnectionSizeForAttach(connectionID string, cols, rows int) (TerminalGeometry, error) {
	return s.applyConnectionSize(connectionID, cols, rows, true)
}

func (s *Session) CanonicalGeometry() TerminalGeometry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.effectiveGeometryLocked()
}

// RegisterSemanticView records a view without making it participate in the
// legacy min-size PTY reconciliation path.
func (s *Session) RegisterSemanticView(connectionID string, cols, rows int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.connections == nil {
		s.connections = make(map[string]*ConnectionInfo)
	}
	s.connections[connectionID] = &ConnectionInfo{ConnID: connectionID, JoinedAt: time.Now(), Cols: cols, Rows: rows}
}

func (s *Session) SetCanonicalGeometry(cols, rows int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastAppliedCols, s.lastAppliedRows = cols, rows
	if s.geometryGeneration == 0 {
		s.geometryGeneration = 1
	}
}

func (s *Session) applyConnectionSize(connectionID string, cols, rows int, force bool) (TerminalGeometry, error) {
	if connectionID == "" {
		return TerminalGeometry{}, fmt.Errorf("connection ID is required")
	}
	if err := validateTerminalSize(cols, rows); err != nil {
		return TerminalGeometry{}, err
	}

	if err := s.beginPTYResize(); err != nil {
		return TerminalGeometry{}, err
	}

	s.mu.Lock()
	conn, exists := s.connections[connectionID]
	if !exists {
		s.mu.Unlock()
		s.endPTYResize()
		return TerminalGeometry{}, fmt.Errorf("terminal connection %q is not attached", connectionID)
	}
	previousCols, previousRows := conn.Cols, conn.Rows
	previousGeneration := s.geometryGeneration
	conn.Cols = cols
	conn.Rows = rows
	if !s.isActive {
		geometry := s.effectiveGeometryLocked()
		s.mu.Unlock()
		s.endPTYResize()
		return geometry, nil
	}
	reason := "connection-applied"
	if force {
		reason = "connection-attached"
	}
	if err := s.reconcilePTYSizeLocked(reason, force); err != nil {
		conn.Cols = previousCols
		conn.Rows = previousRows
		s.mu.Unlock()
		s.endPTYResize()
		return TerminalGeometry{}, err
	}
	geometry := s.effectiveGeometryLocked()
	var subscribers []LiveSubscriber
	if geometry.Generation != previousGeneration {
		subscribers = s.liveSubscribersLocked()
	}
	s.mu.Unlock()
	s.endPTYResize()
	if len(subscribers) > 0 {
		s.broadcastGeometry(geometry, subscribers)
	}
	return geometry, nil
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

func (s *Session) effectiveGeometryLocked() TerminalGeometry {
	cols, rows := s.lastAppliedCols, s.lastAppliedRows
	if cols <= 0 || rows <= 0 {
		if minimumCols, minimumRows, ok := s.getMinimumTerminalSizeLocked(); ok {
			cols, rows = minimumCols, minimumRows
		} else {
			cols, rows = 80, 24
		}
	}
	if s.geometryGeneration == 0 {
		s.geometryGeneration = 1
	}
	return TerminalGeometry{
		Generation:             s.geometryGeneration,
		OutputSequenceBoundary: s.committedSequence,
		Cols:                   cols,
		Rows:                   rows,
	}
}

func (s *Session) reconcilePTYSizeLocked(reason string, force bool) error {
	cols, rows, ok := s.getMinimumTerminalSizeLocked()
	if !ok {
		return nil
	}
	return s.applyPTYSizeLocked(cols, rows, reason, force)
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
		// Serialize the kernel resize with PTY packets that have already
		// returned from Read but are still awaiting ordered history commit.
		if err := s.beginPTYResize(); err != nil {
			s.config.logger.Warn("Failed to order PTY resize", "sessionID", s.ID, "reason", reason, "error", err)
			continue
		}
		err := setSize(ptyFile, buildWinSize(cols, rows))

		s.mu.Lock()
		stillCurrent := s.isActive && s.PTY == ptyFile
		var geometry TerminalGeometry
		var subscribers []LiveSubscriber
		if err == nil && stillCurrent {
			s.lastAppliedCols = cols
			s.lastAppliedRows = rows
			s.geometryGeneration++
			if s.geometryGeneration == 0 {
				s.geometryGeneration = 1
			}
			geometry = s.effectiveGeometryLocked()
			subscribers = s.liveSubscribersLocked()
		}
		s.mu.Unlock()
		s.endPTYResize()
		if len(subscribers) > 0 {
			s.broadcastGeometry(geometry, subscribers)
		}

		if err != nil && stillCurrent {
			s.config.logger.Warn("Failed to reconcile PTY size", "sessionID", s.ID, "reason", reason, "error", err)
		}
	}
}

func (s *Session) resizePTYToMinimumSize() error {
	if err := s.beginPTYResize(); err != nil {
		return err
	}
	defer s.endPTYResize()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reconcilePTYSizeLocked("connection-reconcile", false)
}

func (s *Session) applyPTYSizeLocked(cols, rows int, reason string, force bool) error {
	if s.PTY == nil {
		return fmt.Errorf("PTY not available")
	}
	if err := validateTerminalSize(cols, rows); err != nil {
		return err
	}
	changed := s.lastAppliedCols != cols || s.lastAppliedRows != rows
	if !changed && !force {
		if s.geometryGeneration == 0 {
			s.geometryGeneration = 1
		}
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
	if s.semanticActor != nil {
		if err := s.semanticActor.Resize(cols, rows); err != nil {
			return fmt.Errorf("resize semantic engine: %w", err)
		}
	}
	if changed {
		s.lastAppliedCols = cols
		s.lastAppliedRows = rows
		s.geometryGeneration++
		if s.geometryGeneration == 0 {
			s.geometryGeneration = 1
		}
	}
	// TIOCSWINSZ notifies the foreground process group when the grid changes.
	// A separate signal is reserved for a forced same-size attach that needs a
	// fresh post-boundary frame after retained history was truncated.
	if !changed && force {
		s.requestPTYForegroundRedraw(s.PTY, reason)
	}
	s.config.logger.Debug("PTY resized", "sessionID", s.ID, "cols", cols, "rows", rows, "reason", reason)
	return nil
}

func (s *Session) requestPTYForegroundRedraw(ptyFile *os.File, reason string) {
	requestRedraw := s.requestPTYRedraw
	if requestRedraw == nil && s.setPTYSize == nil {
		requestRedraw = requestPTYForegroundRedraw
	}
	if requestRedraw == nil {
		return
	}
	if err := requestRedraw(ptyFile); err != nil {
		s.config.logger.Warn("Failed to request PTY foreground redraw", "sessionID", s.ID, "reason", reason, "error", err)
		return
	}
	s.config.logger.Debug(
		"Requested PTY foreground redraw",
		"sessionID", s.ID,
		"reason", reason,
		"generation", s.geometryGeneration,
		"outputSequenceBoundary", s.committedSequence,
	)
}

// ResizePTY resizes the PTY to the specified dimensions.
func (s *Session) ResizePTY(cols, rows int) error {
	if err := s.beginPTYResize(); err != nil {
		return err
	}
	defer s.endPTYResize()
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := validateTerminalSize(cols, rows); err != nil {
		return err
	}
	if len(s.connections) > 0 {
		return s.reconcilePTYSizeLocked("legacy-resize-with-connections", true)
	}
	return s.applyPTYSizeLocked(cols, rows, "legacy-resize", true)
}
