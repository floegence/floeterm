package terminal

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/creack/pty"
)

type blockingLegacyEnvProvider struct {
	entered  chan struct{}
	release  chan struct{}
	finished chan struct{}
	once     sync.Once
	calls    atomic.Int32
}

func newBlockingLegacyEnvProvider() *blockingLegacyEnvProvider {
	return &blockingLegacyEnvProvider{
		entered:  make(chan struct{}),
		release:  make(chan struct{}),
		finished: make(chan struct{}),
	}
}

func (p *blockingLegacyEnvProvider) BuildEnv(string, string) ([]string, string, error) {
	p.calls.Add(1)
	p.once.Do(func() { close(p.entered) })
	<-p.release
	close(p.finished)
	return os.Environ(), "", nil
}

type blockingContextEnvProvider struct {
	entered  chan struct{}
	canceled chan struct{}
	once     sync.Once
}

type tailOutputShellArgsProvider struct{}

func (tailOutputShellArgsProvider) GetShellArgs(string, string) ([]string, []string) {
	return []string{"-c", "printf 'floeterm-tail-marker\\n'; exit 0"}, nil
}

type blockingNaturalExitDataHandler struct {
	reaped  <-chan struct{}
	entered chan struct{}
	release <-chan struct{}
	once    sync.Once
}

func (h *blockingNaturalExitDataHandler) OnTerminalData(string, TerminalOutputEvent) {
	h.once.Do(func() {
		<-h.reaped
		close(h.entered)
		<-h.release
	})
}

func (h *blockingNaturalExitDataHandler) OnTerminalNameChanged(string, string, string, string) {}
func (h *blockingNaturalExitDataHandler) OnTerminalSessionCreated(*Session)                    {}
func (h *blockingNaturalExitDataHandler) OnTerminalSessionClosed(string)                       {}
func (h *blockingNaturalExitDataHandler) OnTerminalError(string, error)                        {}

func (p *blockingContextEnvProvider) BuildEnv(string, string) ([]string, string, error) {
	return os.Environ(), "", nil
}

func (p *blockingContextEnvProvider) BuildEnvContext(ctx context.Context, _ string, _ string) ([]string, string, error) {
	p.once.Do(func() { close(p.entered) })
	<-ctx.Done()
	close(p.canceled)
	return nil, "", ctx.Err()
}

func TestManagerActivateSessionDoesNotDeadlock(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                        NopLogger{},
		ShellResolver:                 testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider:             testShellArgsProvider{},
		InitialResizeSuppressDuration: time.Millisecond,
	})

	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		done <- manager.ActivateSession(session.ID, 80, 24)
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("ActivateSession failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("ActivateSession appears to be deadlocked")
	}

	if !session.IsActive() {
		t.Fatalf("expected session to be active after ActivateSession")
	}
	if session.PTY == nil || session.Cmd == nil {
		t.Fatalf("expected PTY/Cmd to be initialized")
	}

	if err := manager.DeleteSession(session.ID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
}

