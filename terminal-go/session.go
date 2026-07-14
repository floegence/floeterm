package terminal

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

var errSessionClosed = errors.New("session is closed")

const naturalExitPTYDrainTimeout = 500 * time.Millisecond

type sessionActivation struct {
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
	err    error
}

func newSessionActivation(parent context.Context) *sessionActivation {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	return &sessionActivation{ctx: ctx, cancel: cancel, done: make(chan struct{})}
}

func (a *sessionActivation) complete(err error) {
	if a == nil {
		return
	}
	a.once.Do(func() {
		a.err = err
		a.cancel()
		close(a.done)
	})
}

func (a *sessionActivation) wait(ctx context.Context) error {
	if a == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-a.done:
		return a.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// startPTY launches a new PTY-backed shell for the session.
func (s *Session) startPTY(cols, rows int) error {
	return s.startPTYContext(context.Background(), cols, rows)
}

func (s *Session) startPTYContext(ctx context.Context, cols, rows int) error {
	if err := validateTerminalSize(cols, rows); err != nil {
		return err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	if s.closed || sessionContextDone(s.ctx) {
		s.mu.Unlock()
		return errSessionClosed
	}
	if s.isActive {
		s.mu.Unlock()
		s.config.logger.Warn("Attempted to start PTY for active session", "sessionID", s.ID)
		return nil
	}
	activation := s.activation
	if activation == nil {
		activation = newSessionActivation(s.ctx)
		s.activation = activation
		go s.runPTYActivation(activation, cols, rows)
	}
	s.mu.Unlock()
	return activation.wait(ctx)
}

func sessionContextDone(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	select {
	case <-ctx.Done():
		return true
	default:
		return false
	}
}

func resolveShellForActivation(ctx context.Context, resolver ShellResolver, logger Logger) (string, error) {
	if contextual, ok := resolver.(ContextShellResolver); ok {
		return contextual.ResolveShellContext(ctx, logger)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return resolver.ResolveShell(logger), nil
}

func buildEnvForActivation(ctx context.Context, provider ShellEnvProvider, shell string, workingDir string) ([]string, string, error) {
	if contextual, ok := provider.(ContextShellEnvProvider); ok {
		return contextual.BuildEnvContext(ctx, shell, workingDir)
	}
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	return provider.BuildEnv(shell, workingDir)
}

func ensureShellInitForActivation(ctx context.Context, writer ShellInitWriter, pathPrepend string) error {
	if contextual, ok := writer.(ContextShellInitWriter); ok {
		return contextual.EnsureShellInitFilesContext(ctx, pathPrepend)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return writer.EnsureShellInitFiles(pathPrepend)
}

func shellArgsForActivation(ctx context.Context, provider ShellArgsProvider, shell string, pathPrepend string) ([]string, []string, error) {
	if contextual, ok := provider.(ContextShellArgsProvider); ok {
		return contextual.GetShellArgsContext(ctx, shell, pathPrepend)
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	args, env := provider.GetShellArgs(shell, pathPrepend)
	return args, env, nil
}

func (s *Session) runPTYActivation(activation *sessionActivation, cols, rows int) {
	err := s.launchPTY(activation, cols, rows)
	s.mu.Lock()
	if s.activation == activation {
		s.activation = nil
	}
	s.mu.Unlock()
	activation.complete(err)
}

func (s *Session) launchPTY(activation *sessionActivation, cols, rows int) error {
	if activation == nil || sessionContextDone(activation.ctx) {
		return errSessionClosed
	}

	shell, err := resolveShellForActivation(activation.ctx, s.config.shellResolver, s.config.logger)
	if err != nil {
		if sessionContextDone(activation.ctx) {
			return errSessionClosed
		}
		return fmt.Errorf("failed to resolve shell: %w", err)
	}
	s.config.logger.Info("Starting terminal", "shell", filepath.Base(shell), "workingDir", filepath.Base(s.WorkingDir))

	env, pathPrepend, envErr := buildEnvForActivation(activation.ctx, s.config.envProvider, shell, s.WorkingDir)
	if envErr != nil {
		if sessionContextDone(activation.ctx) {
			return errSessionClosed
		}
		s.config.logger.Warn("Env provider failed", "error", envErr)
		env = os.Environ()
	}
	if len(env) == 0 {
		env = os.Environ()
	}

	shouldEnsureShellInit := pathPrepend != ""
	if requirement, ok := s.config.shellInitWriter.(ShellInitRequirement); ok {
		shouldEnsureShellInit = requirement.ShouldEnsureShellInit(pathPrepend)
	}
	if shouldEnsureShellInit && s.config.shellInitWriter != nil {
		if err := ensureShellInitForActivation(activation.ctx, s.config.shellInitWriter, pathPrepend); err != nil {
			if sessionContextDone(activation.ctx) {
				return errSessionClosed
			}
			s.config.logger.Warn("Failed to ensure shell init files", "error", err)
		}
	}

	shellArgs, shellEnv, err := shellArgsForActivation(activation.ctx, s.config.shellArgsProvider, shell, pathPrepend)
	if err != nil {
		if sessionContextDone(activation.ctx) {
			return errSessionClosed
		}
		return fmt.Errorf("failed to build shell arguments: %w", err)
	}

	var cmd *exec.Cmd
	// Distinguish nil vs empty slice:
	// - nil means "no opinion" → fall back to a login shell for backwards behaviour.
	// - empty slice means "run the shell without extra args" (useful for ZDOTDIR-based zsh setup).
	if shellArgs != nil {
		cmd = exec.Command(shell, shellArgs...)
	} else {
		cmd = exec.Command(shell, "-l")
	}

	cmd.Dir = s.WorkingDir

	s.mu.Lock()
	if s.activation != activation || s.closed || sessionContextDone(activation.ctx) {
		s.mu.Unlock()
		return errSessionClosed
	}
	if s.isActive {
		s.mu.Unlock()
		return nil
	}
	if effectiveCols, effectiveRows, ok := s.getMinimumTerminalSizeLocked(); ok {
		cols, rows = effectiveCols, effectiveRows
	}
	s.mu.Unlock()

	env = append(env, shellEnv...)
	env = append(env,
		"TERM="+s.config.terminalEnv.Term,
		"COLORTERM="+s.config.terminalEnv.ColorTerm,
		"LANG="+s.config.terminalEnv.Lang,
		"LC_ALL="+s.config.terminalEnv.LcAll,
		"TERM_PROGRAM="+s.config.terminalEnv.TermProgram,
		"TERM_PROGRAM_VERSION="+s.config.terminalEnv.TermProgramVersion,
		"COLUMNS="+fmt.Sprintf("%d", cols),
		"LINES="+fmt.Sprintf("%d", rows),
		"PROMPT_EOL_MARK=",
		"TERMINFO="+s.config.terminalEnv.Terminfo,
		"TERM_FEATURES="+s.config.terminalEnv.TermFeatures,
	)
	cmd.Env = env

	winsize := buildWinSize(cols, rows)
	startPTYProcess := s.startPTYProcess
	if startPTYProcess == nil {
		startPTYProcess = pty.StartWithSize
	}
	ptmx, err := startPTYProcess(cmd, winsize)
	if err != nil {
		return fmt.Errorf("failed to start PTY: %w", err)
	}

	s.mu.Lock()
	if s.activation != activation || s.closed || sessionContextDone(activation.ctx) || s.isActive {
		active := s.isActive
		s.mu.Unlock()
		s.closeUnclaimedPTY(cmd, ptmx)
		if active {
			return nil
		}
		return errSessionClosed
	}
	s.PTY = ptmx
	s.Cmd = cmd
	s.isActive = true
	s.lastAppliedCols = cols
	s.lastAppliedRows = rows
	s.LastActive = time.Now()
	s.procWaitDone = make(chan struct{})
	s.readerDone = make(chan struct{})
	done := s.procWaitDone
	readerDone := s.readerDone
	s.activation = nil
	if effectiveCols, effectiveRows, ok := s.getMinimumTerminalSizeLocked(); ok && (effectiveCols != cols || effectiveRows != rows) {
		s.schedulePTYSizeReconcileLocked("activation-completed")
	}
	s.mu.Unlock()

	// Publish activation success before process observation can report a natural
	// exit and close the session.
	activation.complete(nil)
	go s.readPTYOutput(ptmx, readerDone)
	go s.waitProcessExit(cmd, ptmx, readerDone, done)

	s.config.logger.Info("Started PTY session", "sessionID", s.ID, "cols", cols, "rows", rows)
	return nil
}

func (s *Session) closeUnclaimedPTY(cmd *exec.Cmd, ptmx *os.File) {
	if ptmx != nil {
		_ = ptmx.Close()
	}
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
	_ = s.waitForProcess(cmd)
}

func (s *Session) waitForProcess(cmd *exec.Cmd) error {
	if s != nil && s.waitProcess != nil {
		return s.waitProcess(cmd)
	}
	return cmd.Wait()
}

func (s *Session) closeActivationAdmission() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.closed = true
	if s.cancel != nil {
		s.cancel()
	}
	activation := s.activation
	s.activation = nil
	s.mu.Unlock()
	activation.complete(errSessionClosed)
}

func buildWinSize(cols, rows int) *pty.Winsize {
	// Approximate pixel sizing for better compatibility with certain programs.
	charWidth := 8.4
	charHeight := 18.0
	return &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
		X:    uint16(float64(cols) * charWidth),
		Y:    uint16(float64(rows) * charHeight),
	}
}

func (s *Session) waitProcessExit(cmd *exec.Cmd, ptyFile *os.File, readerDone chan struct{}, done chan struct{}) {
	if cmd == nil || done == nil {
		return
	}

	err := s.waitForProcess(cmd)

	s.closeActivationAdmission()
	// The process has already been reaped. Publish that independently from PTY
	// drain so a synchronous event handler can delete the session without
	// waiting on the reader goroutine that is currently invoking it.
	close(done)
	if readerDone != nil {
		select {
		case <-readerDone:
		case <-time.After(naturalExitPTYDrainTimeout):
			if ptyFile != nil {
				_ = ptyFile.Close()
			}
			select {
			case <-readerDone:
			case <-time.After(naturalExitPTYDrainTimeout):
				s.config.logger.Warn("PTY output reader did not stop after close", "sessionID", s.ID)
			}
		}
	}

	s.mu.Lock()
	if s.Cmd == cmd {
		s.Cmd = nil
		s.procWaitErr = err
		s.isActive = false
	}
	if ptyFile != nil {
		_ = ptyFile.Close()
		if s.PTY == ptyFile {
			s.PTY = nil
		}
	}
	onExit := s.onExit
	sessionID := s.ID
	s.mu.Unlock()

	if onExit != nil {
		onExit(sessionID)
	}
}

// Close shuts down the session and releases resources.
func (s *Session) Close() error {
	s.cleanup()
	return nil
}

func (s *Session) cleanup() {
	s.mu.Lock()
	if s.cleaned {
		s.mu.Unlock()
		return
	}
	s.cleaned = true
	s.closed = true
	s.resizeQueued = false
	s.resizeRunning = false

	if s.cancel != nil {
		s.cancel()
	}
	activation := s.activation
	s.activation = nil
	ptyFile := s.PTY
	cmd := s.Cmd
	waitDone := s.procWaitDone
	s.PTY = nil
	s.Cmd = nil
	s.isActive = false

	for connID := range s.connections {
		delete(s.connections, connID)
	}
	s.mu.Unlock()

	activation.complete(errSessionClosed)
	if ptyFile != nil {
		_ = ptyFile.Close()
	}
	if cmd != nil && cmd.Process != nil {
		if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
			s.config.logger.Debug("Failed to send SIGTERM", "sessionID", s.ID, "error", err)
		}
		if waitDone != nil {
			select {
			case <-waitDone:
			case <-time.After(2 * time.Second):
				s.config.logger.Debug("Force killing process", "sessionID", s.ID)
				_ = cmd.Process.Kill()
				select {
				case <-waitDone:
				case <-time.After(2 * time.Second):
				}
			}
		}
	}

	s.config.logger.Info("Cleaned up session", "sessionID", s.ID)
}

// GetHistoryChunks returns raw chunks from the ring buffer.
func (s *Session) GetHistoryChunks() ([]TerminalDataChunk, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.ringBuffer == nil {
		return nil, fmt.Errorf("ring buffer not initialized")
	}

	return s.ringBuffer.ReadAllChunks(), nil
}

// GetHistoryPage returns a bounded history page and replay cursor metadata.
func (s *Session) GetHistoryPage(options HistoryPageOptions) (HistoryPage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ringBuffer := s.ringBuffer

	if ringBuffer == nil {
		return HistoryPage{}, fmt.Errorf("ring buffer not initialized")
	}

	if s.historyGeneration <= 0 {
		s.historyGeneration = 1
	}
	snapshotEnd := s.committedSequence
	if options.EndSeq > 0 && options.EndSeq < snapshotEnd {
		snapshotEnd = options.EndSeq
	}

	readOptions := options
	readOptions.EndSeq = snapshotEnd
	page := ringBuffer.ReadChunkPage(readOptions)
	page.SnapshotEndSequence = snapshotEnd
	page.HistoryGeneration = s.historyGeneration
	if options.HistoryGeneration > 0 && options.HistoryGeneration != s.historyGeneration {
		page.Chunks = []TerminalDataChunk{}
		page.FirstSequence = 0
		page.LastSequence = 0
		page.NextStartSeq = 0
		page.HasMore = false
		page.CoveredThroughSequence = 0
		page.CoveredBytes = 0
		page.HistoryReset = true
		return page, nil
	}
	if page.HasMore && page.NextStartSeq > 0 {
		page.CoveredThroughSequence = page.NextStartSeq - 1
	} else {
		page.CoveredThroughSequence = snapshotEnd
	}
	effectiveStart := options.StartSeq
	if effectiveStart <= 0 {
		effectiveStart = 1
	}
	if effectiveStart <= snapshotEnd && page.FirstRetainedSequence > effectiveStart {
		page.HistoryTruncated = true
	}
	if len(page.Chunks) > 0 && s.config.historyFilter != nil {
		page.Chunks = s.config.historyFilter.Filter(page.Chunks)
	}

	return page, nil
}

// GetHistoryFromSequence returns chunks starting at a given sequence.
func (s *Session) GetHistoryFromSequence(fromSeq int64) ([]TerminalDataChunk, error) {
	page, err := s.GetHistoryPage(HistoryPageOptions{StartSeq: fromSeq})
	if err != nil {
		return nil, err
	}
	return page.Chunks, nil
}

// GetHistoryStats returns a lightweight snapshot of the history buffer without copying stored data.
func (s *Session) GetHistoryStats() (RingBufferStats, error) {
	s.mu.RLock()
	ringBuffer := s.ringBuffer
	s.mu.RUnlock()

	if ringBuffer == nil {
		return RingBufferStats{}, fmt.Errorf("ring buffer not initialized")
	}

	return ringBuffer.GetStats(), nil
}

// ClearHistory removes stored PTY output from the ring buffer.
func (s *Session) ClearHistory() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ringBuffer != nil {
		s.ringBuffer.Clear()
	}
	s.historyGeneration++
	if s.historyGeneration <= 0 {
		s.historyGeneration = 1
	}

	s.config.logger.Info("Terminal history cleared", "sessionID", s.ID)
	return nil
}

// broadcastData sends output to the event handler with metadata.
func (s *Session) broadcastData(data []byte, seqNum int64) {
	// Never call external handlers while holding session locks. Handlers may
	// synchronously call back into this Session/Manager and would deadlock.
	s.mu.RLock()
	handler := s.eventHandler
	sessionID := s.ID
	lastInputSource := s.lastInputSource
	lastInputTime := s.lastInputTime
	s.mu.RUnlock()

	isEcho := false
	originalSource := ""
	if lastInputSource != "" && time.Since(lastInputTime) < 100*time.Millisecond {
		isEcho = true
		originalSource = lastInputSource
	}

	if handler != nil {
		handler.OnTerminalData(sessionID, data, seqNum, isEcho, originalSource)
		return
	}

	s.config.logger.Warn("No event handler for terminal data", "sessionID", sessionID)
}

func (s *Session) readPTYOutput(ptyFile *os.File, done chan struct{}) {
	if done != nil {
		defer close(done)
	}
	s.config.logger.Info("Starting PTY output reader", "sessionID", s.ID)

	buffer := make([]byte, 4096)
	for {
		if ptyFile == nil {
			s.config.logger.Warn("PTY is nil", "sessionID", s.ID)
			return
		}

		n, err := ptyFile.Read(buffer)
		if n > 0 {
			raw := make([]byte, n)
			copy(raw, buffer[:n])
			s.processRawPTYData(raw)
		}
		if err != nil {
			s.config.logger.Debug("PTY read finished", "sessionID", s.ID, "error", err)
			return
		}
	}
}

func (s *Session) processRawPTYData(data []byte) {
	timestamp := time.Now().UnixMilli()

	s.mu.Lock()
	s.sequenceNumber++
	seqNum := s.sequenceNumber
	s.LastActive = time.Now()

	if s.ringBuffer != nil {
		if err := s.ringBuffer.writeOwnedWithSequence(data, seqNum, timestamp, false); err != nil {
			s.config.logger.Error("Failed to write to ring buffer", "sessionID", s.ID, "error", err)
		} else {
			s.committedSequence = seqNum
		}
	}

	s.mu.Unlock()

	s.broadcastData(data, seqNum)

	s.checkWorkingDirectoryChange(data)
}

// WriteDataWithSource writes input to the PTY with basic deduplication.
func (s *Session) WriteDataWithSource(data []byte, sourceConnID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.PTY == nil {
		return fmt.Errorf("PTY not available")
	}

	sum := sha256.Sum256(data)
	if s.lastInputLen == len(data) && s.lastInputHash == sum && time.Since(s.lastInputTime) < s.inputWindow {
		s.config.logger.Debug("Ignoring duplicate input", "sessionID", s.ID, "dataLength", len(data))
		return nil
	}

	if _, err := s.PTY.Write(data); err != nil {
		s.config.logger.Error("Failed to write to PTY", "sessionID", s.ID, "error", err)
		return err
	}

	s.LastActive = time.Now()
	s.lastInputSource = sourceConnID
	s.lastInputTime = time.Now()
	s.lastInputHash = sum
	s.lastInputLen = len(data)

	return nil
}

// WriteData writes data without a source identifier.
func (s *Session) WriteData(data string) error {
	return s.WriteDataWithSource([]byte(data), "")
}

// GetID returns the session ID.
func (s *Session) GetID() string { return s.ID }

// GetName returns the current session name.
func (s *Session) GetName() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Name
}

// GetWorkingDir returns the session working directory.
func (s *Session) GetWorkingDir() string { return s.WorkingDir }

// IsActive returns whether the PTY is running.
func (s *Session) IsActive() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.isActive
}

// GetCreatedAt returns the creation timestamp.
func (s *Session) GetCreatedAt() time.Time { return s.CreatedAt }

// GetLastActive returns the last activity timestamp.
func (s *Session) GetLastActive() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.LastActive
}

// readLineSafe reads a line from a scanner without returning partial data.
