package terminal

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
)

type emptyArgsProvider struct{}

func (emptyArgsProvider) GetShellArgs(string, string) ([]string, []string) { return []string{}, nil }

type requiredShellInitWriter struct {
	calls int
}

func (w *requiredShellInitWriter) ShouldEnsureShellInit(string) bool { return true }
func (w *requiredShellInitWriter) EnsureShellInitFiles(string) error {
	w.calls++
	return nil
}

func TestShellArgsProviderEmptySliceSkipsLoginFallback(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                        NopLogger{},
		ShellResolver:                 testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider:             emptyArgsProvider{},
		InitialResizeSuppressDuration: time.Millisecond,
	})

	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	t.Cleanup(func() {
		_ = manager.DeleteSession(session.ID)
	})

	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatalf("ActivateSession failed: %v", err)
	}

	if session.Cmd == nil {
		t.Fatalf("expected cmd to be set")
	}
	if got := session.Cmd.Args; len(got) != 1 {
		t.Fatalf("expected shell to be started without fallback args, got %v", got)
	}
}

func TestSessionEnsuresRequiredShellInitWithoutPathPrepend(t *testing.T) {
	writer := &requiredShellInitWriter{}
	manager := NewManager(ManagerConfig{
		Logger:                        NopLogger{},
		ShellResolver:                 testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider:             emptyArgsProvider{},
		ShellInitWriter:               writer,
		InitialResizeSuppressDuration: time.Millisecond,
	})
	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	t.Cleanup(func() { _ = manager.DeleteSession(session.ID) })

	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatalf("ActivateSession failed: %v", err)
	}
	if writer.calls != 1 {
		t.Fatalf("EnsureShellInitFiles calls=%d, want 1", writer.calls)
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

func TestDefaultShellIntegrationCanEnableCommandLifecycleWithoutPathPrepend(t *testing.T) {
	baseDir := t.TempDir()
	writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
	if err := writer.EnsureShellInitFiles(""); err != nil {
		t.Fatalf("EnsureShellInitFiles failed: %v", err)
	}

	paths := newShellInitPaths(baseDir)
	for _, path := range []string{paths.BashRC(), paths.ZshRC(), paths.FishConfig()} {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if !strings.Contains(string(content), "]633;") {
			t.Fatalf("%s does not contain OSC 633 lifecycle integration", path)
		}
	}

	provider := DefaultShellArgsProvider{
		ShellInitBaseDir:       baseDir,
		EnableCommandLifecycle: true,
	}
	args, env := provider.GetShellArgs("/bin/bash", "")
	if len(args) != 2 || args[0] != "--rcfile" || args[1] != paths.BashRC() {
		t.Fatalf("unexpected bash args: %#v", args)
	}
	if len(env) != 0 {
		t.Fatalf("unexpected env without PATH prepend: %#v", env)
	}
}

func TestBashCommandLifecyclePublishesExecutedProgramAndFinalPromptState(t *testing.T) {
	script := bashCommandLifecycleScript()

	for _, required := range []string{
		"P;FloetermProgram=",
		`__floeterm_terminal_osc "C"`,
		"__floeterm_terminal_prompt_begin",
		"__floeterm_terminal_precmd",
	} {
		if !strings.Contains(script, required) {
			t.Fatalf("bash lifecycle script missing %q", required)
		}
	}
	if strings.Contains(script, `PROMPT_COMMAND="__floeterm_terminal_precmd;${PROMPT_COMMAND}"`) {
		t.Fatal("floeterm precmd must not run before the existing PROMPT_COMMAND")
	}
}

func TestRealBashCommandLifecyclePreservesPromptCommandAndReportsSilentCommand(t *testing.T) {
	bashPath := "/bin/bash"
	if _, err := os.Stat(bashPath); err != nil {
		t.Skipf("bash unavailable: %v", err)
	}

	t.Run("string PROMPT_COMMAND", func(t *testing.T) {
		output := runBashLifecycleProbe(t, bashPath, `
PS1='__FLOETERM_PROMPT__ '
PROMPT_COMMAND='printf "__USER_PROMPT__\n"'
`)
		assertContainsInOrder(t, output, []string{
			"\x1b]633;B\a",
			"\x1b]633;P;FloetermProgram=sleep\a",
			"\x1b]633;C\a",
			"__USER_PROMPT__",
			"\x1b]633;D;0\a",
			"\x1b]633;A\a",
		})

		t.Run("failure status and existing DEBUG trap", func(t *testing.T) {
			output := runBashLifecycleCommand(t, bashPath, `
PS1='__FLOETERM_PROMPT__ '
PROMPT_COMMAND='printf "__USER_PROMPT__\n"'
trap 'printf "__USER_DEBUG__:%s:%s\n" "$?" "$BASH_COMMAND"' DEBUG
`, "false\n", "\x1b]633;D;1\a")
			assertContainsInOrder(t, output, []string{
				"\x1b]633;P;FloetermProgram=false\a",
				"\x1b]633;C\a",
				"__USER_DEBUG__:0:false",
				"__USER_PROMPT__",
				"\x1b]633;D;1\a",
				"\x1b]633;A\a",
			})
			if !strings.Contains(output, "__USER_DEBUG__:1:printf") {
				t.Fatalf("existing DEBUG trap did not observe the failed status before PROMPT_COMMAND: %q", output)
			}
			if got := strings.Count(output, "__USER_DEBUG__:"); got != 2 {
				t.Fatalf("existing DEBUG trap count = %d, want 2 in %q", got, output)
			}
		})
	})

	majorOutput, err := exec.Command(bashPath, "-c", `printf '%s' "${BASH_VERSINFO[0]}"`).Output()
	if err != nil {
		t.Fatalf("read bash version: %v", err)
	}
	major, _ := strconv.Atoi(string(majorOutput))
	if major >= 5 {
		t.Run("array PROMPT_COMMAND", func(t *testing.T) {
			output := runBashLifecycleProbe(t, bashPath, `
PS1='__FLOETERM_PROMPT__ '
PROMPT_COMMAND=('printf "__USER_PROMPT_ONE__\n"' 'printf "__USER_PROMPT_TWO__\n"')
`)
			assertContainsInOrder(t, output, []string{
				"\x1b]633;P;FloetermProgram=sleep\a",
				"\x1b]633;C\a",
				"__USER_PROMPT_ONE__",
				"__USER_PROMPT_TWO__",
				"\x1b]633;D;0\a",
				"\x1b]633;A\a",
			})
		})
	}
}

func TestRealZshCommandLifecycleReportsSilentCommand(t *testing.T) {
	zshPath := "/bin/zsh"
	if _, err := os.Stat(zshPath); err != nil {
		t.Skipf("zsh unavailable: %v", err)
	}

	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	if err := os.WriteFile(filepath.Join(homeDir, ".zshrc"), []byte("PROMPT='__FLOETERM_ZSH_PROMPT__ '\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	baseDir := filepath.Join(t.TempDir(), "shell-init")
	writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
	if err := writer.EnsureShellInitFiles(""); err != nil {
		t.Fatal(err)
	}
	paths := newShellInitPaths(baseDir)

	cmd := exec.Command(zshPath)
	cmd.Env = replaceEnvironmentValues(os.Environ(), map[string]string{
		"HOME":                 homeDir,
		"TERM":                 "xterm-256color",
		"ZDOTDIR":              paths.ZshDir(),
		"skip_global_compinit": "1",
	})
	ptmx, err := pty.Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	})

	capture := &synchronizedBuffer{}
	go func() { _, _ = io.Copy(capture, ptmx) }()
	waitForCapturedOutput(t, capture, 5*time.Second, "\x1b]633;A\a", "__FLOETERM_ZSH_PROMPT__")
	before := len(capture.String())
	if _, err := ptmx.Write([]byte("sleep 0.2\n")); err != nil {
		t.Fatal(err)
	}
	waitForCapturedOutput(t, capture, 5*time.Second, "\x1b]633;P;FloetermProgram=sleep\a", "\x1b]633;C\a", "\x1b]633;D;0\a")
	output := capture.String()
	assertContainsInOrder(t, output[before:], []string{
		"\x1b]633;B\a",
		"\x1b]633;P;FloetermProgram=sleep\a",
		"\x1b]633;C\a",
		"\x1b]633;D;0\a",
		"\x1b]633;A\a",
	})
}

type synchronizedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *synchronizedBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(data)
}

