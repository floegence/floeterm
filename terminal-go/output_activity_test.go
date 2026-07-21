package terminal

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type outputActivityCaptureHandler struct {
	mu      sync.Mutex
	updates []TerminalOutputActivityInfo
	session *Session
	reentry chan TerminalOutputActivityInfo
}

type deletingOutputActivityHandler struct {
	manager *Manager
	once    sync.Once
	done    chan error
}

func (h *deletingOutputActivityHandler) OnTerminalData(string, TerminalOutputEvent)           {}
func (h *deletingOutputActivityHandler) OnTerminalNameChanged(string, string, string, string) {}
func (h *deletingOutputActivityHandler) OnTerminalSessionCreated(*Session)                    {}
func (h *deletingOutputActivityHandler) OnTerminalSessionClosed(string)                       {}
func (h *deletingOutputActivityHandler) OnTerminalError(string, error)                        {}
func (h *deletingOutputActivityHandler) OnTerminalOutputActivityChanged(sessionID string, _ TerminalOutputActivityInfo) {
	h.once.Do(func() {
		h.done <- h.manager.DeleteSession(sessionID)
	})
}

func (h *outputActivityCaptureHandler) OnTerminalData(string, TerminalOutputEvent)           {}
func (h *outputActivityCaptureHandler) OnTerminalNameChanged(string, string, string, string) {}
func (h *outputActivityCaptureHandler) OnTerminalSessionCreated(*Session)                    {}
func (h *outputActivityCaptureHandler) OnTerminalSessionClosed(string)                       {}
func (h *outputActivityCaptureHandler) OnTerminalError(string, error)                        {}
func (h *outputActivityCaptureHandler) OnTerminalOutputActivityChanged(_ string, info TerminalOutputActivityInfo) {
	if h.session != nil {
		_ = h.session.ToSessionInfo()
	}
	h.mu.Lock()
	h.updates = append(h.updates, info)
	h.mu.Unlock()
	if h.reentry != nil {
		select {
		case h.reentry <- info:
		default:
		}
	}
}

func (h *outputActivityCaptureHandler) snapshot() []TerminalOutputActivityInfo {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]TerminalOutputActivityInfo(nil), h.updates...)
}

func newOutputActivityTestSession(handler TerminalEventHandler, quiet time.Duration) *Session {
	return &Session{
		ID:                   "session-output-activity",
		Name:                 "repo",
		WorkingDir:           "/workspace/repo",
		CreatedAt:            time.Now(),
		LastActive:           time.Now(),
		connections:          make(map[string]*ConnectionInfo),
		liveAttachments:      make(map[string]liveAttachment),
		ringBuffer:           NewTerminalRingBuffer(32),
		historyGeneration:    1,
		historyStartSequence: 1,
		currentWorkingDir:    "/workspace/repo",
		eventHandler:         handler,
		config: newSessionConfig(ManagerConfig{
			Logger:                      NopLogger{},
			OutputActivityQuietDuration: quiet,
		}),
	}
}

func waitForOutputActivityPhase(t *testing.T, session *Session, want TerminalOutputActivityPhase) TerminalOutputActivityInfo {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		got := session.ToSessionInfo().OutputActivity
		if got.Phase == want {
			return got
		}
		time.Sleep(time.Millisecond)
	}
	got := session.ToSessionInfo().OutputActivity
	t.Fatalf("output activity = %+v, want phase %q", got, want)
	return TerminalOutputActivityInfo{}
}

func TestSessionTracksOutputActivityBoundaries(t *testing.T) {
	handler := &outputActivityCaptureHandler{}
	session := newOutputActivityTestSession(handler, 20*time.Millisecond)
	t.Cleanup(func() { _ = session.Close() })

	session.processRawPTYData([]byte("\x1b]633;B\a\x1b]633;P;FloetermProgram=codex\a\x1b]633;C\ahello"))
	streaming := waitForOutputActivityPhase(t, session, OutputActivityStreaming)
	if streaming.Revision != 1 {
		t.Fatalf("streaming revision = %d, want 1", streaming.Revision)
	}

	settled := waitForOutputActivityPhase(t, session, OutputActivitySettled)
	if settled.Revision != 2 {
		t.Fatalf("settled revision = %d, want 2", settled.Revision)
	}

	session.processRawPTYData([]byte("again"))
	streamingAgain := waitForOutputActivityPhase(t, session, OutputActivityStreaming)
	if streamingAgain.Revision != 3 {
		t.Fatalf("second streaming revision = %d, want 3", streamingAgain.Revision)
	}

	session.processRawPTYData([]byte("\x1b]633;D;0\a\x1b]633;A\a"))
	unknown := waitForOutputActivityPhase(t, session, OutputActivityUnknown)
	if unknown.Revision != 4 {
		t.Fatalf("unknown revision = %d, want 4", unknown.Revision)
	}

	updates := handler.snapshot()
	if len(updates) != 4 {
		t.Fatalf("activity updates = %d, want 4: %+v", len(updates), updates)
	}
}

