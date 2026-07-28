package terminal

import (
	"bytes"
	"context"
	"errors"
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

type failingAuthenticatedShellInitWriter struct {
	baseDir string
	err     error
}

func (w failingAuthenticatedShellInitWriter) ShouldEnsureShellInit(string) bool { return true }
func (w failingAuthenticatedShellInitWriter) EnsureShellInitFiles(string) error { return w.err }
func (w failingAuthenticatedShellInitWriter) authenticatedShellInitBaseDir() string {
	return w.baseDir
}
func (w failingAuthenticatedShellInitWriter) authenticatedShellInitEnabled() bool { return true }

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
		t.Fatalf("expected native zsh global startup with no login fallback, got %v", args)
	}
	if !contains(env, "ZDOTDIR="+paths.ZshDir()) {
		t.Fatalf("expected ZDOTDIR in env, got %v", env)
	}
	if !contains(env, originalZdotdirEnvKey+"=/original/zsh") {
		t.Fatalf("expected original ZDOTDIR tracking in env, got %v", env)
	}

	args, env = provider.GetShellArgs("fish", "/tmp/prepend")
	if len(args) != 2 || args[0] != "--init-command" || !strings.Contains(args[1], paths.FishConfig()) {
		t.Fatalf("unexpected fish args: %v", args)
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
	if !provider.CommandLifecycleEnabled() {
		t.Fatal("command lifecycle provider did not preserve its requested lifecycle setting")
	}
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellArgsProvider: provider,
		ShellInitWriter:   writer,
	})
	session, err := manager.CreateSession("authenticated", t.TempDir())
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	if session.shellLifecycleNonce != "" || session.shellLifecycleAuthState != shellLifecycleAuthLegacy {
		t.Fatalf("dormant session created lifecycle credentials before shell validation: nonce=%q state=%d", session.shellLifecycleNonce, session.shellLifecycleAuthState)
	}
	if err := manager.DeleteSession(session.ID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
}

func TestAuthenticatedShellArgsUsePrivateBootstrapWithoutProcessCredentials(t *testing.T) {
	const nonceLength = 64
	baseDir := filepath.Join(t.TempDir(), "shell init 'quoted")
	t.Setenv("HOME", filepath.Join(t.TempDir(), "home 'quoted"))
	writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
	if err := writer.EnsureShellInitFiles(""); err != nil {
		t.Fatal(err)
	}
	provider := DefaultShellArgsProvider{ShellInitBaseDir: baseDir, EnableCommandLifecycle: true}
	for _, shell := range []string{"/bin/bash", "/bin/zsh"} {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			args, env, bootstrap, nonce, err := provider.prepareAuthenticatedShellArgsContext(context.Background(), shell, "", true)
			if err != nil {
				t.Fatal(err)
			}
			if bootstrap == nil || len(nonce) != nonceLength || !validShellLifecycleNonce(nonce) {
				t.Fatalf("bootstrap=%+v nonce length=%d", bootstrap, len(nonce))
			}
			t.Cleanup(bootstrap.cleanup)
			dirInfo, err := os.Stat(bootstrap.dir)
			if err != nil || dirInfo.Mode().Perm() != 0o700 {
				t.Fatalf("bootstrap directory mode=%v err=%v", dirInfo, err)
			}
			fileInfo, err := os.Stat(bootstrap.file)
			if err != nil || fileInfo.Mode().Perm() != 0o600 {
				t.Fatalf("bootstrap file mode=%v err=%v", fileInfo, err)
			}
			bootstrapContent, err := os.ReadFile(bootstrap.file)
			if err != nil || !bytes.Contains(bootstrapContent, []byte(nonce)) {
				t.Fatalf("bootstrap does not contain its private credential: err=%v", err)
			}
			if strings.Contains(strings.Join(args, "\x00"), nonce) || strings.Contains(strings.Join(env, "\x00"), nonce) || envValue(env, shellLifecycleNonceEnvKey) != "" {
				t.Fatalf("credential escaped to argv/env: args=%v env=%v", args, env)
			}
			sharedPath := newShellInitPaths(baseDir).BashRC()
			if detectShellType(shell) == shellTypeZsh {
				sharedPath = newShellInitPaths(baseDir).ZshRC()
			}
			shared, err := os.ReadFile(sharedPath)
			if err != nil || bytes.Contains(shared, []byte(nonce)) {
				t.Fatalf("shared init retained session credential: err=%v", err)
			}
		})
	}
}

