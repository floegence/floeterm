//go:build darwin || linux

package terminal

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestPTYForegroundJobTracksShellChild(t *testing.T) {
	manager := NewManager(ManagerConfig{Logger: NopLogger{}})
	dir := t.TempDir()
	session, err := manager.CreateProgramSession("job", dir, Program{Executable: "/bin/sh", Args: []string{"-im"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.DeleteSession(session.ID) })
	if session.ForegroundProcessGroup() != 0 {
		t.Fatal("inactive PTY reported a job")
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatal(err)
	}
	waitJob := func(marker string) int {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			data, _ := os.ReadFile(filepath.Join(dir, marker))
			pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
			if pid > 0 && session.ForegroundProcessGroup() == pid {
				return pid
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("no foreground process for %s", marker)
		return 0
	}
	if err := session.WriteData("echo $$ > shell\n"); err != nil {
		t.Fatal(err)
	}
	shell := waitJob("shell")
	if err := session.WriteData("/bin/sh -c 'echo $$ > child; read reply'\n"); err != nil {
		t.Fatal(err)
	}
	if waitJob("child") == shell {
		t.Fatal("child retained shell process group")
	}
	if err := session.WriteData("done\n"); err != nil {
		t.Fatal(err)
	}
	waitJob("shell")
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if session.ForegroundProcessGroup() != 0 {
		t.Fatal("closed PTY reported a job")
	}
}