func TestSessionPublishesStreamingOncePerContinuousBurst(t *testing.T) {
	handler := &outputActivityCaptureHandler{}
	session := newOutputActivityTestSession(handler, time.Hour)
	t.Cleanup(func() { _ = session.Close() })

	session.processRawPTYData([]byte("\x1b]633;B\a\x1b]633;P;FloetermProgram=codex\a\x1b]633;C\afirst"))
	for _, chunk := range []string{"second", "third", "\x1b[32mfourth\x1b[0m"} {
		session.processRawPTYData([]byte(chunk))
	}

	updates := handler.snapshot()
	if len(updates) != 1 || updates[0].Phase != OutputActivityStreaming || updates[0].Revision != 1 {
		t.Fatalf("continuous burst updates = %+v, want one streaming revision", updates)
	}
}

func TestSessionIgnoresMarkerOnlyOutputAndKeepsNewCommandUnknown(t *testing.T) {
	handler := &outputActivityCaptureHandler{}
	session := newOutputActivityTestSession(handler, 15*time.Millisecond)
	t.Cleanup(func() { _ = session.Close() })

	session.processRawPTYData([]byte("\x1b]633;B\a\x1b]633;P;FloetermProgram=codex\a\x1b]633;C\a"))
	time.Sleep(40 * time.Millisecond)
	if got := session.ToSessionInfo().OutputActivity; got.Phase != OutputActivityUnknown || got.Revision != 0 {
		t.Fatalf("marker-only activity = %+v, want unknown revision 0", got)
	}

	session.processRawPTYData([]byte("old text\x1b]633;D;0\a\x1b]633;A\a\x1b]633;B\a\x1b]633;P;FloetermProgram=opencode\a\x1b]633;C\a"))
	if got := session.ToSessionInfo(); got.ForegroundCommand.DisplayName != "opencode" || got.OutputActivity.Phase != OutputActivityUnknown {
		t.Fatalf("new command snapshot = %+v", got)
	}

	session.processRawPTYData([]byte("new text"))
	if got := waitForOutputActivityPhase(t, session, OutputActivityStreaming); got.Revision != 3 {
		t.Fatalf("new command streaming revision = %d, want 3", got.Revision)
	}
}

func TestSessionCloseClearsOutputActivityAndStopsSettlement(t *testing.T) {
	handler := &outputActivityCaptureHandler{}
	session := newOutputActivityTestSession(handler, 20*time.Millisecond)
	session.processRawPTYData([]byte("\x1b]633;B\a\x1b]633;P;FloetermProgram=claude\a\x1b]633;C\ahello"))
	waitForOutputActivityPhase(t, session, OutputActivityStreaming)

	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if got := session.ToSessionInfo().OutputActivity; got.Phase != OutputActivityUnknown {
		t.Fatalf("closed output activity = %+v, want unknown", got)
	}
	for _, update := range handler.snapshot() {
		if update.Phase == OutputActivitySettled {
			t.Fatalf("received stale settled update after close: %+v", update)
		}
	}
}

func TestSessionCloseRejectsAlreadyStartedOutputActivityCallback(t *testing.T) {
	handler := &outputActivityCaptureHandler{}
	session := newOutputActivityTestSession(handler, time.Hour)
	session.processRawPTYData([]byte("\x1b]633;B\a\x1b]633;P;FloetermProgram=claude\a\x1b]633;C\ahello"))
	generation := session.outputActivityGeneration
	commandRevision := session.outputActivityCommandRevision

	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	before := handler.snapshot()
	session.settleOutputActivity(generation, commandRevision)
	after := handler.snapshot()

	if len(after) != len(before) {
		t.Fatalf("stale callback notifications = %+v, want unchanged %+v", after, before)
	}
	for _, update := range after {
		if update.Phase == OutputActivitySettled {
			t.Fatalf("stale callback published settled after close: %+v", update)
		}
	}
}