func TestActivateSessionContextSharesActivationAfterCallerCancellation(t *testing.T) {
	provider := newBlockingLegacyEnvProvider()
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		EnvProvider:       provider,
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	})

	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() {
		first <- manager.ActivateSessionContext(ctx, session.ID, 80, 24)
	}()
	<-provider.entered
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled activation error = %v, want context.Canceled", err)
	}

	second := make(chan error, 1)
	go func() {
		second <- manager.ActivateSessionContext(context.Background(), session.ID, 100, 30)
	}()
	select {
	case err := <-second:
		t.Fatalf("shared activation completed before provider release: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	close(provider.release)
	if err := <-second; err != nil {
		t.Fatalf("shared activation failed: %v", err)
	}
	if got := provider.calls.Load(); got != 1 {
		t.Fatalf("BuildEnv calls = %d, want 1", got)
	}
	if err := manager.DeleteSession(session.ID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
}

func TestConcurrentActivateSessionCallsShareOneLaunch(t *testing.T) {
	provider := newBlockingLegacyEnvProvider()
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		EnvProvider:       provider,
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	})

	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	const callers = 32
	results := make(chan error, callers)
	for range callers {
		go func() {
			results <- manager.ActivateSessionContext(context.Background(), session.ID, 80, 24)
		}()
	}
	<-provider.entered
	if got := provider.calls.Load(); got != 1 {
		t.Fatalf("BuildEnv calls before release = %d, want 1", got)
	}
	close(provider.release)
	for range callers {
		if err := <-results; err != nil {
			t.Fatalf("shared activation failed: %v", err)
		}
	}
	if got := provider.calls.Load(); got != 1 {
		t.Fatalf("BuildEnv calls = %d, want 1", got)
	}
	if err := manager.DeleteSession(session.ID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
}

func TestDeleteSessionDoesNotWaitForLegacyActivationProvider(t *testing.T) {
	provider := newBlockingLegacyEnvProvider()
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		EnvProvider:       provider,
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	})

	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	activation := make(chan error, 1)
	go func() {
		activation <- manager.ActivateSessionContext(context.Background(), session.ID, 80, 24)
	}()
	<-provider.entered

	deleted := make(chan error, 1)
	go func() { deleted <- manager.DeleteSession(session.ID) }()
	select {
	case err := <-deleted:
		if err != nil {
			t.Fatalf("DeleteSession failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("DeleteSession waited for a legacy activation provider")
	}
	select {
	case err := <-activation:
		if !errors.Is(err, errSessionClosed) {
			t.Fatalf("activation error = %v, want session closed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("activation waiter remained blocked after delete")
	}

	close(provider.release)
	select {
	case <-provider.finished:
	case <-time.After(time.Second):
		t.Fatal("legacy activation worker did not finish after provider release")
	}
	if session.IsActive() || session.PTY != nil || session.Cmd != nil {
		t.Fatal("late activation result revived a deleted session")
	}
}

func TestDeleteSessionCancelsContextActivationProvider(t *testing.T) {
	provider := &blockingContextEnvProvider{
		entered:  make(chan struct{}),
		canceled: make(chan struct{}),
	}
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		EnvProvider:       provider,
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	})

	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	activation := make(chan error, 1)
	go func() {
		activation <- manager.ActivateSessionContext(context.Background(), session.ID, 80, 24)
	}()
	<-provider.entered

	if err := manager.DeleteSession(session.ID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
	select {
	case <-provider.canceled:
	case <-time.After(time.Second):
		t.Fatal("context environment provider did not observe session cancellation")
	}
	if err := <-activation; !errors.Is(err, errSessionClosed) {
		t.Fatalf("activation error = %v, want session closed", err)
	}
}

func TestCleanupDoesNotWaitForBlockedPTYStarter(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	})
	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	session.startPTYProcess = func(*exec.Cmd, *pty.Winsize) (*os.File, error) {
		close(started)
		<-release
		close(finished)
		return nil, errors.New("starter released")
	}
	activation := make(chan error, 1)
	go func() {
		activation <- manager.ActivateSessionContext(context.Background(), session.ID, 80, 24)
	}()
	<-started

	cleaned := make(chan struct{})
	go func() {
		manager.Cleanup()
		close(cleaned)
	}()
	select {
	case <-cleaned:
	case <-time.After(time.Second):
		t.Fatal("Cleanup waited for a blocked PTY starter")
	}
	if err := <-activation; !errors.Is(err, errSessionClosed) {
		t.Fatalf("activation error = %v, want session closed", err)
	}

	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("PTY starter did not finish after release")
	}
	if session.IsActive() || session.PTY != nil || session.Cmd != nil {
		t.Fatal("late PTY starter result revived a cleaned session")
	}
}

func TestNaturalExitRejectsReactivationBeforeCloseCallbackReturns(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: quickExitShellArgsProvider{},
	})
	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	var starts atomic.Int32
	session.startPTYProcess = func(cmd *exec.Cmd, size *pty.Winsize) (*os.File, error) {
		starts.Add(1)
		return pty.StartWithSize(cmd, size)
	}
	onExitEntered := make(chan struct{})
	releaseOnExit := make(chan struct{})
	session.mu.Lock()
	session.onExit = func(string) {
		close(onExitEntered)
		<-releaseOnExit
	}
	session.mu.Unlock()

	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatalf("ActivateSession failed: %v", err)
	}
	select {
	case <-onExitEntered:
	case <-time.After(time.Second):
		t.Fatal("natural exit callback did not start")
	}
	if err := manager.ActivateSessionContext(context.Background(), session.ID, 100, 30); !errors.Is(err, errSessionClosed) {
		t.Fatalf("reactivation error = %v, want session closed", err)
	}
	if got := starts.Load(); got != 1 {
		t.Fatalf("PTY starts = %d, want 1", got)
	}
	close(releaseOnExit)
	if err := manager.DeleteSession(session.ID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
}

