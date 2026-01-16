package terminal

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

// NewManager creates a terminal manager with the provided configuration.
func NewManager(cfg ManagerConfig) *Manager {
	cfg = cfg.applyDefaults()
	return &Manager{
		sessions:     make(map[string]*Session),
		sessionOrder: make([]string, 0),
		config:       cfg,
	}
}

// getDirectoryName derives a display name from a working directory path.
func getDirectoryName(path string) string {
	if path == "" {
		return "home"
	}

	if homeDir, err := os.UserHomeDir(); err == nil && path == homeDir {
		return "home"
	}

	if path == "/" {
		return "root"
	}

	parts := strings.Split(strings.TrimSuffix(path, "/"), "/")
	if len(parts) > 0 && parts[len(parts)-1] != "" {
		return parts[len(parts)-1]
	}

	return "home"
}

// CreateSession creates and starts a new PTY session.
func (m *Manager) CreateSession(name, workingDir string, cols, rows int) (*Session, error) {
	sessionID := generateSessionID()

	if name == "" {
		name = getDirectoryName(workingDir)
	}

	if workingDir == "" {
		if homeDir, err := os.UserHomeDir(); err == nil {
			workingDir = homeDir
		} else {
			workingDir = "/"
		}
	}

	// Snapshot the current handler so early PTY output is not dropped while the
	// session is being created.
	m.mu.RLock()
	initialHandler := m.eventHandler
	m.mu.RUnlock()

	ctx, cancel := context.WithCancel(context.Background())
	sessionCfg := newSessionConfig(m.config)
	createdDone := make(chan struct{})
	// Ensure onExit never blocks forever even if CreateSession errors or panics.
	defer close(createdDone)

	session := &Session{
		ID:                sessionID,
		Name:              name,
		WorkingDir:        workingDir,
		CreatedAt:         time.Now(),
		LastActive:        time.Now(),
		isActive:          false,
		connections:       make(map[string]*ConnectionInfo),
		ctx:               ctx,
		cancel:            cancel,
		ringBuffer:        NewTerminalRingBuffer(sessionCfg.historyBufferSize),
		currentWorkingDir: workingDir,
		inputWindow:       sessionCfg.inputWindow,
		eventHandler:      initialHandler,
		onExit: func(sessionID string) {
			<-createdDone
			m.deleteSessionIfExists(sessionID)
		},
		config: sessionCfg,
	}

	// Register the session before starting the PTY so the onExit callback can
	// reliably remove it even if the process exits immediately.
	m.mu.Lock()
	m.sessions[sessionID] = session
	m.sessionOrder = append(m.sessionOrder, sessionID)
	m.mu.Unlock()

	if err := session.startPTY(cols, rows); err != nil {
		cancel()
		m.detachSession(sessionID)
		session.cleanup()
		m.config.Logger.Error("Terminal session creation failed", "sessionID", sessionID, "error", err)
		return nil, fmt.Errorf("failed to start PTY: %w", err)
	}

	// Refresh handler after PTY start in case it changed during initialization.
	m.mu.RLock()
	handler := m.eventHandler
	m.mu.RUnlock()

	session.mu.Lock()
	session.eventHandler = handler
	session.mu.Unlock()

	m.config.Logger.Info("Created terminal session", "sessionID", sessionID, "name", name, "workingDir", workingDir)

	if handler != nil {
		handler.OnTerminalSessionCreated(session)
	}

	return session, nil
}

// GetSession returns a session by ID.
func (m *Manager) GetSession(sessionID string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session, exists := m.sessions[sessionID]
	return session, exists
}

// ListSessions returns active sessions in creation order.
func (m *Manager) ListSessions() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	sessions := make([]*Session, 0, len(m.sessions))
	for _, sessionID := range m.sessionOrder {
		if session, exists := m.sessions[sessionID]; exists {
			sessions = append(sessions, session)
		}
	}
	return sessions
}

// DeleteSession removes and cleans up a session.
func (m *Manager) DeleteSession(sessionID string) error {
	session, handler, removed := m.detachSession(sessionID)
	if !removed {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.cleanup()
	if handler != nil {
		handler.OnTerminalSessionClosed(sessionID)
	}

	m.config.Logger.Info("Deleted terminal session", "sessionID", sessionID, "remainingCount", m.countSessions())
	return nil
}

func (m *Manager) detachSession(sessionID string) (*Session, TerminalEventHandler, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, exists := m.sessions[sessionID]
	if !exists {
		return nil, nil, false
	}

	delete(m.sessions, sessionID)
	for i, id := range m.sessionOrder {
		if id == sessionID {
			m.sessionOrder = append(m.sessionOrder[:i], m.sessionOrder[i+1:]...)
			break
		}
	}

	return session, m.eventHandler, true
}

func (m *Manager) deleteSessionIfExists(sessionID string) {
	session, handler, removed := m.detachSession(sessionID)
	if !removed || session == nil {
		return
	}

	session.cleanup()
	if handler != nil {
		handler.OnTerminalSessionClosed(sessionID)
	}

	m.config.Logger.Info("Deleted terminal session (auto)", "sessionID", sessionID, "remainingCount", m.countSessions())
}

func (m *Manager) countSessions() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}

// RenameSession updates the session display name.
func (m *Manager) RenameSession(sessionID, newName string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, exists := m.sessions[sessionID]
	if !exists {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()
	session.Name = newName
	session.LastActive = time.Now()
	session.mu.Unlock()

	m.config.Logger.Info("Renamed terminal session", "sessionID", sessionID, "newName", newName)
	return nil
}

// ActivateSession starts a PTY for a dormant session.
func (m *Manager) ActivateSession(sessionID string, cols, rows int) error {
	m.mu.RLock()
	session, exists := m.sessions[sessionID]
	m.mu.RUnlock()
	if !exists {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	// startPTY is internally synchronized and will no-op when already active.
	if err := session.startPTY(cols, rows); err != nil {
		return fmt.Errorf("failed to activate session: %w", err)
	}

	m.config.Logger.Info("Activated dormant session", "sessionID", sessionID)
	return nil
}

// Cleanup stops and removes all sessions.
func (m *Manager) Cleanup() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.sessions = make(map[string]*Session)
	m.sessionOrder = make([]string, 0)
	m.mu.Unlock()

	m.config.Logger.Info("Cleaning up all terminal sessions", "count", len(sessions))
	for _, session := range sessions {
		m.config.Logger.Debug("Cleaning up session", "sessionID", session.ID)
		session.cleanup()
	}
}

// SetEventHandler sets a new handler for current and future sessions.
func (m *Manager) SetEventHandler(handler TerminalEventHandler) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.eventHandler = handler
	for _, session := range m.sessions {
		session.mu.Lock()
		session.eventHandler = handler
		session.mu.Unlock()
	}
}

// ToSessionInfo converts a session to a public summary.
func (s *Session) ToSessionInfo() TerminalSessionInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return TerminalSessionInfo{
		ID:         s.ID,
		Name:       s.Name,
		WorkingDir: s.WorkingDir,
		CreatedAt:  s.CreatedAt.UnixMilli(),
		LastActive: s.LastActive.UnixMilli(),
		IsActive:   s.isActive,
	}
}
