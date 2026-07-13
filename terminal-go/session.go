package terminal

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// startPTY launches a new PTY-backed shell for the session.
func (s *Session) startPTY(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := validateTerminalSize(cols, rows); err != nil {
		return err
	}

	if s.isActive {
		s.config.logger.Warn("Attempted to start PTY for active session", "sessionID", s.ID)
		return nil
	}

	// A session that has been closed (cleanup cancels ctx) must not be restarted.
	if s.ctx != nil {
		select {
		case <-s.ctx.Done():
			return fmt.Errorf("session is closed")
		default:
		}
	}

	shell := s.config.shellResolver.ResolveShell(s.config.logger)
	s.config.logger.Info("Starting terminal", "shell", filepath.Base(shell), "workingDir", filepath.Base(s.WorkingDir))

	env, pathPrepend, envErr := s.config.envProvider.BuildEnv(shell, s.WorkingDir)
	if envErr != nil {
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
		if err := s.config.shellInitWriter.EnsureShellInitFiles(pathPrepend); err != nil {
			s.config.logger.Warn("Failed to ensure shell init files", "error", err)
		}
	}

	shellArgs, shellEnv := s.config.shellArgsProvider.GetShellArgs(shell, pathPrepend)

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

	if effectiveCols, effectiveRows, ok := s.getMinimumTerminalSizeLocked(); ok {
		cols, rows = effectiveCols, effectiveRows
	}

	winsize := buildWinSize(cols, rows)
	ptmx, err := pty.StartWithSize(cmd, winsize)
	if err != nil {
		return fmt.Errorf("failed to start PTY: %w", err)
	}

	s.PTY = ptmx
	s.Cmd = cmd
	s.isActive = true
	s.lastAppliedCols = cols
	s.lastAppliedRows = rows
	s.LastActive = time.Now()
	s.procWaitDone = make(chan struct{})

	go s.readPTYOutput()
	go s.waitProcessExit()

	s.config.logger.Info("Started PTY session", "sessionID", s.ID, "cols", cols, "rows", rows)
	return nil
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

func (s *Session) waitProcessExit() {
	s.mu.RLock()
	cmd := s.Cmd
	ptyFile := s.PTY
	done := s.procWaitDone
	onExit := s.onExit
	sessionID := s.ID
	s.mu.RUnlock()

	if cmd == nil || done == nil {
		return
	}

	err := cmd.Wait()

	s.mu.Lock()
	s.procWaitErr = err
	s.isActive = false
	if ptyFile != nil {
		_ = ptyFile.Close()
		if s.PTY == ptyFile {
			s.PTY = nil
		}
	}
	s.mu.Unlock()

	close(done)

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
	defer s.mu.Unlock()
	s.resizeQueued = false

	if s.cancel != nil {
		s.cancel()
	}

	if s.PTY != nil {
		_ = s.PTY.Close()
		s.PTY = nil
	}

	if s.Cmd != nil && s.Cmd.Process != nil {
		cmd := s.Cmd
		waitDone := s.procWaitDone

		if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
			s.config.logger.Debug("Failed to send SIGTERM", "sessionID", s.ID, "error", err)
		}

		if waitDone != nil {
			s.mu.Unlock()
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
			s.mu.Lock()
		}

		s.Cmd = nil
	}

	for connID := range s.connections {
		delete(s.connections, connID)
	}

	s.isActive = false
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

func (s *Session) readPTYOutput() {
	s.config.logger.Info("Starting PTY output reader", "sessionID", s.ID)

	buffer := make([]byte, 4096)
	for {
		select {
		case <-s.ctx.Done():
			s.config.logger.Info("PTY output reader stopping", "sessionID", s.ID)
			return
		default:
			s.mu.RLock()
			ptyFile := s.PTY
			s.mu.RUnlock()

			if ptyFile == nil {
				s.config.logger.Warn("PTY is nil", "sessionID", s.ID)
				return
			}

			n, err := ptyFile.Read(buffer)
			if err != nil {
				s.config.logger.Debug("PTY read finished", "sessionID", s.ID, "error", err)
				return
			}

			if n > 0 {
				raw := make([]byte, n)
				copy(raw, buffer[:n])
				s.processRawPTYData(raw)
			}
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