func TestSessionRejectsStaleOutputActivityCallbackAfterCommandChange(t *testing.T) {
	handler := &outputActivityCaptureHandler{}
	session := newOutputActivityTestSession(handler, time.Hour)
	t.Cleanup(func() { _ = session.Close() })

	session.processRawPTYData([]byte("\x1b]633;B\a\x1b]633;P;FloetermProgram=codex\a\x1b]633;C\aold"))
	oldGeneration := session.outputActivityGeneration
	oldCommandRevision := session.outputActivityCommandRevision

	session.processRawPTYData([]byte("\x1b]633;D;0\a\x1b]633;A\a\x1b]633;B\a\x1b]633;P;FloetermProgram=claude\a\x1b]633;C\anew"))
	before := session.ToSessionInfo().OutputActivity
	if session.outputActivityGeneration == oldGeneration {
		t.Fatalf("activity generation did not advance across command boundary: %d", oldGeneration)
	}

	session.settleOutputActivity(oldGeneration, oldCommandRevision)
	after := session.ToSessionInfo().OutputActivity
	if after != before || after.Phase != OutputActivityStreaming {
		t.Fatalf("stale callback changed current activity: before=%+v after=%+v", before, after)
	}
}

func TestSessionNaturalExitClearsOutputActivityBeforePTYDrain(t *testing.T) {
	handler := &outputActivityCaptureHandler{}
	session := newOutputActivityTestSession(handler, time.Hour)
	t.Cleanup(func() { _ = session.Close() })
	cmd := &exec.Cmd{}
	session.Cmd = cmd
	session.foregroundCommand = TerminalForegroundCommandInfo{
		Phase:       ForegroundCommandRunning,
		DisplayName: "kimi",
		Revision:    1,
	}
	session.observeOutputActivity()

	readerDone := make(chan struct{})
	processDone := make(chan struct{})
	exitDone := make(chan struct{})
	session.waitProcess = func(*exec.Cmd) error { return nil }
	go func() {
		session.waitProcessExit(cmd, nil, readerDone, processDone)
		close(exitDone)
	}()
	select {
	case <-processDone:
	case <-time.After(time.Second):
		t.Fatal("natural exit did not publish its process fence")
	}

	got := session.ToSessionInfo()
	session.mu.RLock()
	timer := session.outputActivityTimer
	deadline := session.outputActivityDeadline
	session.mu.RUnlock()
	if got.OutputActivity.Phase != OutputActivityUnknown || timer != nil || !deadline.IsZero() {
		t.Fatalf("natural exit state during PTY drain = %+v, timer=%v deadline=%v", got.OutputActivity, timer, deadline)
	}
	select {
	case <-exitDone:
		t.Fatal("natural exit unexpectedly completed before the blocked reader drained")
	default:
	}
	close(readerDone)
	select {
	case <-exitDone:
	case <-time.After(time.Second):
		t.Fatal("natural exit did not complete after PTY drain")
	}
}

func TestOutputActivityHandlerMayReenterSession(t *testing.T) {
	handler := &outputActivityCaptureHandler{reentry: make(chan TerminalOutputActivityInfo, 1)}
	session := newOutputActivityTestSession(handler, time.Hour)
	handler.session = session
	t.Cleanup(func() { _ = session.Close() })

	done := make(chan struct{})
	go func() {
		session.processRawPTYData([]byte("\x1b]633;B\a\x1b]633;P;FloetermProgram=opencode\a\x1b]633;C\ahello"))
		close(done)
	}()

	select {
	case <-handler.reentry:
	case <-time.After(time.Second):
		t.Fatal("output handler did not complete a reentrant session read")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("output processing deadlocked in the event handler")
	}
}

func TestOutputActivityHandlerMayDeleteSession(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                      NopLogger{},
		OutputActivityQuietDuration: time.Hour,
	})
	handler := &deletingOutputActivityHandler{manager: manager, done: make(chan error, 1)}
	manager.SetEventHandler(handler)
	session, err := manager.CreateSession("agent", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.deleteSessionIfExists(session.ID) })

	processed := make(chan struct{})
	go func() {
		session.processRawPTYData([]byte("\x1b]633;B\a\x1b]633;P;FloetermProgram=opencode\a\x1b]633;C\ahello"))
		close(processed)
	}()

	select {
	case err := <-handler.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("output handler deadlocked while deleting its session")
	}
	select {
	case <-processed:
	case <-time.After(time.Second):
		t.Fatal("output processing did not return after handler deletion")
	}
	if _, exists := manager.GetSession(session.ID); exists {
		t.Fatal("session still exists after output handler deletion")
	}
}