func TestAuthenticatedShellArgsRejectMissingStaleAndTamperedInit(t *testing.T) {
	baseDir := t.TempDir()
	provider := DefaultShellArgsProvider{ShellInitBaseDir: baseDir, EnableCommandLifecycle: true}
	paths := newShellInitPaths(baseDir)
	for _, test := range []struct {
		name    string
		prepare func() error
	}{
		{name: "missing", prepare: func() error { return nil }},
		{name: "old contract", prepare: func() error {
			return os.WriteFile(paths.BashRC(), []byte("# floeterm shell integration version 1\n"), 0o644)
		}},
		{name: "tampered current contract", prepare: func() error {
			return os.WriteFile(paths.BashRC(), []byte(bashInitScript(true)+"# modified\n"), 0o644)
		}},
		{name: "symbolic link", prepare: func() error {
			target := filepath.Join(t.TempDir(), "current-bashrc")
			if err := os.WriteFile(target, []byte(bashInitScript(true)), 0o644); err != nil {
				return err
			}
			return os.Symlink(target, paths.BashRC())
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := os.MkdirAll(paths.BaseDir(), 0o755); err != nil {
				t.Fatal(err)
			}
			_ = os.Remove(paths.BashRC())
			if err := test.prepare(); err != nil {
				t.Fatal(err)
			}
			args, env, bootstrap, nonce, err := provider.prepareAuthenticatedShellArgsContext(context.Background(), "/bin/bash", "", true)
			if err == nil || args != nil || env != nil || bootstrap != nil || nonce != "" {
				t.Fatalf("untrusted init selected: args=%v env=%v bootstrap=%+v nonce=%q err=%v", args, env, bootstrap, nonce, err)
			}
		})
	}
}

func TestMismatchedShellInitOwnersCannotEnableAuthentication(t *testing.T) {
	config := newSessionConfig(ManagerConfig{
		ShellArgsProvider: DefaultShellArgsProvider{ShellInitBaseDir: filepath.Join(t.TempDir(), "provider"), EnableCommandLifecycle: true},
		ShellInitWriter:   DefaultShellInitWriter{BaseDir: filepath.Join(t.TempDir(), "writer"), EnableCommandLifecycle: true},
	})
	if config.shellLifecycleAuthEnabled {
		t.Fatal("mismatched provider and writer directories enabled authentication")
	}
}

