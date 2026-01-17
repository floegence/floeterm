package terminal

import (
	"os"
	"path/filepath"
	"strings"
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

func TestShouldCheckDirectoryChange(t *testing.T) {
	session := &Session{config: sessionConfig{logger: NopLogger{}}}
	cases := []struct {
		name   string
		input  string
		expect bool
	}{
		{name: "empty", input: "", expect: false},
		{name: "vscode", input: "\x1b]633;P;Cwd=/tmp\a", expect: true},
		{name: "iterm2", input: "\x1b]1337;CurrentDir=/tmp\a", expect: true},
		{name: "osc7", input: "\x1b]7;file://localhost/tmp\x1b\\", expect: true},
		{name: "title0", input: "\x1b]0;user@host:/tmp\a", expect: true},
		{name: "title2", input: "\x1b]2;user@host:/tmp\a", expect: true},
		{name: "other", input: "hello world", expect: false},
	}

	for _, tc := range cases {
		if got := session.shouldCheckDirectoryChange(tc.input); got != tc.expect {
			t.Fatalf("%s: expected %v, got %v", tc.name, tc.expect, got)
		}
	}
}

func TestParseWorkingDirectoryPrecedence(t *testing.T) {
	base := t.TempDir()
	path1 := filepath.Join(base, "one")
	path2 := filepath.Join(base, "two")
	if err := os.MkdirAll(path1, 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	if err := os.MkdirAll(path2, 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	session := &Session{config: sessionConfig{logger: NopLogger{}}}

	// VSCode should win over iTerm2 when both are present.
	output := "\x1b]1337;CurrentDir=" + path2 + "\a" + "\x1b]633;P;Cwd=" + path1 + "\a"
	if got := session.parseWorkingDirectory(output); got != path1 {
		t.Fatalf("expected VSCode cwd %q, got %q", path1, got)
	}

	// iTerm2 should win over OSC7.
	output = "\x1b]7;file://localhost" + path1 + "\x1b\\" + "\x1b]1337;CurrentDir=" + path2 + "\a"
	if got := session.parseWorkingDirectory(output); got != path2 {
		t.Fatalf("expected iTerm2 cwd %q, got %q", path2, got)
	}
}

func TestParseWorkingDirectoryMalformedSequences(t *testing.T) {
	tmp := t.TempDir()
	session := &Session{config: sessionConfig{logger: NopLogger{}}}

	cases := []string{
		"\x1b]633;P;Cwd=" + tmp,          // missing BEL
		"\x1b]1337;CurrentDir=" + tmp,    // missing BEL
		"\x1b]7;file://localhost" + tmp,  // missing ST
		"\x1b]0;user@host:" + tmp,        // missing terminator
		"\x1b]2;user@host:" + tmp + "\r", // wrong terminator
	}

	for _, input := range cases {
		if got := session.parseWorkingDirectory(input); got != "" {
			t.Fatalf("expected empty parse result for %q, got %q", input, got)
		}
	}
}

func TestParseOSC7Unescape(t *testing.T) {
	base := t.TempDir()
	rawName := "hello world"
	path := filepath.Join(base, rawName)
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	session := &Session{config: sessionConfig{logger: NopLogger{}}}
	encoded := strings.ReplaceAll(path, " ", "%20")
	osc7 := "\x1b]7;file://host" + encoded + "\x1b\\"
	if got := session.parseWorkingDirectory(osc7); got != path {
		t.Fatalf("expected decoded OSC7 path %q, got %q", path, got)
	}
}

func TestExtractPathFromTitleVariants(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "target")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	session := &Session{config: sessionConfig{logger: NopLogger{}}}

	cases := []string{
		"user@host:" + target,
		"ssh: user@host:" + target, // last colon wins
		"cmd - " + target,
		"cmd - " + target + " (running)",
	}
	for _, title := range cases {
		out := "\x1b]0;" + title + "\a"
		if got := session.parseWorkingDirectory(out); got != target {
			t.Fatalf("expected title path %q for %q, got %q", target, title, got)
		}
	}
}

func TestExpandPath(t *testing.T) {
	tmp := t.TempDir()
	session := &Session{config: sessionConfig{logger: NopLogger{}}}

	homeDir := filepath.Join(tmp, "home")
	t.Setenv("HOME", homeDir)
	if err := os.MkdirAll(homeDir, 0o755); err != nil {
		t.Fatalf("failed to create fake home dir: %v", err)
	}

	expected := filepath.Join(homeDir, "floeterm-test")
	if err := os.MkdirAll(expected, 0o755); err != nil {
		t.Fatalf("failed to create test dir: %v", err)
	}

	if got := session.expandPath("~/floeterm-test"); got != expected {
		t.Fatalf("expected expanded path %q, got %q", expected, got)
	}

	if got := session.expandPath(tmp); got != tmp {
		t.Fatalf("expected path to be valid: %q", got)
	}

	if got := session.expandPath(filepath.Join(tmp, "does-not-exist")); got != "" {
		t.Fatalf("expected non-existent path to be rejected, got %q", got)
	}
}
