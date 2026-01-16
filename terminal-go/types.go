package terminal

import (
	"context"
	"os"
	"os/exec"
	"sync"
	"time"
)

// TerminalDataChunk represents a chunk of PTY output stored for history replay.
type TerminalDataChunk struct {
	Sequence  int64
	Data      []byte
	Timestamp int64
	Size      int
}

// TerminalSessionInfo summarizes a terminal session for listing APIs.
type TerminalSessionInfo struct {
	ID         string
	Name       string
	WorkingDir string
	CreatedAt  int64
	LastActive int64
	IsActive   bool
}

// ConnectionInfo stores metadata for a connected client.
type ConnectionInfo struct {
	ConnID   string
	JoinedAt time.Time
	Cols     int
	Rows     int
}

// TerminalEventHandler receives session lifecycle and output events.
type TerminalEventHandler interface {
	OnTerminalData(sessionID string, data []byte, sequenceNumber int64, isEcho bool, originalSource string)
	OnTerminalNameChanged(sessionID string, oldName string, newName string, workingDir string)
	OnTerminalSessionCreated(session *Session)
	OnTerminalSessionClosed(sessionID string)
	OnTerminalError(sessionID string, err error)
}

// TerminalSession defines the operations for a running PTY-backed session.
type TerminalSession interface {
	GetID() string
	GetName() string
	GetWorkingDir() string
	IsActive() bool
	GetCreatedAt() time.Time
	GetLastActive() time.Time

	AddConnection(connectionID string, cols, rows int)
	RemoveConnection(connectionID string)
	UpdateConnectionSize(connectionID string, cols, rows int)

	WriteDataWithSource(data []byte, sourceConnID string) error
	ResizePTY(cols, rows int) error
	GetHistoryFromSequence(fromSeq int64) ([]TerminalDataChunk, error)
	ClearHistory() error
	Close() error
}

// TerminalManager manages multiple terminal sessions in memory.
type TerminalManager interface {
	CreateSession(name, workingDir string, cols, rows int) (*Session, error)
	GetSession(sessionID string) (*Session, bool)
	ListSessions() []*Session
	DeleteSession(sessionID string) error
	ClearSessionHistory(sessionID string) error
	RenameSession(sessionID, newName string) error
	ActivateSession(sessionID string, cols, rows int) error
	SetEventHandler(handler TerminalEventHandler)
	Cleanup()
}

// Session represents a persistent terminal session backed by a PTY.
type Session struct {
	ID         string
	Name       string
	WorkingDir string
	CreatedAt  time.Time
	LastActive time.Time
	PTY        *os.File
	Cmd        *exec.Cmd

	isActive bool
	mu       sync.RWMutex
	ctx      context.Context
	cancel   context.CancelFunc

	connections map[string]*ConnectionInfo
	ringBuffer  *TerminalRingBuffer

	lastInputSource string
	lastInputTime   time.Time
	lastInputHash   [32]byte
	lastInputLen    int
	inputWindow     time.Duration

	sequenceNumber int64

	currentWorkingDir string

	isResizing    bool
	resizeEndTime time.Time

	eventHandler TerminalEventHandler

	procWaitDone chan struct{}
	procWaitErr  error

	onExit func(sessionID string)

	config sessionConfig
}

// Manager manages multiple sessions.
type Manager struct {
	sessions     map[string]*Session
	sessionOrder []string
	mu           sync.RWMutex

	eventHandler TerminalEventHandler
	config       ManagerConfig
}
