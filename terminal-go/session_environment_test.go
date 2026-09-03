package terminal

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"reflect"
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

func TestPTYEnvironmentUsesTheKernelWinsizeInsteadOfFixedColumnsAndLines(t *testing.T) {
	capturedEnv := capturePTYEnvironment(t, ManagerConfig{
		Logger: NopLogger{},
		EnvProvider: StaticEnvProvider{Env: []string{
			"PATH=/usr/bin:/bin",
			"COLUMNS=199",
			"LINES=48",
		}},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	})

	for _, key := range []string{"COLUMNS", "LINES"} {
		if countEnvKey(capturedEnv, key) != 0 {
			t.Fatalf("PTY environment fixed %s and can override TIOCGWINSZ: %v", key, capturedEnv)
		}
	}
}

func TestLocaleFallbackPreservesInheritedLocaleEnvironment(t *testing.T) {
	inherited := []string{
		"PATH=/usr/bin:/bin",
		"LANG=zh_CN.UTF-8",
		"LC_ALL=",
		"LC_COLLATE=zh_CN.UTF-8",
	}
	probeCalled := false
	got := applyLocaleFallback(context.Background(), inherited, func(context.Context) ([]string, error) {
		probeCalled = true
		return []string{"C", "C.utf8", "zh_CN.utf8"}, nil
	})

	if probeCalled {
		t.Fatal("locale fallback probed despite an inherited character locale")
	}
	if !reflect.DeepEqual(got, inherited) {
		t.Fatalf("locale environment = %v, want inherited %v", got, inherited)
	}
}

func TestLocaleFallbackPreservesInvalidInheritedLocale(t *testing.T) {
	inherited := []string{"PATH=/usr/bin:/bin", "LC_ALL=missing_LOCALE.UTF-8"}
	probeCalled := false
	got := applyLocaleFallback(context.Background(), inherited, func(context.Context) ([]string, error) {
		probeCalled = true
		return []string{"C", "C.utf8"}, nil
	})

	if probeCalled {
		t.Fatal("locale fallback probed despite an explicit inherited locale")
	}
	if !reflect.DeepEqual(got, inherited) {
		t.Fatalf("locale environment = %v, want inherited %v", got, inherited)
	}
}

func TestLocaleFallbackAddsOnlyAvailableNeutralCharacterLocale(t *testing.T) {
	inherited := []string{"PATH=/usr/bin:/bin", "LC_ALL="}
	got := applyLocaleFallback(context.Background(), inherited, func(context.Context) ([]string, error) {
		return []string{"C", "C.utf8", "zh_CN.utf8"}, nil
	})
	want := []string{"PATH=/usr/bin:/bin", "LC_ALL=", "LC_CTYPE=C.utf8"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("locale environment = %v, want %v", got, want)
	}
}

func TestLocaleFallbackLeavesEnvironmentUnchangedWhenProbeCannotSelectNeutralUTF8(t *testing.T) {
	tests := []struct {
		name  string
		probe localeCatalogProbe
	}{
		{
			name: "probe failure",
			probe: func(context.Context) ([]string, error) {
				return nil, errors.New("locale unavailable")
			},
		},
		{
			name: "no neutral UTF-8 locale",
			probe: func(context.Context) ([]string, error) {
				return []string{"C", "POSIX", "zh_CN.utf8"}, nil
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			inherited := []string{"PATH=/usr/bin:/bin"}
			got := applyLocaleFallback(context.Background(), inherited, test.probe)
			if !reflect.DeepEqual(got, inherited) {
				t.Fatalf("locale environment = %v, want inherited %v", got, inherited)
			}
		})
	}
}

func TestLocaleFallbackProbeObservesActivationCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	inherited := []string{"PATH=/usr/bin:/bin"}
	got := applyLocaleFallback(ctx, inherited, func(ctx context.Context) ([]string, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if !reflect.DeepEqual(got, inherited) {
		t.Fatalf("locale environment = %v, want inherited %v", got, inherited)
	}
}

func TestShellAndProgramSessionsPreserveTheSameLocaleEnvironment(t *testing.T) {
	config := ManagerConfig{
		Logger: NopLogger{},
		EnvProvider: StaticEnvProvider{Env: []string{
			"PATH=/usr/bin:/bin",
			"LANG=zh_CN.UTF-8",
			"LC_ALL=",
			"LC_COLLATE=zh_CN.UTF-8",
		}},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	}

	shellEnv := capturePTYEnvironment(t, config)
	programEnv := captureProgramPTYEnvironment(t, config)
	for _, env := range [][]string{shellEnv, programEnv} {
		assertSingleEnvValue(t, env, "LANG", "zh_CN.UTF-8")
		assertSingleEnvValue(t, env, "LC_ALL", "")
		assertSingleEnvValue(t, env, "LC_COLLATE", "zh_CN.UTF-8")
	}
}

func capturePTYEnvironment(t *testing.T, config ManagerConfig) []string {
	t.Helper()
	manager := NewManager(config)
	session, err := manager.CreateSession("color-capabilities", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.DeleteSession(session.ID) })

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

func captureProgramPTYEnvironment(t *testing.T, config ManagerConfig) []string {
	t.Helper()
	manager := NewManager(config)
	session, err := manager.CreateProgramSession("program-environment", t.TempDir(), Program{Executable: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.DeleteSession(session.ID) })

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
