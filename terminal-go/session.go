package terminal

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

var errSessionClosed = errors.New("session is closed")

const naturalExitPTYDrainTimeout = 500 * time.Millisecond

// Keep PTY reads flowing while the ordered commit path synchronizes durable
// history. Each queued packet retains its independently captured geometry, and
// the fixed capacity provides bounded backpressure instead of dropping output.
const ptyReadQueueCapacity = 2048

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

func removeEnvKey(env []string, key string) []string {
	prefix := key + "="
	filtered := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, prefix) {
			filtered = append(filtered, entry)
		}
	}
	return filtered
}

func mergeShellLifecycleEnvironment(env, shellEnv []string) []string {
	for _, key := range []string{shellLifecycleNonceEnvKey, shellLifecycleNonceVarKey, shellLifecycleCaptureKey, shellLifecycleLoadedKey} {
		env = removeEnvKey(env, key)
		shellEnv = removeEnvKey(shellEnv, key)
	}
	for _, entry := range shellEnv {
		if key, _, ok := strings.Cut(entry, "="); ok && key != "" {
			env = removeEnvKey(env, key)
		}
	}
	env = append(env, shellEnv...)
	return env
}

func applyTerminalEnvironment(env []string, terminalEnv TerminalEnv, cols, rows int) []string {
	ownedKeys := []string{
		"TERM",
		"COLORTERM",
		"NO_COLOR",
		"LANG",
		"LC_ALL",
		"TERM_PROGRAM",
		"TERM_PROGRAM_VERSION",
		"COLUMNS",
		"LINES",
		"PROMPT_EOL_MARK",
		"TERMINFO",
		"TERM_FEATURES",
	}
	for _, key := range ownedKeys {
		env = removeEnvKey(env, key)
	}
	env = append(env,
		"TERM="+terminalEnv.Term,
		"COLORTERM="+terminalEnv.ColorTerm,
		"LANG="+terminalEnv.Lang,
		"LC_ALL="+terminalEnv.LcAll,
		"TERM_PROGRAM="+terminalEnv.TermProgram,
		"TERM_PROGRAM_VERSION="+terminalEnv.TermProgramVersion,
		"COLUMNS="+fmt.Sprintf("%d", cols),
		"LINES="+fmt.Sprintf("%d", rows),
		"PROMPT_EOL_MARK=",
		"TERMINFO="+terminalEnv.Terminfo,
		"TERM_FEATURES="+terminalEnv.TermFeatures,
	)
	if terminalEnv.DisableColor {
		env = append(env, "NO_COLOR=1")
	}
	return env
}