func TestOutputActivityConcurrentOutputAndClose(t *testing.T) {
	for iteration := 0; iteration < 25; iteration++ {
		handler := &outputActivityCaptureHandler{}
		session := newOutputActivityTestSession(handler, time.Millisecond)
		session.foregroundCommand = TerminalForegroundCommandInfo{
			Phase:       ForegroundCommandRunning,
			DisplayName: "codex",
			Revision:    1,
		}

		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			for index := 0; index < 100; index++ {
				session.observeOutputActivity()
			}
		}()
		go func() {
			defer workers.Done()
			_ = session.Close()
		}()
		workers.Wait()

		if got := session.ToSessionInfo().OutputActivity; got.Phase != OutputActivityUnknown {
			t.Fatalf("iteration %d closed activity = %+v", iteration, got)
		}
	}
}

func TestRealShellOutputActivityMatrix(t *testing.T) {
	for _, shellName := range []string{"bash", "zsh", "fish"} {
		t.Run(shellName, func(t *testing.T) {
			shellPath, err := exec.LookPath(shellName)
			if err != nil {
				if os.Getenv("FLOETERM_REQUIRE_REAL_SHELL_MATRIX") == "1" {
					t.Fatalf("required shell %s unavailable: %v", shellName, err)
				}
				t.Skipf("%s unavailable: %v", shellName, err)
			}

			homeDir := t.TempDir()
			t.Setenv("HOME", homeDir)
			binDir := t.TempDir()
			agentPath := filepath.Join(binDir, "codex")
			if err := os.WriteFile(agentPath, []byte("#!/bin/sh\nprintf '__FLOETERM_FIRST__'\nsleep 0.3\nprintf '__FLOETERM_SECOND__'\nsleep 0.3\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			initDir := t.TempDir()
			manager := NewManager(ManagerConfig{
				Logger:        NopLogger{},
				EnvProvider:   StaticEnvProvider{Env: os.Environ(), PathPrepend: binDir},
				ShellResolver: testShellResolver{shell: shellPath},
				ShellArgsProvider: DefaultShellArgsProvider{
					ShellInitBaseDir:       initDir,
					EnableCommandLifecycle: true,
				},
				ShellInitWriter: DefaultShellInitWriter{
					BaseDir:                initDir,
					EnableCommandLifecycle: true,
				},
				OutputActivityQuietDuration: 80 * time.Millisecond,
			})
			session, err := manager.CreateSession("agent", homeDir)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = manager.DeleteSession(session.ID) })
			if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
				t.Fatal(err)
			}

			waitForSessionSnapshot(t, session, 5*time.Second, func(info TerminalSessionInfo) bool {
				return info.ForegroundCommand.Phase == ForegroundCommandIdle
			}, "initial shell prompt")
			if err := session.WriteData("codex\n"); err != nil {
				t.Fatal(err)
			}
			waitForSessionSnapshot(t, session, 5*time.Second, func(info TerminalSessionInfo) bool {
				return info.ForegroundCommand.Phase == ForegroundCommandRunning &&
					info.ForegroundCommand.DisplayName == "codex" &&
					info.OutputActivity.Phase == OutputActivityStreaming
			}, "recognized agent output streaming")
			firstSettled := waitForSessionSnapshot(t, session, 2*time.Second, func(info TerminalSessionInfo) bool {
				return info.ForegroundCommand.Phase == ForegroundCommandRunning &&
					info.OutputActivity.Phase == OutputActivitySettled
			}, "first output quiet boundary")
			waitForSessionSnapshot(t, session, 2*time.Second, func(info TerminalSessionInfo) bool {
				return info.OutputActivity.Phase == OutputActivityStreaming &&
					info.OutputActivity.Revision > firstSettled.OutputActivity.Revision
			}, "second output streaming boundary")
			waitForSessionSnapshot(t, session, 2*time.Second, func(info TerminalSessionInfo) bool {
				return info.OutputActivity.Phase == OutputActivitySettled &&
					info.OutputActivity.Revision > firstSettled.OutputActivity.Revision
			}, "second output quiet boundary")
			waitForSessionSnapshot(t, session, 2*time.Second, func(info TerminalSessionInfo) bool {
				return info.ForegroundCommand.Phase == ForegroundCommandIdle &&
					info.OutputActivity.Phase == OutputActivityUnknown
			}, "command completion reset")
		})
	}
}

func waitForSessionSnapshot(
	t *testing.T,
	session *Session,
	timeout time.Duration,
	accept func(TerminalSessionInfo) bool,
	description string,
) TerminalSessionInfo {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		info := session.ToSessionInfo()
		if accept(info) {
			return info
		}
		time.Sleep(time.Millisecond)
	}
	got := session.ToSessionInfo()
	t.Fatalf("timeout waiting for %s: %+v", description, got)
	return TerminalSessionInfo{}
}
