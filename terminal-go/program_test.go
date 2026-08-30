package terminal

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
)

type programTestLogger struct {
	mu      sync.Mutex
	entries []string
}

func (l *programTestLogger) append(msg string, kv ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, fmt.Sprint(append([]any{msg}, kv...)...))
}

func (l *programTestLogger) Debug(msg string, kv ...any) { l.append(msg, kv...) }
func (l *programTestLogger) Info(msg string, kv ...any)  { l.append(msg, kv...) }
func (l *programTestLogger) Warn(msg string, kv ...any)  { l.append(msg, kv...) }
func (l *programTestLogger) Error(msg string, kv ...any) { l.append(msg, kv...) }

func (l *programTestLogger) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.entries, "\n")
}

type programTestShellResolver struct{ calls int }

func (r *programTestShellResolver) ResolveShell(Logger) string {
	r.calls++
	return "/bin/false"
}

type programTestShellArgsProvider struct{ calls int }

func (p *programTestShellArgsProvider) GetShellArgs(string, string) ([]string, []string) {
	p.calls++
	return []string{"unexpected"}, nil
}

type programTestShellInitWriter struct{ calls int }

func (w *programTestShellInitWriter) EnsureShellInitFiles(string) error {
	w.calls++
	return nil
}

func (*programTestShellInitWriter) ShouldEnsureShellInit(string) bool { return true }

func TestCreateProgramSessionPreservesExactArgvAndSkipsShellSetup(t *testing.T) {
	logger := &programTestLogger{}
	resolver := &programTestShellResolver{}
	argsProvider := &programTestShellArgsProvider{}
	initWriter := &programTestShellInitWriter{}
	manager := NewManager(ManagerConfig{
		Logger:            logger,
		EnvProvider:       StaticEnvProvider{Env: []string{"PATH=/usr/bin:/bin"}, PathPrepend: "/unexpected"},
		ShellResolver:     resolver,
		ShellArgsProvider: argsProvider,
		ShellInitWriter:   initWriter,
	})

	callerArgs := []string{"literal;not-shell", "$HOME", "secret-argument"}
	session, err := manager.CreateProgramSession("program", t.TempDir(), Program{
		Executable: "/usr/bin/env",
		Args:       callerArgs,
	})
	if err != nil {
		t.Fatalf("CreateProgramSession failed: %v", err)
	}
	t.Cleanup(func() { _ = manager.DeleteSession(session.ID) })
	callerArgs[0] = "mutated-after-create"

	stop := errors.New("stop after argv inspection")
	var capturedPath string
	var capturedArgs []string
	session.startPTYProcess = func(cmd *exec.Cmd, _ *pty.Winsize) (*os.File, error) {
		capturedPath = cmd.Path
		capturedArgs = append([]string(nil), cmd.Args...)
		return nil, stop
	}
	if err := manager.ActivateSession(session.ID, 80, 24); !errors.Is(err, stop) && !strings.Contains(fmt.Sprint(err), stop.Error()) {
		t.Fatalf("ActivateSession error = %v, want %v", err, stop)
	}

	if capturedPath != "/usr/bin/env" {
		t.Fatalf("program path = %q, want /usr/bin/env", capturedPath)
	}
	wantArgs := []string{"/usr/bin/env", "literal;not-shell", "$HOME", "secret-argument"}
	if !reflect.DeepEqual(capturedArgs, wantArgs) {
		t.Fatalf("program argv = %#v, want %#v", capturedArgs, wantArgs)
	}
	if resolver.calls != 0 || argsProvider.calls != 0 || initWriter.calls != 0 {
		t.Fatalf("shell setup calls = resolver:%d args:%d init:%d, want all zero", resolver.calls, argsProvider.calls, initWriter.calls)
	}
	if logs := logger.text(); strings.Contains(logs, "secret-argument") || strings.Contains(logs, "literal;not-shell") {
		t.Fatalf("program argv leaked to logs: %s", logs)
	}
}

func TestCreateProgramSessionRejectsInvalidProgram(t *testing.T) {
	manager := NewManager(ManagerConfig{Logger: NopLogger{}})
	tests := []Program{
		{},
		{Executable: "bad\x00program"},
		{Executable: "/bin/sh", Args: []string{"bad\x00arg"}},
	}
	for _, program := range tests {
		if _, err := manager.CreateProgramSession("invalid", "", program); err == nil {
			t.Fatalf("CreateProgramSession(%#v) succeeded, want validation error", program)
		}
	}
}

func TestProgramSessionRunsInRealPTYAndExitsNaturally(t *testing.T) {
	manager := NewManager(ManagerConfig{Logger: NopLogger{}})
	session, err := manager.CreateProgramSession("real-program", t.TempDir(), Program{
		Executable: "/bin/sh",
		Args:       []string{"-c", "printf 'program-session-ready\\n'; exit 7"},
	})
	if err != nil {
		t.Fatalf("CreateProgramSession failed: %v", err)
	}
	if err := manager.ActivateSession(session.ID, 100, 30); err != nil {
		t.Fatalf("ActivateSession failed: %v", err)
	}

	select {
	case <-session.procWaitDone:
	case <-time.After(3 * time.Second):
		t.Fatal("program did not exit naturally")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, exists := manager.GetSession(session.ID); !exists {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("naturally exited program session remained registered")
}

func TestProgramSessionSupportsResizeAndCancellation(t *testing.T) {
	manager := NewManager(ManagerConfig{Logger: NopLogger{}})
	session, err := manager.CreateProgramSession("resizable-program", t.TempDir(), Program{
		Executable: "/bin/cat",
	})
	if err != nil {
		t.Fatalf("CreateProgramSession failed: %v", err)
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatalf("ActivateSession failed: %v", err)
	}
	if err := session.ResizePTY(132, 43); err != nil {
		t.Fatalf("ResizePTY failed: %v", err)
	}
	size, err := pty.GetsizeFull(session.PTY)
	if err != nil {
		t.Fatalf("read PTY size: %v", err)
	}
	if size.Cols != 132 || size.Rows != 43 {
		t.Fatalf("PTY size = %dx%d, want 132x43", size.Cols, size.Rows)
	}
	if err := manager.DeleteSession(session.ID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
	if _, exists := manager.GetSession(session.ID); exists {
		t.Fatal("cancelled program session remained registered")
	}
}