func (b *synchronizedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

func runBashLifecycleProbe(t *testing.T, bashPath string, userRC string) string {
	return runBashLifecycleCommand(t, bashPath, userRC, "sleep 0.2\n", "\x1b]633;D;0\a")
}

func runBashLifecycleCommand(t *testing.T, bashPath string, userRC string, command string, completionMarker string) string {
	t.Helper()
	homeDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(homeDir, ".bashrc"), []byte(userRC), 0o600); err != nil {
		t.Fatal(err)
	}
	baseDir := filepath.Join(t.TempDir(), "shell-init")
	writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
	if err := writer.EnsureShellInitFiles(""); err != nil {
		t.Fatal(err)
	}

	paths := newShellInitPaths(baseDir)
	cmd := exec.Command(bashPath, "--noprofile", "--rcfile", paths.BashRC(), "-i")
	cmd.Env = replaceEnvironmentValues(os.Environ(), map[string]string{
		"HOME": homeDir,
		"TERM": "xterm-256color",
	})
	ptmx, err := pty.Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	})

	capture := &synchronizedBuffer{}
	go func() { _, _ = io.Copy(capture, ptmx) }()
	waitForCapturedOutput(t, capture, 5*time.Second, "\x1b]633;A\a", "__FLOETERM_PROMPT__")
	before := len(capture.String())
	if _, err := ptmx.Write([]byte(command)); err != nil {
		t.Fatal(err)
	}
	waitForCapturedOutput(t, capture, 5*time.Second, "\x1b]633;C\a", completionMarker)
	output := capture.String()
	if before > len(output) {
		before = 0
	}
	return output[before:]
}

func replaceEnvironmentValues(env []string, replacements map[string]string) []string {
	result := make([]string, 0, len(env)+len(replacements))
	for _, value := range env {
		key, _, ok := strings.Cut(value, "=")
		if ok {
			if _, replaced := replacements[key]; replaced {
				continue
			}
		}
		result = append(result, value)
	}
	for key, value := range replacements {
		result = append(result, key+"="+value)
	}
	return result
}

func waitForCapturedOutput(t *testing.T, capture *synchronizedBuffer, timeout time.Duration, needles ...string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		output := capture.String()
		matched := true
		for _, needle := range needles {
			if !strings.Contains(output, needle) {
				matched = false
				break
			}
		}
		if matched {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %q in %q", needles, capture.String())
}

func assertContainsInOrder(t *testing.T, output string, values []string) {
	t.Helper()
	offset := 0
	for _, value := range values {
		index := strings.Index(output[offset:], value)
		if index < 0 {
			t.Fatalf("missing %q after offset %d in %q", value, offset, output)
		}
		offset += index + len(value)
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