type authenticatedShellArgsProvider interface {
	prepareAuthenticatedShellArgsContext(context.Context, string, string, bool) ([]string, []string, *shellLifecycleBootstrap, string, error)
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

func sessionShellArgsForActivation(
	ctx context.Context,
	provider ShellArgsProvider,
	shell string,
	pathPrepend string,
	requestAuthentication bool,
) ([]string, []string, *shellLifecycleBootstrap, string, error) {
	if authenticated, ok := provider.(authenticatedShellArgsProvider); ok {
		return authenticated.prepareAuthenticatedShellArgsContext(ctx, shell, pathPrepend, requestAuthentication)
	}
	args, env, err := shellArgsForActivation(ctx, provider, shell, pathPrepend)
	return args, env, nil, "", err
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
	shellInitReady := false
	if shouldEnsureShellInit && s.config.shellInitWriter != nil {
		if err := ensureShellInitForActivation(activation.ctx, s.config.shellInitWriter, pathPrepend); err != nil {
			if sessionContextDone(activation.ctx) {
				return errSessionClosed
			}
			s.config.logger.Warn("Failed to ensure shell init files", "error", err)
		} else {
			shellInitReady = true
		}
	}

	var shellArgs, shellEnv []string
	var bootstrap *shellLifecycleBootstrap
	var lifecycleNonce string
	if s.config.shellLifecycleAuthEnabled && !shellInitReady {
		s.config.logger.Warn("Shell integration initialization failed; using login shell")
	} else {
		shellArgs, shellEnv, bootstrap, lifecycleNonce, err = sessionShellArgsForActivation(
			activation.ctx,
			s.config.shellArgsProvider,
			shell,
			pathPrepend,
			s.config.shellLifecycleAuthEnabled,
		)
	}
	if err != nil {
		if sessionContextDone(activation.ctx) {
			return errSessionClosed
		}
		if _, authenticated := s.config.shellArgsProvider.(authenticatedShellArgsProvider); !authenticated {
			return fmt.Errorf("failed to build shell arguments: %w", err)
		}
		s.config.logger.Warn("Authenticated shell integration unavailable; using login shell", "error", err)
		shellArgs = nil
		shellEnv = nil
		lifecycleNonce = ""
	}
	if bootstrap != nil {
		defer func() { bootstrap.cleanup() }()
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

	env = mergeShellLifecycleEnvironment(env, shellEnv)
	s.mu.Lock()
	s.shellLifecycleNonce = ""
	s.shellLifecycleAuthState = shellLifecycleAuthLegacy
	s.mu.Unlock()
	env = applyTerminalEnvironment(env, s.config.terminalEnv, cols, rows)
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
	outputMonitor, err := newPTYOutputMonitor(ptmx)
	if err != nil {
		s.closeUnclaimedPTY(cmd, ptmx)
		return fmt.Errorf("failed to initialize PTY output monitor: %w", err)
	}

	s.mu.Lock()
	if s.activation != activation || s.closed || sessionContextDone(activation.ctx) || s.isActive {
		active := s.isActive
		s.mu.Unlock()
		_ = outputMonitor.Close()
		s.closeUnclaimedPTY(cmd, ptmx)
		if active {
			return nil
		}
		return errSessionClosed
	}
	s.PTY = ptmx
	s.Cmd = cmd
	s.shellLifecycleBootstrap = bootstrap
	s.shellLifecycleNonce = lifecycleNonce
	if bootstrap != nil {
		s.shellLifecycleAuthState = shellLifecycleAuthPending
	}
	bootstrap = nil
	s.isActive = true
	s.lastAppliedCols = cols
	s.lastAppliedRows = rows
	if s.geometryGeneration == 0 {
		s.geometryGeneration = 1
	} else {
		s.geometryGeneration++
	}
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
	go s.readPTYOutput(ptmx, outputMonitor, done, readerDone)
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
	_, _ = s.resetOutputActivityLocked(time.Now())
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
		s.clearForegroundCommandLocked()
	}
	if ptyFile != nil {
		_ = ptyFile.Close()
		if s.PTY == ptyFile {
			s.PTY = nil
		}
	}
	onExit := s.onExit
	sessionID := s.ID
	bootstraps := s.takeShellLifecycleBootstrapsLocked()
	s.mu.Unlock()
	cleanupShellLifecycleBootstraps(bootstraps)

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
	s.historyCommitMu.Lock()
	s.mu.Lock()
	if s.cleaned {
		s.mu.Unlock()
		s.historyCommitMu.Unlock()
		return
	}
	s.cleaned = true
	s.closed = true
	s.outputClosed = true
	s.resizeQueued = false
	s.resizeRunning = false

	if s.cancel != nil {
		s.cancel()
	}
	activation := s.activation
	s.activation = nil
	ptyFile := s.PTY
	cmd := s.Cmd
	historySpool := s.historySpool
	waitDone := s.procWaitDone
	bootstraps := s.takeShellLifecycleBootstrapsLocked()
	s.PTY = nil
	s.Cmd = nil
	s.historySpool = nil
	s.isActive = false
	s.clearForegroundCommandLocked()

	for connID := range s.connections {
		delete(s.connections, connID)
	}
	liveSubscribers := s.detachLiveSubscribersForClose()
	s.mu.Unlock()
	s.historyCommitMu.Unlock()
	cleanupShellLifecycleBootstraps(bootstraps)

	activation.complete(errSessionClosed)
	for _, subscriber := range liveSubscribers {
		if subscriber.OnSessionClosed != nil {
			subscriber.OnSessionClosed()
		}
	}
	if ptyFile != nil {
		_ = ptyFile.Close()
	}
	if historySpool != nil {
		if err := historySpool.Close(); err != nil {
			s.config.logger.Warn("Failed to close terminal history spool", "sessionID", s.ID, "error", err)
		}
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

func (s *Session) takeShellLifecycleBootstrapsLocked() []*shellLifecycleBootstrap {
	bootstraps := make([]*shellLifecycleBootstrap, 0, 2)
	if s.shellLifecycleBootstrap != nil {
		bootstraps = append(bootstraps, s.shellLifecycleBootstrap)
		s.shellLifecycleBootstrap = nil
	}
	if s.shellLifecycleBootstrapStale != nil {
		bootstraps = append(bootstraps, s.shellLifecycleBootstrapStale)
		s.shellLifecycleBootstrapStale = nil
	}
	return bootstraps
}

func cleanupShellLifecycleBootstraps(bootstraps []*shellLifecycleBootstrap) {
	for _, bootstrap := range bootstraps {
		bootstrap.cleanup()
	}
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
	if s.historySpoolErr != nil {
		return HistoryPage{}, fmt.Errorf("terminal history durability failed: %w", s.historySpoolErr)
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
	useDurableHistory := effectiveStart <= snapshotEnd && page.FirstRetainedSequence > effectiveStart
	if !useDurableHistory && s.historySpool != nil && effectiveStart <= snapshotEnd {
		checkpoint, err := s.historySpool.Checkpoint()
		if err != nil {
			return HistoryPage{}, fmt.Errorf("read terminal history checkpoint: %w", err)
		}
		useDurableHistory = checkpoint != nil && effectiveStart <= checkpoint.CoveredThroughSequence
	}
	if useDurableHistory {
		if s.historySpool == nil {
			page.HistoryTruncated = true
		} else {
			durablePage, err := s.readDurableHistoryPageLocked(options, effectiveStart, snapshotEnd)
			if err != nil {
				return HistoryPage{}, err
			}
			page = durablePage
		}
	}
	if len(page.Chunks) > 0 && s.config.historyFilter != nil {
		page.Chunks = s.config.historyFilter.Filter(page.Chunks)
	}

	return page, nil
}

func (s *Session) readDurableHistoryPageLocked(options HistoryPageOptions, startSequence, snapshotEnd int64) (HistoryPage, error) {
	if s.historySpool == nil {
		return HistoryPage{}, fmt.Errorf("terminal history spool is not initialized")
	}
	checkpoint, err := s.historySpool.Checkpoint()
	if err != nil {
		return HistoryPage{}, fmt.Errorf("read terminal history checkpoint: %w", err)
	}
	deltaStart := startSequence
	historyTruncated := false
	if checkpoint != nil && startSequence <= checkpoint.CoveredThroughSequence {
		deltaStart = checkpoint.CoveredThroughSequence + 1
		historyTruncated = true
	}
	chunks := []TerminalDataChunk{}
	if deltaStart <= snapshotEnd {
		chunks, err = s.historySpool.ReadChunks(deltaStart, snapshotEnd)
		if err != nil {
			return HistoryPage{}, fmt.Errorf("read terminal history spool: %w", err)
		}
	}
	snapshot := s.historySpool.Snapshot()
	firstRetained := snapshot.FirstSequence
	if firstRetained == 0 {
		firstRetained = deltaStart
	}
	page := HistoryPage{
		Chunks:                 make([]TerminalDataChunk, 0, len(chunks)),
		Checkpoint:             checkpoint,
		DeltaStartSequence:     deltaStart,
		FirstRetainedSequence:  firstRetained,
		SnapshotEndSequence:    snapshotEnd,
		HistoryGeneration:      s.historyGeneration,
		HistoryTruncated:       historyTruncated,
		TotalBytes:             snapshot.RawBytes,
		UsedChunks:             len(chunks),
		CoveredThroughSequence: snapshotEnd,
	}
	for _, chunk := range chunks {
		if options.LimitChunks > 0 && len(page.Chunks) >= options.LimitChunks {
			page.HasMore = true
			page.NextStartSeq = chunk.Sequence
			break
		}
		chunkBytes := len(chunk.Data)
		if options.MaxBytes > 0 && len(page.Chunks) > 0 && page.CoveredBytes+int64(chunkBytes) > int64(options.MaxBytes) {
			page.HasMore = true
			page.NextStartSeq = chunk.Sequence
			break
		}
		page.Chunks = append(page.Chunks, chunk)
		page.CoveredBytes += int64(chunkBytes)
		if page.FirstSequence == 0 {
			page.FirstSequence = chunk.Sequence
		}
		page.LastSequence = chunk.Sequence
	}
	if page.HasMore {
		page.CoveredThroughSequence = page.NextStartSeq - 1
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

// CommitHistoryCheckpoint publishes a checkpoint only after the durable spool
// validates its sequence, geometry, digest, and blob checksum.
func (s *Session) CommitHistoryCheckpoint(checkpoint TerminalHistoryCheckpoint) error {
	s.historyCommitMu.Lock()
	defer s.historyCommitMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.historySpoolErr != nil {
		return fmt.Errorf("terminal history durability failed: %w", s.historySpoolErr)
	}
	if s.historySpool == nil {
		return fmt.Errorf("terminal history spool is not configured")
	}
	if checkpoint.CoveredThroughSequence > s.committedSequence {
		return fmt.Errorf("terminal history checkpoint exceeds committed output")
	}
	if checkpoint.ParserEpoch != uint64(s.historyGeneration) {
		return fmt.Errorf("terminal history checkpoint parser epoch does not match history generation")
	}
	if err := s.historySpool.CommitCheckpoint(checkpoint); err != nil {
		return fmt.Errorf("commit terminal history checkpoint: %w", err)
	}
	return nil
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
	s.historyCommitMu.Lock()
	defer s.historyCommitMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ringBuffer != nil {
		s.ringBuffer.Clear()
	}
	if s.historySpool != nil {
		if err := s.historySpool.Reset(s.committedSequence); err != nil {
			s.historySpoolErr = err
			return fmt.Errorf("clear terminal history spool: %w", err)
		}
		s.historySpoolErr = nil
	}
	s.historyGeneration++
	if s.historyGeneration <= 0 {
		s.historyGeneration = 1
	}
	s.historyStartSequence = s.committedSequence + 1

	s.config.logger.Info("Terminal history cleared", "sessionID", s.ID)
	return nil
}

// broadcastData sends committed output without holding session locks.
func (s *Session) broadcastData(event TerminalOutputEvent, subscribers []LiveSubscriber) {
	// Never call external handlers while holding session locks. Handlers may
	// synchronously call back into this Session/Manager and would deadlock.
	s.mu.RLock()
	handler := s.eventHandler
	sessionID := s.ID
	s.mu.RUnlock()

	if handler != nil {
		handler.OnTerminalData(sessionID, event)
	}
	for _, subscriber := range subscribers {
		if subscriber.OnOutput != nil {
			subscriber.OnOutput(event)
		}
	}
}

func (s *Session) readPTYOutput(
	ptyFile *os.File,
	monitor ptyOutputMonitor,
	processDone <-chan struct{},
	done chan struct{},
) {
	if done != nil {
		defer close(done)
	}
	s.config.logger.Info("Starting PTY output reader", "sessionID", s.ID)

	if ptyFile == nil {
		s.config.logger.Warn("PTY is nil", "sessionID", s.ID)
		return
	}
	if monitor == nil {
		s.config.logger.Error("PTY output monitor is nil", "sessionID", s.ID)
		return
	}
	monitorWatcherDone := make(chan struct{})
	if processDone != nil {
		go func() {
			select {
			case <-processDone:
				_ = monitor.Close()
			case <-monitorWatcherDone:
			}
		}()
	}
	defer close(monitorWatcherDone)
	defer monitor.Close()

	reads := make(chan ptyReadResult, ptyReadQueueCapacity)
	go readPTYPacketsWithPendingGeometry(
		ptyFile,
		reads,
		monitor.PendingBytes,
		processDone,
		s.captureTerminalGeometry,
	)
	buffer := make([]byte, 32*1024)
	var pending *ptyReadResult
	for {
		var first ptyReadResult
		if pending != nil {
			first = *pending
			pending = nil
		} else {
			var ok bool
			first, ok = <-reads
			if !ok {
				return
			}
		}

		n, nextPending, geometry, err := collectAvailablePTYBurst(first, reads, buffer)
		pending = nextPending
		if n > 0 {
			raw := append([]byte(nil), buffer[:n]...)
			s.processRawPTYDataAtGeometry(raw, geometry)
		}
		if err != nil {
			if tail := s.flushPrivateShellLifecycleFilter(); len(tail) > 0 {
				s.publishPTYDisplayData(tail)
			}
			s.config.logger.Debug("PTY read finished", "sessionID", s.ID, "error", err)
			return
		}
	}
}

type ptyReadResult struct {
	data     []byte
	err      error
	geometry TerminalGeometry
}

func readPTYPackets(reader io.Reader, reads chan<- ptyReadResult) {
	readPTYPacketsWithPending(reader, reads, func() (int, error) { return 0, nil }, nil)
}

func readPTYPacketsWithPending(
	reader io.Reader,
	reads chan<- ptyReadResult,
	pendingBytes func() (int, error),
	processDone <-chan struct{},
) {
	readPTYPacketsWithPendingGeometry(reader, reads, pendingBytes, processDone, nil)
}

func readPTYPacketsWithPendingGeometry(
	reader io.Reader,
	reads chan<- ptyReadResult,
	pendingBytes func() (int, error),
	processDone <-chan struct{},
	captureGeometry func() TerminalGeometry,
) {
	defer close(reads)
	buffer := make([]byte, 32*1024)
	coalesce := false
	for {
		n, err := reader.Read(buffer)
		total := n
		morePending := false
		if total > 0 && err == nil {
			if coalesce && captureGeometry == nil {
				for total < len(buffer) {
					available, availableErr := currentPendingBytes(pendingBytes, processDone)
					if availableErr != nil {
						err = availableErr
						break
					}
					if available <= 0 {
						break
					}
					readSize := min(available, len(buffer)-total)
					read, readErr := reader.Read(buffer[total : total+readSize])
					total += read
					if readErr != nil {
						err = readErr
						break
					}
					if read == 0 {
						err = io.ErrNoProgress
						break
					}
				}
			}
			if err == nil {
				available, availableErr := currentPendingBytes(pendingBytes, processDone)
				if availableErr != nil {
					err = availableErr
				} else {
					morePending = available > 0
				}
			}
		}
		if total > 0 {
			var geometry TerminalGeometry
			if captureGeometry != nil {
				geometry = captureGeometry()
			}
			reads <- ptyReadResult{
				data:     append([]byte(nil), buffer[:total]...),
				err:      err,
				geometry: geometry,
			}
		} else if err != nil {
			reads <- ptyReadResult{err: err}
		} else {
			reads <- ptyReadResult{err: io.ErrNoProgress}
			return
		}
		if err != nil {
			return
		}
		coalesce = morePending
	}
}

func currentPendingBytes(
	pendingBytes func() (int, error),
	processDone <-chan struct{},
) (int, error) {
	available, err := pendingBytes()
	if err == nil {
		return available, nil
	}
	if processDone != nil {
		select {
		case <-processDone:
			return 0, nil
		default:
		}
	}
	return 0, err
}

type ptyOutputMonitor interface {
	PendingBytes() (int, error)
	Close() error
}

func collectAvailablePTYBurst(
	first ptyReadResult,
	reads <-chan ptyReadResult,
	buffer []byte,
) (int, *ptyReadResult, TerminalGeometry, error) {
	total := 0
	current := first
	geometry := first.geometry
	for {
		if current.geometry != geometry {
			return total, &current, geometry, nil
		}
		if len(current.data) > 0 {
			n := copy(buffer[total:], current.data)
			total += n
			if n < len(current.data) {
				current.data = current.data[n:]
				return total, &current, geometry, nil
			}
		}
		if current.err != nil {
			return total, nil, geometry, current.err
		}
		if total == len(buffer) {
			return total, nil, geometry, nil
		}

		select {
		case next, ok := <-reads:
			if !ok {
				return total, nil, geometry, io.EOF
			}
			current = next
		default:
			return total, nil, geometry, nil
		}
	}
}

func (s *Session) captureTerminalGeometry() TerminalGeometry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.effectiveGeometryLocked()
}

func (s *Session) processRawPTYData(data []byte) {
	s.processRawPTYDataAtGeometry(data, s.captureTerminalGeometry())
}

func (s *Session) processRawPTYDataAtGeometry(data []byte, geometry TerminalGeometry) {
	displayData := s.filterPrivateShellLifecycleMarkers(data)
	s.publishPTYDisplayDataAtGeometry(displayData, geometry)
	s.checkShellIntegrationChange(data)
}

func (s *Session) publishPTYDisplayData(displayData []byte) {
	s.publishPTYDisplayDataAtGeometry(displayData, s.captureTerminalGeometry())
}

func (s *Session) publishPTYDisplayDataAtGeometry(displayData []byte, geometry TerminalGeometry) {
	timestamp := time.Now().UnixMilli()

	if len(displayData) > 0 {
		s.historyCommitMu.Lock()

		s.mu.Lock()
		if s.outputClosed {
			s.mu.Unlock()
			s.historyCommitMu.Unlock()
			return
		}
		s.sequenceNumber++
		seqNum := s.sequenceNumber
		s.LastActive = time.Now()
		if geometry.Generation == 0 || geometry.Cols <= 0 || geometry.Rows <= 0 {
			geometry = s.effectiveGeometryLocked()
		}

		chunk := TerminalDataChunk{
			Sequence:           seqNum,
			Data:               displayData,
			Timestamp:          timestamp,
			Size:               len(displayData),
			GeometryGeneration: geometry.Generation,
			Cols:               geometry.Cols,
			Rows:               geometry.Rows,
		}
		historySpool := s.historySpool
		historySpoolReady := s.historySpoolErr == nil
		ringBuffer := s.ringBuffer
		s.mu.Unlock()

		durableCommitted := false
		if historySpool != nil && historySpoolReady {
			if err := historySpool.Append(chunk); err != nil {
				s.mu.Lock()
				if s.historySpool == historySpool && s.historySpoolErr == nil {
					s.historySpoolErr = err
				}
				s.mu.Unlock()
				s.config.logger.Error("Failed to append terminal history spool", "sessionID", s.ID, "error", err)
			} else {
				durableCommitted = true
			}
		}
		ringCommitted := false
		historyCommitAllowed := historySpool == nil || durableCommitted
		if ringBuffer != nil && historyCommitAllowed {
			if err := ringBuffer.writeOwnedWithSequenceAndGeometry(
				displayData,
				seqNum,
				timestamp,
				false,
				geometry.Generation,
				geometry.Cols,
				geometry.Rows,
			); err != nil {
				s.config.logger.Error("Failed to write to ring buffer", "sessionID", s.ID, "error", err)
			} else {
				ringCommitted = true
			}
		}

		s.mu.Lock()
		if durableCommitted || ringCommitted {
			s.committedSequence = seqNum
		}
		subscribers := make([]LiveSubscriber, 0, len(s.liveAttachments))
		for _, attachment := range s.liveAttachments {
			subscribers = append(subscribers, attachment.subscriber)
		}
		s.mu.Unlock()
		s.historyCommitMu.Unlock()

		s.broadcastData(TerminalOutputEvent{
			Data:        displayData,
			Sequence:    seqNum,
			TimestampMs: timestamp,
			Geometry:    geometry,
		}, subscribers)
	}

}

// WriteDataWithSource writes each accepted input exactly once to the PTY.
func (s *Session) WriteDataWithSource(data []byte, sourceConnID string) error {
	_ = sourceConnID
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.PTY == nil {
		return fmt.Errorf("PTY not available")
	}

	if _, err := s.PTY.Write(data); err != nil {
		s.config.logger.Error("Failed to write to PTY", "sessionID", s.ID, "error", err)
		return err
	}

	s.LastActive = time.Now()

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
