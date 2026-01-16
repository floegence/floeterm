package terminal

import (
	"os"
	"strings"
	"testing"
	"time"
)

type emptyArgsProvider struct{}

func (emptyArgsProvider) GetShellArgs(string, string) ([]string, []string) { return []string{}, nil }

func TestShellArgsProviderEmptySliceSkipsLoginFallback(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                        NopLogger{},
		ShellResolver:                 testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider:             emptyArgsProvider{},
		InitialResizeSuppressDuration: time.Millisecond,
	})

	session, err := manager.CreateSession("test", "", 80, 24)
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	t.Cleanup(func() {
		_ = manager.DeleteSession(session.ID)
	})

	if session.Cmd == nil {
		t.Fatalf("expected cmd to be set")
	}
	if got := session.Cmd.Args; len(got) != 1 {
		t.Fatalf("expected shell to be started without fallback args, got %v", got)
	}
}

func TestDefaultShellInitWriterAndArgsProvider(t *testing.T) {
	baseDir := t.TempDir()

	writer := DefaultShellInitWriter{BaseDir: baseDir}
	if err := writer.EnsureShellInitFiles("/example/prepend"); err != nil {
		t.Fatalf("EnsureShellInitFiles failed: %v", err)
	}

	paths := newShellInitPaths(baseDir)
	for _, path := range []string{paths.BashRC(), paths.ZshRC(), paths.FishConfig(), paths.PosixRC()} {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("expected init file %s to exist: %v", path, err)
		}
		if !strings.Contains(string(content), pathPrependEnvKey) {
			t.Fatalf("expected init file %s to reference %s", path, pathPrependEnvKey)
		}
	}

	provider := DefaultShellArgsProvider{ShellInitBaseDir: baseDir}

	args, env := provider.GetShellArgs("bash", "/tmp/prepend")
	if len(args) != 2 || args[0] != "--rcfile" || args[1] != paths.BashRC() {
		t.Fatalf("unexpected bash args: %v", args)
	}
	if !contains(env, pathPrependEnvKey+"=/tmp/prepend") {
		t.Fatalf("expected %s in env, got %v", pathPrependEnvKey, env)
	}

	t.Setenv("ZDOTDIR", "/original/zsh")
	args, env = provider.GetShellArgs("zsh", "/tmp/prepend")
	if args == nil || len(args) != 0 {
		t.Fatalf("expected non-nil empty args for zsh, got %v", args)
	}
	if !contains(env, "ZDOTDIR="+paths.ZshDir()) {
		t.Fatalf("expected ZDOTDIR in env, got %v", env)
	}
	if !contains(env, originalZdotdirEnvKey+"=/original/zsh") {
		t.Fatalf("expected original ZDOTDIR tracking in env, got %v", env)
	}

	args, env = provider.GetShellArgs("fish", "/tmp/prepend")
	if len(args) != 2 || args[0] != "--init-command" {
		t.Fatalf("unexpected fish args: %v", args)
	}
	if !strings.Contains(args[1], paths.FishConfig()) {
		t.Fatalf("expected fish config to be sourced, got %v", args)
	}
	if !contains(env, pathPrependEnvKey+"=/tmp/prepend") {
		t.Fatalf("expected %s in env, got %v", pathPrependEnvKey, env)
	}

	args, env = provider.GetShellArgs("sh", "/tmp/prepend")
	if args == nil || len(args) != 0 {
		t.Fatalf("expected non-nil empty args for posix shells, got %v", args)
	}
	if !contains(env, "ENV="+paths.PosixRC()) {
		t.Fatalf("expected ENV in env, got %v", env)
	}
}

func contains(items []string, needle string) bool {
	for _, item := range items {
		if item == needle {
			return true
		}
	}
	return false
}