func TestNaturalExitRejectsReactivationWhilePTYOutputIsDraining(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: tailOutputShellArgsProvider{},
	})
	reaped := make(chan struct{})
	releaseReader := make(chan struct{})
	handler := &blockingNaturalExitDataHandler{
		reaped:  reaped,
		entered: make(chan struct{}),
		release: releaseReader,
	}
	manager.SetEventHandler(handler)

	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	session.waitProcess = func(cmd *exec.Cmd) error {
		err := cmd.Wait()
		close(reaped)
		return err
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatalf("ActivateSession failed: %v", err)
	}

	select {
	case <-handler.entered:
	case <-time.After(time.Second):
		t.Fatal("PTY reader did not enter the blocked drain window")
	}
	deadline := time.Now().Add(time.Second)
	for {
		session.mu.RLock()
		closed := session.closed
		active := session.isActive
		session.mu.RUnlock()
		if closed && active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("session did not enter the closed-but-draining state")
		}
		time.Sleep(time.Millisecond)
	}

	if err := manager.ActivateSessionContext(context.Background(), session.ID, 100, 30); !errors.Is(err, errSessionClosed) {
		t.Fatalf("reactivation error = %v, want session closed", err)
	}
	close(releaseReader)

	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, exists := manager.GetSession(session.ID); !exists {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("naturally exited session remained registered after reader drain")
}

func TestNaturalExitDrainsTailOutputBeforeRemovingSession(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: tailOutputShellArgsProvider{},
	})
	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatalf("ActivateSession failed: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, exists := manager.GetSession(session.ID); !exists {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, exists := manager.GetSession(session.ID); exists {
		t.Fatal("naturally exited session remained registered")
	}
	chunks, err := session.GetHistoryChunks()
	if err != nil {
		t.Fatalf("GetHistoryChunks failed: %v", err)
	}
	var output []byte
	for _, chunk := range chunks {
		output = append(output, chunk.Data...)
	}
	if !strings.Contains(string(output), "floeterm-tail-marker") {
		t.Fatalf("tail output missing from history: %q", string(output))
	}
}

func TestCleanupReapsLateSuccessfulPTYStartExactlyOnce(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	})
	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	started := make(chan struct{})
	release := make(chan struct{})
	reaped := make(chan struct{})
	var waitCalls atomic.Int32
	var startedCmd *exec.Cmd
	var startedPTY *os.File
	session.waitProcess = func(cmd *exec.Cmd) error {
		waitCalls.Add(1)
		err := cmd.Wait()
		close(reaped)
		return err
	}
	session.startPTYProcess = func(cmd *exec.Cmd, size *pty.Winsize) (*os.File, error) {
		ptmx, startErr := pty.StartWithSize(cmd, size)
		if startErr != nil {
			return nil, startErr
		}
		startedCmd = cmd
		startedPTY = ptmx
		close(started)
		<-release
		return ptmx, nil
	}
	activation := make(chan error, 1)
	go func() {
		activation <- manager.ActivateSessionContext(context.Background(), session.ID, 80, 24)
	}()
	<-started

	manager.Cleanup()
	if err := <-activation; !errors.Is(err, errSessionClosed) {
		t.Fatalf("activation error = %v, want session closed", err)
	}
	close(release)
	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("late PTY process was not reaped")
	}
	if got := waitCalls.Load(); got != 1 {
		t.Fatalf("Wait calls = %d, want 1", got)
	}
	if startedCmd == nil || startedCmd.ProcessState == nil {
		t.Fatal("late PTY process was not reaped")
	}
	if startedPTY == nil {
		t.Fatal("late PTY start did not return a PTY")
	}
	if _, statErr := startedPTY.Stat(); statErr == nil {
		t.Fatal("late unclaimed PTY remained open")
	}
	if session.IsActive() || session.PTY != nil || session.Cmd != nil {
		t.Fatal("late PTY start revived a cleaned session")
	}
}

func TestClaimedPTYProcessIsWaitedExactlyOnce(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	})
	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	var waitCalls atomic.Int32
	session.waitProcess = func(cmd *exec.Cmd) error {
		waitCalls.Add(1)
		return cmd.Wait()
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatalf("ActivateSession failed: %v", err)
	}
	if err := manager.DeleteSession(session.ID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
	if got := waitCalls.Load(); got != 1 {
		t.Fatalf("Wait calls = %d, want 1", got)
	}
}