func TestShellInitWriterRefusesSymbolicLinkTarget(t *testing.T) {
	baseDir := t.TempDir()
	paths := newShellInitPaths(baseDir)
	if err := os.MkdirAll(paths.ZshDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(target, []byte("do not replace"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, paths.BashRC()); err != nil {
		t.Fatal(err)
	}
	writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
	if err := writer.EnsureShellInitFiles(""); err == nil {
		t.Fatal("writer accepted symbolic link target")
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "do not replace" {
		t.Fatalf("symbolic link target changed: content=%q err=%v", content, err)
	}
}

func TestWriterFailureKeepsActivationInLegacyMode(t *testing.T) {
	baseDir := t.TempDir()
	writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
	if err := writer.EnsureShellInitFiles(""); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/bash"},
		ShellArgsProvider: DefaultShellArgsProvider{ShellInitBaseDir: baseDir, EnableCommandLifecycle: true},
		ShellInitWriter: failingAuthenticatedShellInitWriter{
			baseDir: baseDir,
			err:     errors.New("injected writer failure"),
		},
	})
	session, err := manager.CreateSession("legacy", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var capturedArgs, capturedEnv []string
	session.startPTYProcess = func(cmd *exec.Cmd, _ *pty.Winsize) (*os.File, error) {
		capturedArgs = append([]string(nil), cmd.Args...)
		capturedEnv = append([]string(nil), cmd.Env...)
		return nil, errors.New("stop after inspection")
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err == nil {
		t.Fatal("activation unexpectedly succeeded")
	}
	if got := strings.Join(capturedArgs, " "); got != "/bin/bash -l" {
		t.Fatalf("writer failure did not use login-shell fallback: %v", capturedArgs)
	}
	if envValue(capturedEnv, shellLifecycleNonceEnvKey) != "" {
		t.Fatalf("writer failure injected lifecycle credential: %v", capturedEnv)
	}
	if session.shellLifecycleAuthState != shellLifecycleAuthLegacy || session.shellLifecycleNonce != "" || session.shellLifecycleBootstrap != nil {
		t.Fatalf("writer failure enabled authentication: state=%d nonce=%q bootstrap=%+v", session.shellLifecycleAuthState, session.shellLifecycleNonce, session.shellLifecycleBootstrap)
	}
}

func TestPTYStartFailureCleansPrivateBootstrap(t *testing.T) {
	baseDir := t.TempDir()
	writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
	provider := DefaultShellArgsProvider{ShellInitBaseDir: baseDir, EnableCommandLifecycle: true}
	manager := NewManager(ManagerConfig{
		Logger: NopLogger{}, ShellResolver: testShellResolver{shell: "/bin/bash"},
		ShellArgsProvider: provider, ShellInitWriter: writer,
	})
	session, err := manager.CreateSession("cleanup", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var bootstrapPath string
	var capturedArgs, capturedEnv []string
	session.startPTYProcess = func(cmd *exec.Cmd, _ *pty.Winsize) (*os.File, error) {
		capturedArgs = append([]string(nil), cmd.Args...)
		capturedEnv = append([]string(nil), cmd.Env...)
		if len(cmd.Args) >= 3 {
			bootstrapPath = cmd.Args[2]
		}
		return nil, errors.New("injected PTY start failure")
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err == nil {
		t.Fatal("activation unexpectedly succeeded")
	}
	if len(capturedArgs) != 3 || capturedArgs[1] != "--rcfile" {
		t.Fatalf("unexpected authenticated bash args: %v", capturedArgs)
	}
	if envValue(capturedEnv, shellLifecycleNonceEnvKey) != "" {
		t.Fatalf("credential escaped to environment: %v", capturedEnv)
	}
	if bootstrapPath == "" {
		t.Fatal("activation did not create a private bootstrap")
	}
	if _, err := os.Stat(bootstrapPath); !os.IsNotExist(err) {
		t.Fatalf("failed activation retained bootstrap: %s err=%v", bootstrapPath, err)
	}
}

func TestCommandLifecycleNonceRemainsPrivateAcrossRepeatedLoads(t *testing.T) {
	const nonce = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	tests := []struct {
		name       string
		shell      string
		fileName   string
		userRC     string
		buildInit  func(string) string
		probe      string
		argsPrefix []string
	}{
		{
			name: "bash", shell: "/bin/bash", fileName: "lifecycle.bash", userRC: ".bashrc",
			buildInit:  func(string) string { return bashInitScript(true) },
			probe:      `. "$1"; . "$1"; env | sed -n '/^FLOETERM_/p;/^__FLOETERM_/p;/^__floeterm_terminal_lifecycle_nonce=/p'; __floeterm_terminal_authenticated_lifecycle prompt_ready`,
			argsPrefix: []string{"--noprofile", "--norc", "-c"},
		},
		{
			name: "zsh", shell: "/bin/zsh", fileName: "lifecycle.zsh", userRC: ".zshrc",
			buildInit:  func(home string) string { return zshInitScriptForHome(true, home) },
			probe:      `. "$1"; . "$1"; env | sed -n '/^FLOETERM_/p;/^__FLOETERM_/p;/^__floeterm_terminal_lifecycle_nonce=/p'; __floeterm_terminal_authenticated_lifecycle prompt_ready`,
			argsPrefix: []string{"-f", "-c"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			shellPath, err := exec.LookPath(test.shell)
			if err != nil {
				t.Skipf("%s unavailable: %v", test.name, err)
			}
			homeDir := t.TempDir()
			userRCPath := filepath.Join(homeDir, test.userRC)
			if err := os.MkdirAll(filepath.Dir(userRCPath), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(userRCPath, []byte("printf '__FLOETERM_USER_RC_ENV_PROBE__\\n'\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			scriptPath := filepath.Join(t.TempDir(), test.fileName)
			if err := os.WriteFile(scriptPath, []byte(test.buildInit(homeDir)), 0o600); err != nil {
				t.Fatal(err)
			}
			args := append(append([]string(nil), test.argsPrefix...), test.probe)
			if test.name == "fish" {
				args = append(args, scriptPath)
			} else {
				args = append(args, "probe", scriptPath)
			}
			cmd := exec.Command(shellPath, args...)
			cmd.Env = replaceEnvironmentValues(os.Environ(), map[string]string{
				"HOME":                    homeDir,
				shellLifecycleNonceEnvKey: nonce,
				shellLifecycleNonceVarKey: "attacker",
			})
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("probe failed: %v\n%s", err, output)
			}
			text := string(output)
			if strings.Count(text, "__FLOETERM_USER_RC_ENV_PROBE__") != 1 {
				t.Fatalf("repeated init re-ran user configuration: %q", text)
			}
			for _, leaked := range []string{
				shellLifecycleNonceEnvKey + "=", shellLifecycleNonceVarKey + "=",
				shellLifecycleCaptureKey + "=", shellLifecycleLoadedKey + "=",
			} {
				if strings.Contains(text, leaked) {
					t.Fatalf("private lifecycle nonce was exported as %q in %q", leaked, text)
				}
			}
			marker := "\x1b]633;P;FloetermLifecycle=v1;nonce=" + nonce + ";event=prompt_ready\a"
			if strings.Count(text, marker) != 1 {
				t.Fatalf("repeated load did not preserve exactly one authenticated marker: %q", text)
			}
		})
	}
}

func TestAuthenticatedLifecycleNonceIsNotPublishedByShellTracing(t *testing.T) {
	tests := []struct {
		name  string
		shell string
		args  []string
	}{
		{name: "bash", shell: "/bin/bash", args: []string{"--noprofile", "--norc", "-x", "-c", `. "$1"`, "probe"}},
		{name: "zsh", shell: "/bin/zsh", args: []string{"-f", "-x", "-c", `. "$1"`, "probe"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			shellPath, err := exec.LookPath(test.shell)
			if err != nil {
				t.Skipf("%s unavailable: %v", test.name, err)
			}
			homeDir := t.TempDir()
			t.Setenv("HOME", homeDir)
			baseDir := t.TempDir()
			writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
			if err := writer.EnsureShellInitFiles(""); err != nil {
				t.Fatal(err)
			}
			provider := DefaultShellArgsProvider{ShellInitBaseDir: baseDir, EnableCommandLifecycle: true}
			_, shellEnv, bootstrap, nonce, err := provider.prepareAuthenticatedShellArgsContext(context.Background(), shellPath, "", true)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(bootstrap.cleanup)
			args := append([]string(nil), test.args...)
			args = append(args, bootstrap.file)
			cmd := exec.Command(shellPath, args...)
			cmd.Env = mergeShellLifecycleEnvironment(
				replaceEnvironmentValues(os.Environ(), map[string]string{"HOME": homeDir}),
				shellEnv,
			)
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("trace probe failed: %v\n%s", err, output)
			}
			display, pending := stripPrivateShellLifecycleMarkers(output)
			if len(pending) != 0 {
				t.Fatalf("trace probe left pending output: %q", pending)
			}
			if bytes.Contains(display, []byte(nonce)) {
				t.Fatalf("shell trace published lifecycle nonce: %q", display)
			}
		})
	}
}

func TestShellLifecycleCredentialsAreRemovedFromProcessEnvironment(t *testing.T) {
	pollutedBase := []string{
		"BASE=1",
		shellLifecycleNonceEnvKey + "=parent",
		shellLifecycleNonceVarKey + "=parent",
		shellLifecycleCaptureKey + "=parent",
		shellLifecycleLoadedKey + "=parent",
	}
	pollutedProvider := []string{
		"PROVIDER=1",
		"OVERRIDE=provider",
		shellLifecycleNonceEnvKey + "=provider",
		shellLifecycleNonceVarKey + "=provider",
		shellLifecycleCaptureKey + "=provider",
		shellLifecycleLoadedKey + "=provider",
	}
	for _, shell := range []string{
		"/bin/bash",
		"/bin/zsh",
		"/usr/bin/fish",
		"/bin/sh",
		"/opt/tools/custom-shell",
	} {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			env := mergeShellLifecycleEnvironment(append(pollutedBase, "OVERRIDE=parent"), pollutedProvider)
			if !contains(env, "BASE=1") || !contains(env, "PROVIDER=1") {
				t.Fatalf("ordinary environment entries were lost: %v", env)
			}
			if envValue(env, "OVERRIDE") != "provider" || countEnvKey(env, "OVERRIDE") != 1 {
				t.Fatalf("provider environment did not replace inherited value exactly once: %v", env)
			}
			for _, key := range []string{shellLifecycleNonceVarKey, shellLifecycleCaptureKey, shellLifecycleLoadedKey} {
				if envValue(env, key) != "" {
					t.Fatalf("private shell variable %s escaped sanitization: %v", key, env)
				}
			}
			if gotNonce := envValue(env, shellLifecycleNonceEnvKey); gotNonce != "" {
				t.Fatalf("shell received lifecycle nonce in its environment: %v", env)
			}
		})
	}
}

func countEnvKey(env []string, key string) int {
	prefix := key + "="
	count := 0
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			count++
		}
	}
	return count
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix)
		}
	}
	return ""
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

