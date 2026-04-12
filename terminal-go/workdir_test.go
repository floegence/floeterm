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
		{name: "title0", input: "\x1b]0;user@host:/tmp\a", expect: false},
		{name: "title2", input: "\x1b]2;user@host:/tmp\a", expect: false},
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
		"\x1b]633;P;Cwd=" + tmp,         // missing BEL
		"\x1b]1337;CurrentDir=" + tmp,   // missing BEL
		"\x1b]7;file://localhost" + tmp, // missing ST
	}

	for _, input := range cases {
		if got := session.parseWorkingDirectory(input); got != "" {
			t.Fatalf("expected empty parse result for %q, got %q", input, got)
		}
	}
}

func TestParseOSC7DecodesEncodedPaths(t *testing.T) {
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

func TestNormalizeExplicitWorkingDirectory(t *testing.T) {
	tmp := t.TempDir()

	homeDir := filepath.Join(tmp, "home")
	t.Setenv("HOME", homeDir)
	if err := os.MkdirAll(homeDir, 0o755); err != nil {
		t.Fatalf("failed to create fake home dir: %v", err)
	}

	expected := filepath.Join(homeDir, "floeterm-test")
	if err := os.MkdirAll(expected, 0o755); err != nil {
		t.Fatalf("failed to create test dir: %v", err)
	}

	if got := normalizeExplicitWorkingDirectory("~/floeterm-test"); got != expected {
		t.Fatalf("expected expanded path %q, got %q", expected, got)
	}

	if got := normalizeExplicitWorkingDirectory(tmp); got != tmp {
		t.Fatalf("expected path to be valid: %q", got)
	}

	if got := normalizeExplicitWorkingDirectory("relative/path"); got != "" {
		t.Fatalf("expected relative path to be rejected, got %q", got)
	}
}

type workdirNameChangeHandler struct {
	changes []cwdSignal
}

func (h *workdirNameChangeHandler) OnTerminalData(string, []byte, int64, bool, string) {}

func (h *workdirNameChangeHandler) OnTerminalNameChanged(_ string, _ string, newName string, workingDir string) {
	h.changes = append(h.changes, cwdSignal{path: workingDir, source: newName})
}

func (h *workdirNameChangeHandler) OnTerminalSessionCreated(*Session) {}
func (h *workdirNameChangeHandler) OnTerminalSessionClosed(string)    {}
func (h *workdirNameChangeHandler) OnTerminalError(string, error)     {}

func TestCheckWorkingDirectoryChangeBuffersFragmentedSignals(t *testing.T) {
	handler := &workdirNameChangeHandler{}
	session := &Session{
		ID:                "session-1",
		Name:              "workspace",
		currentWorkingDir: "/workspace",
		eventHandler:      handler,
		config:            sessionConfig{logger: NopLogger{}},
	}

	session.checkWorkingDirectoryChange([]byte("\x1b]633;P;Cwd=/workspace/re"))

	if session.currentWorkingDir != "/workspace" {
		t.Fatalf("currentWorkingDir changed too early: %q", session.currentWorkingDir)
	}
	if len(handler.changes) != 0 {
		t.Fatalf("expected no name updates for incomplete signal, got %d", len(handler.changes))
	}

	session.checkWorkingDirectoryChange([]byte("po\a"))

	if session.currentWorkingDir != "/workspace/repo" {
		t.Fatalf("currentWorkingDir = %q, want %q", session.currentWorkingDir, "/workspace/repo")
	}
	if session.WorkingDir != "/workspace/repo" {
		t.Fatalf("WorkingDir = %q, want %q", session.WorkingDir, "/workspace/repo")
	}
	if len(handler.changes) != 1 {
		t.Fatalf("expected one name update, got %d", len(handler.changes))
	}
	if handler.changes[0].path != "/workspace/repo" {
		t.Fatalf("workingDir = %q, want %q", handler.changes[0].path, "/workspace/repo")
	}
	if handler.changes[0].source != "repo" {
		t.Fatalf("newName = %q, want %q", handler.changes[0].source, "repo")
	}
}

func TestParseWorkingDirectorySignalsIgnoresGenericTitles(t *testing.T) {
	signals, malformedSources, pending := parseWorkingDirectorySignals([]byte("\x1b]0;user@host:/workspace/repo\a"))
	if len(signals) != 0 {
		t.Fatalf("expected no cwd signals, got %d", len(signals))
	}
	if len(malformedSources) != 0 {
		t.Fatalf("expected no malformed sources, got %v", malformedSources)
	}
	if len(pending) != 0 {
		t.Fatalf("expected no pending bytes, got %d", len(pending))
	}
}

func TestParseWorkingDirectorySignalsHandlesMultipleProtocolsInOrder(t *testing.T) {
	signals, malformedSources, pending := parseWorkingDirectorySignals([]byte(
		"\x1b]633;P;Cwd=/workspace/one\a" +
			"\x1b]1337;CurrentDir=/workspace/two\a" +
			"\x1b]7;file://localhost/workspace/three\x1b\\",
	))

	if len(malformedSources) != 0 {
		t.Fatalf("expected no malformed sources, got %v", malformedSources)
	}
	if len(pending) != 0 {
		t.Fatalf("expected no pending bytes, got %d", len(pending))
	}
	if len(signals) != 3 {
		t.Fatalf("expected 3 cwd signals, got %d", len(signals))
	}
	if signals[0].path != "/workspace/one" || signals[1].path != "/workspace/two" || signals[2].path != "/workspace/three" {
		t.Fatalf("unexpected signals: %#v", signals)
	}
}

func TestParseWorkingDirectorySignalsTracksMalformedExplicitSignals(t *testing.T) {
	signals, malformedSources, pending := parseWorkingDirectorySignals([]byte("\x1b]633;P;Cwd=relative/path\a"))
	if len(signals) != 0 {
		t.Fatalf("expected no valid signals, got %d", len(signals))
	}
	if len(malformedSources) != 1 || malformedSources[0] != "osc_633" {
		t.Fatalf("expected malformed osc_633, got %v", malformedSources)
	}
	if len(pending) != 0 {
		t.Fatalf("expected no pending bytes, got %d", len(pending))
	}
}
