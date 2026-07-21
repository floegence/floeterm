package terminal

import (
	"context"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

// TerminalDataChunk represents a chunk of PTY output stored for history replay.
type TerminalDataChunk struct {
	Sequence  int64
	Data      []byte
	Timestamp int64
	Size      int
}

// HistoryPageOptions configures a bounded chronological terminal history read.
type HistoryPageOptions struct {
	StartSeq          int64
	EndSeq            int64
	HistoryGeneration int64
	LimitChunks       int
	MaxBytes          int
}

// HistoryPage is a bounded terminal history snapshot plus replay cursor metadata.
type HistoryPage struct {
	Chunks                 []TerminalDataChunk
	FirstSequence          int64
	LastSequence           int64
	FirstRetainedSequence  int64
	NextStartSeq           int64
	HasMore                bool
	CoveredThroughSequence int64
	SnapshotEndSequence    int64
	HistoryGeneration      int64
	HistoryReset           bool
	HistoryTruncated       bool
	CoveredBytes           int64
	TotalBytes             int64
	UsedChunks             int
}

// TerminalSessionInfo summarizes a terminal session for listing APIs.
type TerminalSessionInfo struct {
	ID                string
	Name              string
	WorkingDir        string
	CreatedAt         int64
	LastActive        int64
	IsActive          bool
	ForegroundCommand TerminalForegroundCommandInfo
	OutputActivity    TerminalOutputActivityInfo
}

// ForegroundCommandPhase describes the interactive shell's command lifecycle.
// It is shell-reported state, not an operating-system process observation.
type ForegroundCommandPhase string

const (
	ForegroundCommandUnknown ForegroundCommandPhase = "unknown"
	ForegroundCommandIdle    ForegroundCommandPhase = "idle"
	ForegroundCommandRunning ForegroundCommandPhase = "running"
)

// TerminalForegroundCommandInfo is the latest shell-reported foreground command state.
type TerminalForegroundCommandInfo struct {
	Phase       ForegroundCommandPhase
	DisplayName string
	Revision    uint64
	UpdatedAt   int64
}

// TerminalOutputActivityPhase describes whether a running foreground command
// is currently producing display payload or has gone quiet.
type TerminalOutputActivityPhase string

const (
	OutputActivityUnknown   TerminalOutputActivityPhase = "unknown"
	OutputActivityStreaming TerminalOutputActivityPhase = "streaming"
	OutputActivitySettled   TerminalOutputActivityPhase = "settled"
)

// TerminalOutputActivityInfo is a low-frequency output-boundary snapshot.
// Settled means output is quiet; it does not mean the command completed.
type TerminalOutputActivityInfo struct {
	Phase     TerminalOutputActivityPhase
	Revision  uint64
	UpdatedAt int64
}

// ManagerDiagnostics reports terminal history memory without imposing a
// session-count limit or changing session lifecycle behavior.
type ManagerDiagnostics struct {
	SessionCount        int
	ActiveSessionCount  int
	ConnectionCount     int
	LiveAttachmentCount int
	HistoryBytes        int64
	SessionHistoryBytes map[string]int64
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
	OnTerminalData(sessionID string, event TerminalOutputEvent)
	OnTerminalNameChanged(sessionID string, oldName string, newName string, workingDir string)
	OnTerminalSessionCreated(session *Session)
	OnTerminalSessionClosed(sessionID string)
	OnTerminalError(sessionID string, err error)
}

// TerminalSessionMetadataEventHandler optionally receives command metadata
// transitions without widening the required TerminalEventHandler contract.
type TerminalSessionMetadataEventHandler interface {
	OnTerminalSessionMetadataChanged(sessionID string, info TerminalSessionInfo)
}

// TerminalOutputActivityEventHandler optionally receives output phase changes.
type TerminalOutputActivityEventHandler interface {
	OnTerminalOutputActivityChanged(sessionID string, info TerminalOutputActivityInfo)
}

// TerminalGeometry identifies one applied PTY grid size.
type TerminalGeometry struct {
	Generation             uint64
	OutputSequenceBoundary int64
	Cols                   int
	Rows                   int
}

// TerminalOutputEvent is committed once and shared by live output and history.
type TerminalOutputEvent struct {
	Data        []byte
	Sequence    int64
	TimestampMs int64
	Geometry    TerminalGeometry
}

// LiveSubscriber receives exact output for one attached connection.
type LiveSubscriber struct {
	OnOutput        func(TerminalOutputEvent) bool
	OnGeometry      func(TerminalGeometry) bool
	OnSessionClosed func()
	OnSuperseded    func()
}

// LiveConnectionAttachment describes the atomic history/live handoff.
type LiveConnectionAttachment struct {
	HistoryBoundarySequence int64
	HistoryGeneration       int64
	HistoryStartSequence    int64
	Geometry                TerminalGeometry
	Detach                  func()
}

// TerminalSession defines the operations for a persistent terminal session.
// A session may remain dormant until it is activated by an attach flow.
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
	GetHistoryPage(options HistoryPageOptions) (HistoryPage, error)
	GetHistoryFromSequence(fromSeq int64) ([]TerminalDataChunk, error)
	ClearHistory() error
	Close() error
}

// TerminalManager manages multiple terminal sessions in memory.
type TerminalManager interface {
	CreateSession(name, workingDir string) (*Session, error)
	GetSession(sessionID string) (*Session, bool)
	ListSessions() []*Session
	DeleteSession(sessionID string) error
	ClearSessionHistory(sessionID string) error
	RenameSession(sessionID, newName string) error
	ActivateSession(sessionID string, cols, rows int) error
	SetEventHandler(handler TerminalEventHandler)
	GetDiagnostics() ManagerDiagnostics
	Cleanup()
}

// ContextTerminalManager extends TerminalManager with caller-cancellable
// activation waits. Cancelling the caller does not cancel a shared session
// activation that another caller may still need.
type ContextTerminalManager interface {
	TerminalManager
	ActivateSessionContext(ctx context.Context, sessionID string, cols, rows int) error
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
	closed   bool
	cleaned  bool
	mu       sync.RWMutex
	ctx      context.Context
	cancel   context.CancelFunc

	connections     map[string]*ConnectionInfo
	ringBuffer      *TerminalRingBuffer
	liveAttachments map[string]liveAttachment

	sequenceNumber       int64
	committedSequence    int64
	historyGeneration    int64
	historyStartSequence int64

	currentWorkingDir             string
	workdirPending                []byte
	shellIntegrationPending       []byte
	pendingForegroundProgram      string
	foregroundCommand             TerminalForegroundCommandInfo
	outputActivity                TerminalOutputActivityInfo
	outputActivityTimer           *time.Timer
	outputActivityDeadline        time.Time
	outputActivityGeneration      uint64
	outputActivityCommandRevision uint64

	lastAppliedCols    int
	lastAppliedRows    int
	geometryGeneration uint64
	startPTYProcess    func(*exec.Cmd, *pty.Winsize) (*os.File, error)
	waitProcess        func(*exec.Cmd) error
	setPTYSize         func(*os.File, *pty.Winsize) error
	resizeQueued       bool
	resizeRunning      bool
	resizeReason       string

	eventHandler TerminalEventHandler

	procWaitDone chan struct{}
	readerDone   chan struct{}
	procWaitErr  error
	activation   *sessionActivation

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
