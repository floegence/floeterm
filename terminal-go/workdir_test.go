package terminal

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseWorkingDirectorySequences(t *testing.T) {
	tmp := t.TempDir()
	session := &Session{config: sessionConfig{logger: NopLogger{}}}

	vscode := "\x1b]633;P;Cwd=" + tmp + "\a"
	if got := session.parseWorkingDirectory(vscode); got != tmp {
		t.Fatalf("VSCode sequence parse failed: %q", got)
	}

	iterm := "\x1b]1337;CurrentDir=" + tmp + "\a"
	if got := session.parseWorkingDirectory(iterm); got != tmp {
		t.Fatalf("iTerm2 sequence parse failed: %q", got)
	}

	osc7 := "\x1b]7;file://localhost" + tmp + "\x1b\\"
	if got := session.parseWorkingDirectory(osc7); got != tmp {
		t.Fatalf("OSC7 sequence parse failed: %q", got)
	}

	title := "\x1b]0;user@host:" + tmp + "\a"
	if got := session.parseWorkingDirectory(title); got != tmp {
		t.Fatalf("OSC title parse failed: %q", got)
	}
}

func TestExpandPath(t *testing.T) {
	tmp := t.TempDir()
	session := &Session{config: sessionConfig{logger: NopLogger{}}}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("failed to resolve home dir: %v", err)
	}

	expected := filepath.Join(homeDir, "floeterm-test")
	if err := os.MkdirAll(expected, 0o755); err != nil {
		t.Fatalf("failed to create temp home dir: %v", err)
	}

	if got := session.expandPath("~/floeterm-test"); got != expected {
		t.Fatalf("expected expanded path %q, got %q", expected, got)
	}

	if got := session.expandPath(tmp); got != tmp {
		t.Fatalf("expected path to be valid: %q", got)
	}
}
