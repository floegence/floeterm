package terminal

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestExplicitShellRunsInPTYWithoutChangingManagerDefault(t *testing.T) {
	resolver := &programTestShellResolver{}
	manager := NewManager(ManagerConfig{ShellResolver: resolver, Logger: NopLogger{}})
	t.Cleanup(manager.Cleanup)
	dir := t.TempDir()
	session, err := manager.CreateShellSession("selected", dir, "/bin/sh", []string{"PROBE=selected"})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatal(err)
	}
	if _, err := session.PTY.Write([]byte("printf '%s' \"$PROBE\" > result\n")); err != nil {
		t.Fatal(err)
	}
	waitShellResult(t, dir, []byte("selected"))
	if resolver.calls != 0 {
		t.Fatal("explicit launch consulted default resolver")
	}
	ordinary, err := manager.CreateSession("ordinary", dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = manager.ActivateSession(ordinary.ID, 80, 24)
	if resolver.calls != 1 {
		t.Fatal("ordinary launch did not use original resolver")
	}
}

func TestProgramThroughShellExecsExactArgvInPTY(t *testing.T) {
	for _, name := range []string{"sh", "bash", "zsh", "fish", "tcsh"} {
		t.Run(name, func(t *testing.T) {
			shell, err := exec.LookPath(name)
			if err != nil {
				t.Skip("shell not installed")
			}
			dir := t.TempDir()
			literal := " ;$(printf injected) ' \" *\n"
			program, err := ProgramThroughShell(shell, Program{Executable: "/bin/sh", Args: []string{"-c", `printf '%s\0' "$$" "$@" "$PROBE" > result; read line`, "probe", "", literal}, Env: []string{"PROBE=value"}})
			if err != nil {
				t.Fatal(err)
			}
			manager := NewManager(ManagerConfig{Logger: NopLogger{}})
			t.Cleanup(manager.Cleanup)
			session, err := manager.CreateProgramSession("agent", dir, program)
			if err != nil {
				t.Fatal(err)
			}
			if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
				t.Fatal(err)
			}
			pid, _ := session.ProgramObservation()
			waitShellResult(t, dir, []byte(fmt.Sprintf("%d\x00\x00%s\x00value\x00", pid, literal)))
		})
	}
}

func waitShellResult(t *testing.T, dir string, want []byte) {
	t.Helper()
	var got []byte
	for deadline := time.Now().Add(4 * time.Second); time.Now().Before(deadline); {
		got, _ = os.ReadFile(filepath.Join(dir, "result"))
		if bytes.Equal(got, want) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("result = %q, want %q", got, want)
}

func TestInstalledShellsUsesExecutableRuntimeInventory(t *testing.T) {
	dir := t.TempDir()
	shell := filepath.Join(dir, "bash")
	noexec := filepath.Join(dir, "unavailable")
	for _, path := range []string{shell, noexec} {
		if err := os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(shell, 0700); err != nil {
		t.Fatal(err)
	}
	registry := "/bin/bash\n/does/not/exist\n" + noexec + "\n/usr/bin/false\n"
	choices := installedShells(shell, registry, func(string) (string, error) { return "", os.ErrNotExist })
	if len(choices) != 1 || choices[0] != (ShellChoice{Name: "bash", Path: shell}) {
		t.Fatalf("inventory: %+v", choices)
	}
}