func TestRealShellLifecyclePublishesOnlyBoundedSSHTargets(t *testing.T) {
	tests := []struct {
		name       string
		command    string
		wantTarget string
	}{
		{name: "hostname", command: "ssh root@Host.Example.", wantTarget: "root@Host.Example."},
		{name: "common options", command: "ssh -p 2222 -i ~/.ssh/id -o StrictHostKeyChecking=no root@host.example", wantTarget: "root@host.example"},
		{name: "login and separator", command: "ssh -l root -- prod_alias", wantTarget: "root@prod_alias"},
		{name: "IPv4", command: "ssh 192.0.2.10", wantTarget: "192.0.2.10"},
		{name: "IPv6", command: "ssh user@[2001:db8::1]", wantTarget: "user@[2001:db8::1]"},
		{name: "quoted target is rejected", command: `ssh "host.example"`},
		{name: "expansion is rejected", command: `ssh $HOST`},
		{name: "unknown option is rejected", command: "ssh --future-option host.example"},
	}

	shells := []struct {
		name   string
		path   string
		script func() string
		invoke string
	}{
		{name: "bash", path: "/bin/bash", script: bashCommandLifecycleScript, invoke: "trap - DEBUG\n__floeterm_terminal_at_prompt=1\n__floeterm_terminal_command_start \"$1\"\n"},
		{name: "zsh", path: "/bin/zsh", script: zshCommandLifecycleScript, invoke: "__floeterm_terminal_preexec \"$1\"\n"},
		{name: "fish", path: "/usr/bin/fish", script: fishCommandLifecycleScript, invoke: "__floeterm_terminal_fish_preexec \"$argv[1]\"\n"},
	}

	for _, shell := range shells {
		shell := shell
		if _, err := os.Stat(shell.path); err != nil {
			if resolved, lookupErr := exec.LookPath(shell.name); lookupErr == nil {
				shell.path = resolved
			} else {
				t.Logf("%s unavailable: %v", shell.name, err)
				continue
			}
		}
		for _, test := range tests {
			t.Run(shell.name+"/"+test.name, func(t *testing.T) {
				probe := shell.script() + "\n" + shell.invoke
				args := []string{"-c", probe, "probe", test.command}
				if shell.name == "fish" {
					args = []string{"-c", probe, test.command}
				}
				output, err := exec.Command(shell.path, args...).CombinedOutput()
				if err != nil {
					t.Fatalf("%s probe failed: %v\n%s", shell.name, err, output)
				}
				markerPrefix := "\x1b]633;P;FloetermSshTarget=v1;target="
				if test.wantTarget == "" {
					if bytes.Contains(output, []byte(markerPrefix)) {
						t.Fatalf("rejected command published SSH target: %q", output)
					}
					return
				}
				marker := markerPrefix + test.wantTarget + "\a"
				if !bytes.Contains(output, []byte(marker)) {
					t.Fatalf("missing marker %q in %q", marker, output)
				}
			})
		}
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
			"\x1b]633;P;FloetermLifecycle=v1;nonce=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;event=command_finished\a",
			"\x1b]633;A\a",
			"\x1b]633;P;FloetermLifecycle=v1;nonce=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;event=prompt_ready\a",
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

	t.Run("string PROMPT_COMMAND with trailing separator", func(t *testing.T) {
		output := runBashLifecycleProbe(t, bashPath, `
PS1='__FLOETERM_PROMPT__ '
PROMPT_COMMAND='printf "__USER_TRAILING_PROMPT__\n"; '
`)
		if strings.Contains(output, "syntax error") {
			t.Fatalf("trailing PROMPT_COMMAND separator caused a syntax error: %q", output)
		}
		if got := strings.Count(output, "__USER_TRAILING_PROMPT__"); got != 1 {
			t.Fatalf("user PROMPT_COMMAND count = %d, want 1 in %q", got, output)
		}
		assertContainsInOrder(t, output, []string{
			"\x1b]633;B\a",
			"\x1b]633;P;FloetermProgram=sleep\a",
			"\x1b]633;C\a",
			"__USER_TRAILING_PROMPT__",
			"\x1b]633;D;0\a",
			"\x1b]633;A\a",
		})
	})

	t.Run("history PROMPT_COMMAND with trailing separator", func(t *testing.T) {
		output := runBashLifecycleProbe(t, bashPath, `
PS1='__FLOETERM_PROMPT__ '
PROMPT_COMMAND='history -a; '
`)
		if strings.Contains(output, "syntax error") {
			t.Fatalf("history PROMPT_COMMAND caused a syntax error: %q", output)
		}
		assertContainsInOrder(t, output, []string{
			"\x1b]633;B\a",
			"\x1b]633;P;FloetermProgram=sleep\a",
			"\x1b]633;C\a",
			"\x1b]633;D;0\a",
			"\x1b]633;A\a",
		})
	})

	t.Run("string PROMPT_COMMAND with trailing comment", func(t *testing.T) {
		output := runBashLifecycleProbe(t, bashPath, `
PS1='__FLOETERM_PROMPT__ '
PROMPT_COMMAND='printf "__USER_COMMENT_PROMPT__\n"; # preserve this comment'
`)
		if got := strings.Count(output, "__USER_COMMENT_PROMPT__"); got != 1 {
			t.Fatalf("commented user PROMPT_COMMAND count = %d, want 1 in %q", got, output)
		}
		assertContainsInOrder(t, output, []string{
			"\x1b]633;C\a",
			"__USER_COMMENT_PROMPT__",
			"\x1b]633;D;0\a",
			"\x1b]633;A\a",
		})
	})

	t.Run("multiline string PROMPT_COMMAND with trailing newline", func(t *testing.T) {
		output := runBashLifecycleProbe(t, bashPath, `
PS1='__FLOETERM_PROMPT__ '
PROMPT_COMMAND='printf "__USER_MULTI_ONE__\n"
printf "__USER_MULTI_TWO__\n"
'
`)
		for _, marker := range []string{"__USER_MULTI_ONE__", "__USER_MULTI_TWO__"} {
			if got := strings.Count(output, marker); got != 1 {
				t.Fatalf("multiline user PROMPT_COMMAND marker %q count = %d, want 1 in %q", marker, got, output)
			}
		}
		assertContainsInOrder(t, output, []string{
			"\x1b]633;C\a",
			"__USER_MULTI_ONE__",
			"__USER_MULTI_TWO__",
			"\x1b]633;D;0\a",
			"\x1b]633;A\a",
		})
	})

	t.Run("string PROMPT_COMMAND with internal separator", func(t *testing.T) {
		output := runBashLifecycleProbe(t, bashPath, `
PS1='__FLOETERM_PROMPT__ '
PROMPT_COMMAND='printf "__USER_INTERNAL_ONE__\n"; printf "__USER_INTERNAL_TWO__\n"'
`)
		for _, marker := range []string{"__USER_INTERNAL_ONE__", "__USER_INTERNAL_TWO__"} {
			if got := strings.Count(output, marker); got != 1 {
				t.Fatalf("compound user PROMPT_COMMAND marker %q count = %d, want 1 in %q", marker, got, output)
			}
		}
	})

	t.Run("foreground status reaches user hook lifecycle and prompt", func(t *testing.T) {
		output := runBashLifecycleCommand(t, bashPath, `
PS1='__FLOETERM_PROMPT__:$? '
PROMPT_COMMAND='printf "__USER_STATUS__:%s\n" "$?"; '
`, "false\n", "\x1b]633;D;1\a")
		assertContainsInOrder(t, output, []string{
			"\x1b]633;P;FloetermProgram=false\a",
			"\x1b]633;C\a",
			"__USER_STATUS__:1",
			"\x1b]633;D;1\a",
			"\x1b]633;A\a",
			"__FLOETERM_PROMPT__:1",
		})
	})

	t.Run("repeated lifecycle load installs one hook", func(t *testing.T) {
		output := runBashLifecycleProbe(t, bashPath, `
PS1='__FLOETERM_PROMPT__ '
PROMPT_COMMAND='printf "__USER_RELOAD_PROMPT__\n"; '
source "$HOME/floeterm-lifecycle.sh"
source "$HOME/floeterm-lifecycle.sh"
`)
		if got := strings.Count(output, "__USER_RELOAD_PROMPT__"); got != 1 {
			t.Fatalf("reloaded user PROMPT_COMMAND count = %d, want 1 in %q", got, output)
		}
		if got := strings.Count(output, "\x1b]633;A\a"); got != 1 {
			t.Fatalf("reloaded lifecycle ready marker count = %d, want 1 in %q", got, output)
		}
	})

	t.Run("invalid string PROMPT_COMMAND remains invalid", func(t *testing.T) {
		output := runBashLifecycleStartup(t, bashPath, `
PS1='__FLOETERM_PROMPT__ '
PROMPT_COMMAND='history -a;;'
`)
		if !strings.Contains(output, "syntax error") || !strings.Contains(output, "history -a;;") {
			t.Fatalf("invalid user PROMPT_COMMAND was unexpectedly hidden or rewritten: %q", output)
		}
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
			for _, marker := range []string{"__USER_PROMPT_ONE__", "__USER_PROMPT_TWO__"} {
				if got := strings.Count(output, marker); got != 1 {
					t.Fatalf("array user PROMPT_COMMAND marker %q count = %d, want 1 in %q", marker, got, output)
				}
			}
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
	if err := os.WriteFile(filepath.Join(homeDir, ".zshrc"), []byte("printf '__FLOETERM_ZSH_USER_ENV__\\n'; env | sed -n '/^FLOETERM_/p;/^__FLOETERM_/p;/^__floeterm_terminal_lifecycle_nonce=/p'\nPROMPT='__FLOETERM_ZSH_PROMPT__ '\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	baseDir := filepath.Join(t.TempDir(), "shell-init")
	writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
	if err := writer.EnsureShellInitFiles(""); err != nil {
		t.Fatal(err)
	}
	provider := DefaultShellArgsProvider{ShellInitBaseDir: baseDir, EnableCommandLifecycle: true}
	args, shellEnv, bootstrap, nonce, err := provider.prepareAuthenticatedShellArgsContext(context.Background(), zshPath, "", true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bootstrap.cleanup)
	if args == nil || len(args) != 0 {
		t.Fatalf("zsh provider args = %v, want native global config without login fallback", args)
	}
	cmd := exec.Command(zshPath, args...)
	baseEnv := replaceEnvironmentValues(os.Environ(), map[string]string{
		"HOME":                 homeDir,
		"TERM":                 "xterm-256color",
		"skip_global_compinit": "1",
	})
	cmd.Env = mergeShellLifecycleEnvironment(baseEnv, shellEnv)
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
	startup := capture.String()
	if !strings.Contains(startup, "\x1b]633;P;FloetermLifecycle=v1;nonce="+nonce+";event=integration_ready\a") {
		t.Fatalf("zsh bootstrap did not publish authenticated readiness: %q", startup)
	}
	if !strings.Contains(startup, "__FLOETERM_ZSH_USER_ENV__") {
		t.Fatalf("generated zsh init did not load user config: %q", startup)
	}
	for _, leaked := range []string{
		shellLifecycleNonceEnvKey + "=", shellLifecycleNonceVarKey + "=",
		shellLifecycleCaptureKey + "=", shellLifecycleLoadedKey + "=",
	} {
		if strings.Contains(startup, leaked) {
			t.Fatalf("zsh user config inherited private lifecycle state %q: %q", leaked, startup)
		}
	}
	before := len(capture.String())
	if _, err := ptmx.Write([]byte("sleep 0.2\n")); err != nil {
		t.Fatal(err)
	}
	waitForCapturedOutputAfter(t, capture, before, 5*time.Second, "\x1b]633;P;FloetermProgram=sleep\a", "\x1b]633;C\a", "\x1b]633;D;0\a", "\x1b]633;A\a")
	output := capture.String()
	assertContainsInOrder(t, output[before:], []string{
		"\x1b]633;B\a",
		"\x1b]633;P;FloetermProgram=sleep\a",
		"\x1b]633;C\a",
		"\x1b]633;D;0\a",
		"\x1b]633;A\a",
	})
}

func TestRealZshLifecycleReadinessRequiresBothHookArrays(t *testing.T) {
	zshPath, err := exec.LookPath("zsh")
	if err != nil {
		t.Skipf("zsh unavailable: %v", err)
	}
	for _, test := range []struct {
		name      string
		userRC    string
		wantReady bool
	}{
		{name: "empty fpath uses native hook arrays", userRC: "fpath=()\n", wantReady: true},
		{name: "readonly precmd array rejects partial install", userRC: "typeset -gra precmd_functions=()\n", wantReady: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			homeDir := t.TempDir()
			t.Setenv("HOME", homeDir)
			if err := os.WriteFile(filepath.Join(homeDir, ".zshrc"), []byte(test.userRC), 0o600); err != nil {
				t.Fatal(err)
			}
			baseDir := t.TempDir()
			writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
			if err := writer.EnsureShellInitFiles(""); err != nil {
				t.Fatal(err)
			}
			provider := DefaultShellArgsProvider{ShellInitBaseDir: baseDir, EnableCommandLifecycle: true}
			_, shellEnv, bootstrap, nonce, err := provider.prepareAuthenticatedShellArgsContext(context.Background(), zshPath, "", true)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(bootstrap.cleanup)
			cmd := exec.Command(zshPath, "-f", "-c", `. "$1"; print -r -- "HOOKS=${preexec_functions[(Ie)__floeterm_terminal_preexec]}:${precmd_functions[(Ie)__floeterm_terminal_precmd]}"`, "probe", bootstrap.file)
			cmd.Env = mergeShellLifecycleEnvironment(
				replaceEnvironmentValues(os.Environ(), map[string]string{"HOME": homeDir}),
				shellEnv,
			)
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("zsh integration probe failed: %v\n%s", err, output)
			}
			marker := []byte("\x1b]633;P;FloetermLifecycle=v1;nonce=" + nonce + ";event=integration_ready\a")
			if got := bytes.Contains(output, marker); got != test.wantReady {
				t.Fatalf("readiness=%v, want %v: %q", got, test.wantReady, output)
			}
			if !test.wantReady && !bytes.Contains(output, []byte("HOOKS=0:0")) {
				t.Fatalf("failed hook installation retained a partial hook: %q", output)
			}
		})
	}
}

func TestRealFishProviderPreservesNativeUserConfiguration(t *testing.T) {
	fishPath, err := exec.LookPath("fish")
	if err != nil {
		t.Skipf("fish unavailable: %v", err)
	}
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("XDG_CONFIG_HOME", "")
	configPath := filepath.Join(homeDir, ".config", "fish", "config.fish")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	confDPath := filepath.Join(filepath.Dir(configPath), "conf.d", "10-user-probe.fish")
	if err := os.MkdirAll(filepath.Dir(confDPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(confDPath, []byte("printf '__FLOETERM_FISH_USER_CONFD__\\n'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("printf '__FLOETERM_FISH_USER_CONFIG__\\n'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	baseDir := filepath.Join(t.TempDir(), "shell-init")
	writer := DefaultShellInitWriter{BaseDir: baseDir, EnableCommandLifecycle: true}
	if err := writer.EnsureShellInitFiles(""); err != nil {
		t.Fatal(err)
	}
	provider := DefaultShellArgsProvider{ShellInitBaseDir: baseDir, EnableCommandLifecycle: true}
	args, shellEnv := provider.GetShellArgs(fishPath, "")
	if len(args) != 2 || args[0] != "--init-command" {
		t.Fatalf("fish provider args = %v, want post-config integration", args)
	}
	args = append(args, "-c", "printf '__FLOETERM_FISH_COMMAND__\\n'")
	cmd := exec.Command(fishPath, args...)
	baseEnv := replaceEnvironmentValues(os.Environ(), map[string]string{"HOME": homeDir, "TERM": "xterm-256color"})
	const nonce = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	cmd.Env = mergeShellLifecycleEnvironment(baseEnv, shellEnv)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("fish provider probe failed: %v\n%s", err, output)
	}
	text := string(output)
	assertContainsInOrder(t, text, []string{"__FLOETERM_FISH_USER_CONFD__", "__FLOETERM_FISH_USER_CONFIG__"})
	if strings.Count(text, "__FLOETERM_FISH_USER_CONFD__") != 1 || strings.Count(text, "__FLOETERM_FISH_USER_CONFIG__") != 1 {
		t.Fatalf("generated fish init did not load each user config source exactly once: %q", text)
	}
	if strings.Contains(text, nonce) || strings.Contains(text, shellLifecycleNonceEnvKey+"=") {
		t.Fatalf("fish received unsupported lifecycle credentials: %q", text)
	}
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
	if err := os.WriteFile(filepath.Join(homeDir, "floeterm-lifecycle.sh"), []byte(bashCommandLifecycleScript()), 0o600); err != nil {
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
		"HOME":                    homeDir,
		"TERM":                    "xterm-256color",
		shellLifecycleNonceEnvKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
	waitForCapturedOutputAfter(t, capture, before, 5*time.Second,
		"\x1b]633;C\a",
		completionMarker,
		"\x1b]633;P;FloetermLifecycle=v1;nonce=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;event=prompt_ready\a",
	)
	output := capture.String()
	if before > len(output) {
		before = 0
	}
	return output[before:]
}

func runBashLifecycleStartup(t *testing.T, bashPath string, userRC string) string {
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
	output, _ := cmd.CombinedOutput()
	return string(output)
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
	waitForCapturedOutputAfter(t, capture, 0, timeout, needles...)
}

func waitForCapturedOutputAfter(t *testing.T, capture *synchronizedBuffer, offset int, timeout time.Duration, needles ...string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		output := capture.String()
		if offset > len(output) {
			offset = len(output)
		}
		output = output[offset:]
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
