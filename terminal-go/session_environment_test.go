package terminal

import (
	"errors"
	"os"
	"os/exec"
	"testing"

	"github.com/creack/pty"
)

func TestPTYEnvironmentDoesNotInheritHostNoColor(t *testing.T) {
	capturedEnv := capturePTYEnvironment(t, ManagerConfig{
		Logger: NopLogger{},
		EnvProvider: StaticEnvProvider{Env: []string{
			"PATH=/usr/bin:/bin",
			"TERM=dumb",
			"COLORTERM=",
			"NO_COLOR=1",
		}},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	})

	assertSingleEnvValue(t, capturedEnv, "TERM", "xterm-256color")
	assertSingleEnvValue(t, capturedEnv, "COLORTERM", "truecolor")
	if countEnvKey(capturedEnv, "NO_COLOR") != 0 {
		t.Fatalf("PTY inherited host NO_COLOR: %v", capturedEnv)
	}
}

func TestPTYEnvironmentSupportsExplicitNoColorMode(t *testing.T) {
	terminalEnv := DefaultTerminalEnv()
	terminalEnv.DisableColor = true
	capturedEnv := capturePTYEnvironment(t, ManagerConfig{
		Logger:            NopLogger{},
		EnvProvider:       StaticEnvProvider{Env: []string{"PATH=/usr/bin:/bin"}},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
		TerminalEnv:       terminalEnv,
	})

	assertSingleEnvValue(t, capturedEnv, "NO_COLOR", "1")
}

func capturePTYEnvironment(t *testing.T, config ManagerConfig) []string {
	t.Helper()
	manager := NewManager(config)
	session, err := manager.CreateSession("color-capabilities", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	var capturedEnv []string
	session.startPTYProcess = func(cmd *exec.Cmd, _ *pty.Winsize) (*os.File, error) {
		capturedEnv = append([]string(nil), cmd.Env...)
		return nil, errors.New("stop after environment inspection")
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err == nil {
		t.Fatal("activation unexpectedly succeeded")
	}
	return capturedEnv
}

func assertSingleEnvValue(t *testing.T, env []string, key string, want string) {
	t.Helper()
	if countEnvKey(env, key) != 1 || envValue(env, key) != want {
		t.Fatalf("%s environment entries = %v, want exactly %s=%s", key, env, key, want)
	}
}
