package terminal

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	pathPrependEnvKey         = "FLOETERM_PATH_PREPEND"
	originalZdotdirEnvKey     = "FLOETERM_ORIGINAL_ZDOTDIR"
	shellLifecycleNonceEnvKey = "FLOETERM_SHELL_LIFECYCLE_NONCE"
	shellLifecycleNonceVarKey = "__floeterm_terminal_lifecycle_nonce"
	shellLifecycleCaptureKey  = "__FLOETERM_SHELL_LIFECYCLE_NONCE_CAPTURED"
	shellLifecycleLoadedKey   = "__FLOETERM_COMMAND_LIFECYCLE_LOADED"
	defaultShellInitFolder    = "shell-init"
	shellInitVersionMarker    = "# floeterm shell integration version 2"
)

type shellType string

const (
	shellTypeBash  shellType = "bash"
	shellTypeZsh   shellType = "zsh"
	shellTypeFish  shellType = "fish"
	shellTypePosix shellType = "posix"
)

func detectShellType(shellPath string) shellType {
	name := filepath.Base(shellPath)
	switch {
	case strings.Contains(name, "zsh"):
		return shellTypeZsh
	case strings.Contains(name, "bash"):
		return shellTypeBash
	case strings.Contains(name, "fish"):
		return shellTypeFish
	default:
		return shellTypePosix
	}
}

func supportsAuthenticatedShellLifecycle(shellPath string) bool {
	switch detectShellType(shellPath) {
	case shellTypeBash, shellTypeZsh:
		return true
	default:
		return false
	}
}

func defaultShellInitBaseDir() string {
	if dir, err := os.UserCacheDir(); err == nil && dir != "" {
		return filepath.Join(dir, "floeterm", defaultShellInitFolder)
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".floeterm", defaultShellInitFolder)
	}
	return filepath.Join(os.TempDir(), "floeterm-"+defaultShellInitFolder)
}

type shellInitPaths struct {
	baseDir string
}

func newShellInitPaths(baseDir string) shellInitPaths {
	if baseDir == "" {
		baseDir = defaultShellInitBaseDir()
	}
	return shellInitPaths{baseDir: baseDir}
}

func (p shellInitPaths) BaseDir() string { return p.baseDir }
func (p shellInitPaths) ZshDir() string  { return filepath.Join(p.baseDir, "zsh") }
func (p shellInitPaths) ZshRC() string   { return filepath.Join(p.ZshDir(), ".zshrc") }
func (p shellInitPaths) BashRC() string  { return filepath.Join(p.baseDir, "bashrc") }
func (p shellInitPaths) FishConfig() string {
	return filepath.Join(p.baseDir, "config.fish")
}
func (p shellInitPaths) PosixRC() string { return filepath.Join(p.baseDir, "shrc") }

// DefaultShellInitWriter generates shell init files used for PATH injection.
//
// The generated rc files source the user's original shell configuration and then
// prepend $FLOETERM_PATH_PREPEND to PATH.
type DefaultShellInitWriter struct {
	BaseDir                string
	EnableCommandLifecycle bool
}

func (w DefaultShellInitWriter) authenticatedShellInitBaseDir() string {
	return newShellInitPaths(w.BaseDir).BaseDir()
}

func (w DefaultShellInitWriter) authenticatedShellInitEnabled() bool {
	return w.EnableCommandLifecycle
}

// ShouldEnsureShellInit reports whether the generated integration files are
// needed for PATH injection or command lifecycle hooks.
func (w DefaultShellInitWriter) ShouldEnsureShellInit(pathPrepend string) bool {
	return strings.TrimSpace(pathPrepend) != "" || w.EnableCommandLifecycle
}

func (w DefaultShellInitWriter) EnsureShellInitFiles(pathPrepend string) error {
	return w.EnsureShellInitFilesContext(context.Background(), pathPrepend)
}

func (w DefaultShellInitWriter) EnsureShellInitFilesContext(ctx context.Context, pathPrepend string) error {
	if !w.ShouldEnsureShellInit(pathPrepend) {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	paths := newShellInitPaths(w.BaseDir)

	if err := os.MkdirAll(paths.BaseDir(), 0o755); err != nil {
		return fmt.Errorf("failed to create shell init directory: %w", err)
	}
	if err := os.MkdirAll(paths.ZshDir(), 0o755); err != nil {
		return fmt.Errorf("failed to create zsh init directory: %w", err)
	}
	if err := writeFileContext(ctx, paths.BashRC(), bashInitScript(w.EnableCommandLifecycle)); err != nil {
		return err
	}
	if err := writeFileContext(ctx, paths.ZshRC(), zshInitScript(w.EnableCommandLifecycle)); err != nil {
		return err
	}
	if err := writeFileContext(ctx, paths.FishConfig(), fishInitScript(w.EnableCommandLifecycle)); err != nil {
		return err
	}
	if err := writeFileContext(ctx, paths.PosixRC(), posixInitScript()); err != nil {
		return err
	}

	return nil
}

func writeFile(path string, content string) error {
	return writeFileContext(context.Background(), path, content)
}

func writeFileContext(ctx context.Context, path string, content string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to replace symbolic link %s", filepath.Base(path))
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to inspect %s: %w", filepath.Base(path), err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return fmt.Errorf("failed to create temporary %s: %w", filepath.Base(path), err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	failed := true
	defer func() {
		if failed {
			_ = temporary.Close()
		}
	}()
	if err := temporary.Chmod(0o644); err != nil {
		return fmt.Errorf("failed to set permissions on %s: %w", filepath.Base(path), err)
	}
	if _, err := temporary.WriteString(content); err != nil {
		return fmt.Errorf("failed to write %s: %w", filepath.Base(path), err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("failed to sync %s: %w", filepath.Base(path), err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("failed to close %s: %w", filepath.Base(path), err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to replace symbolic link %s", filepath.Base(path))
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to inspect %s: %w", filepath.Base(path), err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("failed to install %s: %w", filepath.Base(path), err)
	}
	failed = false
	return nil
}

type shellLifecycleBootstrap struct {
	dir  string
	file string
}

func (b *shellLifecycleBootstrap) cleanup() {
	if b == nil {
		return
	}
	if b.file != "" {
		_ = os.Remove(b.file)
	}
	if b.dir != "" {
		_ = os.Remove(b.dir)
	}
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func createShellLifecycleBootstrap(ctx context.Context, shellPath, sharedInitPath, nonce string) (*shellLifecycleBootstrap, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validShellLifecycleNonce(nonce) || !supportsAuthenticatedShellLifecycle(shellPath) {
		return nil, fmt.Errorf("authenticated shell lifecycle bootstrap is unavailable")
	}
	dir, err := os.MkdirTemp("", "floeterm-shell-bootstrap-")
	if err != nil {
		return nil, fmt.Errorf("failed to create shell lifecycle bootstrap directory: %w", err)
	}
	bootstrap := &shellLifecycleBootstrap{dir: dir}
	defer func() {
		if bootstrap.file == "" {
			bootstrap.cleanup()
		}
	}()

	var fileName, script string
	switch detectShellType(shellPath) {
	case shellTypeBash:
		fileName = "bashrc"
		script = `#!/bin/bash
# Per-session Floeterm lifecycle bootstrap. Removed after the initial handshake.
__floeterm_terminal_restore_xtrace=0
case "$-" in
    *x*) __floeterm_terminal_restore_xtrace=1; set +x ;;
esac
unset FLOETERM_SHELL_LIFECYCLE_NONCE __floeterm_terminal_lifecycle_nonce
readonly __floeterm_terminal_lifecycle_nonce=` + shellSingleQuote(nonce) + `
readonly __FLOETERM_SHELL_LIFECYCLE_NONCE_CAPTURED=1
if [ "$__floeterm_terminal_restore_xtrace" = "1" ]; then
    set -x
fi
unset __floeterm_terminal_restore_xtrace
source ` + shellSingleQuote(sharedInitPath) + `
`
	case shellTypeZsh:
		fileName = ".zshrc"
		script = `# Per-session Floeterm lifecycle bootstrap. Removed after the initial handshake.
typeset -g __floeterm_terminal_restore_xtrace=0
if [[ -o xtrace ]]; then
    unsetopt xtrace
    typeset -g __floeterm_terminal_restore_xtrace=1
fi
unset FLOETERM_SHELL_LIFECYCLE_NONCE __floeterm_terminal_lifecycle_nonce
typeset -gr __floeterm_terminal_lifecycle_nonce=` + shellSingleQuote(nonce) + `
typeset -gr __FLOETERM_SHELL_LIFECYCLE_NONCE_CAPTURED=1
if [[ "$__floeterm_terminal_restore_xtrace" = "1" ]]; then
    setopt xtrace
fi
unset __floeterm_terminal_restore_xtrace
source ` + shellSingleQuote(sharedInitPath) + `
`
	default:
		return nil, fmt.Errorf("authenticated shell lifecycle bootstrap is unavailable")
	}

	path := filepath.Join(dir, fileName)
	if err := writePrivateFileContext(ctx, path, script); err != nil {
		return nil, err
	}
	bootstrap.file = path
	return bootstrap, nil
}

func writePrivateFileContext(ctx context.Context, path, content string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return fmt.Errorf("failed to write private shell bootstrap: %w", err)
	}
	return nil
}

func bashInitScript(enableCommandLifecycle bool) string {
	script := `#!/bin/bash
# floeterm shell integration - auto-generated, do not edit.
` + shellInitVersionMarker + `

`
	if enableCommandLifecycle {
		script += bashLifecycleNonceCaptureScript()
		script += `if [ -z "${__FLOETERM_COMMAND_LIFECYCLE_LOADED:-}" ]; then
`
	}
	script += `
# Source user's original bash configuration.
if [ -f "$HOME/.bashrc" ]; then
    source "$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
    source "$HOME/.bash_profile"
elif [ -f "$HOME/.profile" ]; then
    source "$HOME/.profile"
fi

# Inject floeterm paths (after user's rc to take priority).
if [ -n "$` + pathPrependEnvKey + `" ]; then
    export PATH="$` + pathPrependEnvKey + `:$PATH"
fi
`
	if !enableCommandLifecycle {
		return script
	}
	return script + "fi\n" + bashCommandLifecycleScript()
}

func zshInitScript(enableCommandLifecycle bool) string {
	homeDir, _ := os.UserHomeDir()
	if homeDir == "" {
		homeDir = "$HOME"
	}
	return zshInitScriptForHome(enableCommandLifecycle, homeDir)
}

func zshInitScriptForHome(enableCommandLifecycle bool, homeDir string) string {
	script := `# floeterm shell integration - auto-generated, do not edit.
` + shellInitVersionMarker + `

`
	if enableCommandLifecycle {
		script += zshLifecycleNonceCaptureScript()
		script += `if [[ -z "${__FLOETERM_COMMAND_LIFECYCLE_LOADED:-}" ]]; then
`
	}
	script += fmt.Sprintf(`
# Restore original ZDOTDIR for nested shells.
if [ -n "$%s" ]; then
    export ZDOTDIR="$%s"
else
    unset ZDOTDIR
fi

# Source user's original zsh configuration.
if [ -f "%s/.zshrc" ]; then
    source "%s/.zshrc"
elif [ -f "%s/.zprofile" ]; then
    source "%s/.zprofile"
fi

# Inject floeterm paths (after user's rc to take priority).
if [ -n "$%s" ]; then
    export PATH="$%s:$PATH"
fi
`, originalZdotdirEnvKey, originalZdotdirEnvKey, homeDir, homeDir, homeDir, homeDir, pathPrependEnvKey, pathPrependEnvKey)
	if !enableCommandLifecycle {
		return script
	}
	return script + "fi\n" + zshCommandLifecycleScript()
}

func fishInitScript(enableCommandLifecycle bool) string {
	script := `# floeterm shell integration - auto-generated, do not edit.

`
	if enableCommandLifecycle {
		script += `if not set -q __FLOETERM_COMMAND_LIFECYCLE_LOADED
`
	}
	script += `
# Inject floeterm paths (after user's config to take priority).
if set -q ` + pathPrependEnvKey + `
    set -l prepend_paths (string split ':' $` + pathPrependEnvKey + `)
    for p in $prepend_paths
        if not contains $p $PATH
            set -gx PATH $p $PATH
        end
    end
end
`
	if !enableCommandLifecycle {
		return script
	}
	return script + "end\n" + fishCommandLifecycleScript()
}

func posixInitScript() string {
	return `#!/bin/sh
# floeterm shell integration - auto-generated, do not edit.

# Source user's original profile.
if [ -f "$HOME/.profile" ]; then
    . "$HOME/.profile"
fi

# Inject floeterm paths (after user's profile to take priority).
if [ -n "$` + pathPrependEnvKey + `" ]; then
    export PATH="$` + pathPrependEnvKey + `:$PATH"
fi
`
}

func bashLifecycleNonceCaptureScript() string {
	return `# Capture the private lifecycle nonce before any user configuration runs.
__floeterm_terminal_restore_xtrace=0
case "$-" in
    *x*) __floeterm_terminal_restore_xtrace=1; set +x ;;
esac
if [ -z "${__FLOETERM_SHELL_LIFECYCLE_NONCE_CAPTURED+x}" ]; then
    unset __floeterm_terminal_lifecycle_nonce
    __floeterm_terminal_lifecycle_nonce="${FLOETERM_SHELL_LIFECYCLE_NONCE:-}"
    export -n __floeterm_terminal_lifecycle_nonce
    readonly __floeterm_terminal_lifecycle_nonce
    readonly __FLOETERM_SHELL_LIFECYCLE_NONCE_CAPTURED=1
fi
unset FLOETERM_SHELL_LIFECYCLE_NONCE
if [ "$__floeterm_terminal_restore_xtrace" = "1" ]; then
    set -x
fi
unset __floeterm_terminal_restore_xtrace
`
}

func zshLifecycleNonceCaptureScript() string {
	return `# Capture the private lifecycle nonce before any user configuration runs.
typeset -g __floeterm_terminal_restore_xtrace=0
if [[ -o xtrace ]]; then
    unsetopt xtrace
    typeset -g __floeterm_terminal_restore_xtrace=1
fi
if [[ -z "${__FLOETERM_SHELL_LIFECYCLE_NONCE_CAPTURED+x}" ]]; then
    unset __floeterm_terminal_lifecycle_nonce
    typeset -g __floeterm_terminal_lifecycle_nonce="${FLOETERM_SHELL_LIFECYCLE_NONCE:-}"
    typeset +x __floeterm_terminal_lifecycle_nonce
    typeset -gr __floeterm_terminal_lifecycle_nonce
    typeset -gr __FLOETERM_SHELL_LIFECYCLE_NONCE_CAPTURED=1
fi
unset FLOETERM_SHELL_LIFECYCLE_NONCE
if [[ "$__floeterm_terminal_restore_xtrace" = "1" ]]; then
    setopt xtrace
fi
unset __floeterm_terminal_restore_xtrace
`
}

func bashCommandLifecycleScript() string {
	return bashLifecycleNonceCaptureScript() + `
# Emit OSC 633 command lifecycle and working-directory markers.
__floeterm_terminal_osc() {
    printf '\033]633;%s\a' "$1"
}

__floeterm_terminal_authenticated_lifecycle() {
    local restore_xtrace=0
    case "$-" in
        *x*) restore_xtrace=1; set +x ;;
    esac
    if [ -n "$__floeterm_terminal_lifecycle_nonce" ]; then
        __floeterm_terminal_osc "P;FloetermLifecycle=v1;nonce=$__floeterm_terminal_lifecycle_nonce;event=$1"
    fi
    if [ "$restore_xtrace" = "1" ]; then
        set -x
    fi
}

__floeterm_terminal_emit_cwd() {
    if [ -n "${PWD:-}" ]; then
        __floeterm_terminal_osc "P;Cwd=$PWD"
    fi
}

__floeterm_terminal_extract_program() {
    local command_text="$1"
    local word=""
    __floeterm_terminal_program=""
    while :; do
        command_text="${command_text#"${command_text%%[![:space:]]*}"}"
        [ -n "$command_text" ] || return 1
        word="${command_text%%[[:space:]]*}"
        command_text="${command_text#"$word"}"
        case "$word" in
            env)
                while :; do
                    command_text="${command_text#"${command_text%%[![:space:]]*}"}"
                    word="${command_text%%[[:space:]]*}"
                    case "$word" in
                        -*|*=*) command_text="${command_text#"$word"}" ;;
                        *) break ;;
                    esac
                done
                ;;
            command|builtin|exec|nohup)
                ;;
            *)
                break
                ;;
        esac
    done
    word="${word##*/}"
    case "$word" in
        ''|*[!A-Za-z0-9._+@-]*) return 1 ;;
    esac
    [ "${#word}" -le 64 ] || return 1
    __floeterm_terminal_program="$word"
}

__floeterm_terminal_command_start() {
    local command_text="$1"
    if [ "${__floeterm_terminal_at_prompt:-0}" = "1" ]; then
        __floeterm_terminal_at_prompt=0
        __floeterm_terminal_command_running=1
        __floeterm_terminal_osc "B"
        if __floeterm_terminal_extract_program "$command_text"; then
            __floeterm_terminal_osc "P;FloetermProgram=$__floeterm_terminal_program"
        fi
        __floeterm_terminal_osc "C"
    fi
}

__floeterm_terminal_prompt_begin() {
    return "${__floeterm_terminal_last_status:-0}"
}

__floeterm_terminal_precmd() {
    local exit_code="${__floeterm_terminal_last_status:-0}"
    if [ "${__floeterm_terminal_prompt_seen:-0}" = "1" ] && [ "${__floeterm_terminal_command_running:-0}" = "1" ]; then
        __floeterm_terminal_osc "D;$exit_code"
        __floeterm_terminal_authenticated_lifecycle command_finished
    fi
    __floeterm_terminal_prompt_seen=1
    __floeterm_terminal_command_running=0
    __floeterm_terminal_at_prompt=1
    __floeterm_terminal_emit_cwd
    __floeterm_terminal_osc "A"
    __floeterm_terminal_authenticated_lifecycle prompt_ready
    __floeterm_terminal_in_prompt_command=0
    return "$exit_code"
}

if [ -z "${__FLOETERM_COMMAND_LIFECYCLE_LOADED:-}" ]; then
    readonly __FLOETERM_COMMAND_LIFECYCLE_LOADED=1
    __floeterm_terminal_existing_debug_trap=""
    if __floeterm_terminal_trap_output=$(trap -p DEBUG 2>/dev/null); then
        __floeterm_terminal_existing_debug_trap=$(printf '%s\n' "$__floeterm_terminal_trap_output" | sed -E "s/^trap -- '(.*)' DEBUG$/\1/")
    fi
    __floeterm_terminal_restore_status() {
        return "$1"
    }
    __floeterm_terminal_debug_trap() {
        local debug_status="$1"
        local debug_command="$2"
        local debug_function=""
        __floeterm_terminal_debug_status="$debug_status"
        __floeterm_terminal_forward_existing_debug=1
        case "$debug_command" in
            __floeterm_terminal_prompt_begin|__floeterm_terminal_precmd)
                __floeterm_terminal_forward_existing_debug=0
                ;;
        esac
        for debug_function in "${FUNCNAME[@]:1}"; do
            case "$debug_function" in
                __floeterm_terminal_prompt_begin|__floeterm_terminal_precmd|__floeterm_terminal_emit_cwd)
                    __floeterm_terminal_forward_existing_debug=0
                    break
                    ;;
            esac
        done
        if [ "$debug_command" = "__floeterm_terminal_prompt_begin" ]; then
            __floeterm_terminal_last_status="$debug_status"
            __floeterm_terminal_in_prompt_command=1
        elif [ "${__floeterm_terminal_in_prompt_command:-0}" != "1" ]; then
            __floeterm_terminal_command_start "$debug_command"
        fi
        return "$debug_status"
    }
    __floeterm_terminal_debug_trap_body='__floeterm_terminal_debug_trap "$?" "$BASH_COMMAND"'
    if [ -n "${__floeterm_terminal_existing_debug_trap:-}" ]; then
        __floeterm_terminal_debug_trap_body="${__floeterm_terminal_debug_trap_body}; if [ \"\$__floeterm_terminal_forward_existing_debug\" = \"1\" ]; then __floeterm_terminal_restore_status \"\$__floeterm_terminal_debug_status\"; ${__floeterm_terminal_existing_debug_trap}; fi"
    fi
    __floeterm_terminal_debug_trap_body="${__floeterm_terminal_debug_trap_body}; __floeterm_terminal_restore_status \"\$__floeterm_terminal_debug_status\""
    trap "$__floeterm_terminal_debug_trap_body" DEBUG
    unset __floeterm_terminal_debug_trap_body
    __floeterm_terminal_prompt_command_declaration="$(declare -p PROMPT_COMMAND 2>/dev/null || true)"
    case "$__floeterm_terminal_prompt_command_declaration" in
        "declare -a "*)
            PROMPT_COMMAND=(__floeterm_terminal_prompt_begin "${PROMPT_COMMAND[@]}" __floeterm_terminal_precmd)
            ;;
        *)
            if [ -n "${PROMPT_COMMAND:-}" ]; then
                PROMPT_COMMAND="__floeterm_terminal_prompt_begin
${PROMPT_COMMAND}
__floeterm_terminal_precmd"
            else
                PROMPT_COMMAND="__floeterm_terminal_prompt_begin
__floeterm_terminal_precmd"
            fi
            ;;
    esac
    unset __floeterm_terminal_prompt_command_declaration
    __floeterm_terminal_authenticated_lifecycle integration_ready
fi
`
}

func zshCommandLifecycleScript() string {
	return zshLifecycleNonceCaptureScript() + `
# Emit OSC 633 command lifecycle and working-directory markers.
__floeterm_terminal_osc() {
    printf '\033]633;%s\a' "$1"
}

__floeterm_terminal_authenticated_lifecycle() {
    local restore_xtrace=0
    if [[ -o xtrace ]]; then
        unsetopt xtrace
        restore_xtrace=1
    fi
    if [[ -n "$__floeterm_terminal_lifecycle_nonce" ]]; then
        __floeterm_terminal_osc "P;FloetermLifecycle=v1;nonce=$__floeterm_terminal_lifecycle_nonce;event=$1"
    fi
    if [[ "$restore_xtrace" = "1" ]]; then
        setopt xtrace
    fi
}

__floeterm_terminal_emit_cwd() {
    if [ -n "${PWD:-}" ]; then
        __floeterm_terminal_osc "P;Cwd=$PWD"
    fi
}

__floeterm_terminal_extract_program() {
    local -a words
    local word
    words=(${(z)1})
    while (( ${#words[@]} > 0 )); do
        word="$words[1]"
        words=("${words[@]:1}")
        case "$word" in
            env)
                while (( ${#words[@]} > 0 )) && [[ "$words[1]" == -* || "$words[1]" == *=* ]]; do
                    words=("${words[@]:1}")
                done
                ;;
            command|builtin|exec|nohup)
                ;;
            *)
                break
                ;;
        esac
    done
    word="${word:t}"
    [[ -n "$word" && ${#word} -le 64 && "$word" != *[^A-Za-z0-9._+@-]* ]] || return 1
    __floeterm_terminal_program="$word"
}

__floeterm_terminal_preexec() {
    __floeterm_terminal_command_running=1
    __floeterm_terminal_osc "B"
    if __floeterm_terminal_extract_program "$1"; then
        __floeterm_terminal_osc "P;FloetermProgram=$__floeterm_terminal_program"
    fi
    __floeterm_terminal_osc "C"
}

__floeterm_terminal_precmd() {
    local exit_code=$?
    if [[ "${__floeterm_terminal_prompt_seen:-0}" = "1" && "${__floeterm_terminal_command_running:-0}" = "1" ]]; then
        __floeterm_terminal_osc "D;$exit_code"
        __floeterm_terminal_authenticated_lifecycle command_finished
    fi
    __floeterm_terminal_prompt_seen=1
    __floeterm_terminal_command_running=0
    __floeterm_terminal_emit_cwd
    __floeterm_terminal_osc "A"
    __floeterm_terminal_authenticated_lifecycle prompt_ready
}

if [[ -z "${__FLOETERM_COMMAND_LIFECYCLE_LOADED:-}" ]]; then
    typeset -gr __FLOETERM_COMMAND_LIFECYCLE_LOADED=1
    typeset -g __floeterm_terminal_hooks_installed=0
    if typeset -ga preexec_functions precmd_functions 2>/dev/null; then
        typeset -g __floeterm_terminal_preexec_declaration __floeterm_terminal_precmd_declaration
        typeset -g __floeterm_terminal_preexec_flags __floeterm_terminal_precmd_flags
        __floeterm_terminal_preexec_declaration="$(typeset -p preexec_functions 2>/dev/null)"
        __floeterm_terminal_precmd_declaration="$(typeset -p precmd_functions 2>/dev/null)"
        __floeterm_terminal_preexec_flags="${${(z)__floeterm_terminal_preexec_declaration}[2]}"
        __floeterm_terminal_precmd_flags="${${(z)__floeterm_terminal_precmd_declaration}[2]}"
        if [[ "$__floeterm_terminal_preexec_flags" != *r* && "$__floeterm_terminal_precmd_flags" != *r* ]]; then
            typeset -ga __floeterm_terminal_original_preexec_functions __floeterm_terminal_original_precmd_functions
            __floeterm_terminal_original_preexec_functions=("${preexec_functions[@]}")
            __floeterm_terminal_original_precmd_functions=("${precmd_functions[@]}")
            if preexec_functions=("${(@)preexec_functions:#__floeterm_terminal_preexec}" __floeterm_terminal_preexec) 2>/dev/null &&
               precmd_functions=("${(@)precmd_functions:#__floeterm_terminal_precmd}" __floeterm_terminal_precmd) 2>/dev/null &&
               (( ${preexec_functions[(Ie)__floeterm_terminal_preexec]} > 0 )) &&
               (( ${precmd_functions[(Ie)__floeterm_terminal_precmd]} > 0 )); then
                __floeterm_terminal_hooks_installed=1
            else
                preexec_functions=("${__floeterm_terminal_original_preexec_functions[@]}") 2>/dev/null || true
                precmd_functions=("${__floeterm_terminal_original_precmd_functions[@]}") 2>/dev/null || true
            fi
            unset __floeterm_terminal_original_preexec_functions __floeterm_terminal_original_precmd_functions
        fi
        unset __floeterm_terminal_preexec_declaration __floeterm_terminal_precmd_declaration
        unset __floeterm_terminal_preexec_flags __floeterm_terminal_precmd_flags
    fi
    if [[ "$__floeterm_terminal_hooks_installed" = "1" ]]; then
        __floeterm_terminal_authenticated_lifecycle integration_ready
    fi
    unset __floeterm_terminal_hooks_installed
fi
`
}

func fishCommandLifecycleScript() string {
	return `# Emit OSC 633 command lifecycle and working-directory markers.
function __floeterm_terminal_osc --argument payload
    printf '\e]633;%s\a' $payload
end

function __floeterm_terminal_emit_cwd
    if test -n "$PWD"
        __floeterm_terminal_osc "P;Cwd=$PWD"
    end
end

function __floeterm_terminal_extract_program --argument command_text
    set -g __floeterm_terminal_program ""
    set -l words (string split -n ' ' -- $command_text)
    while test (count $words) -gt 0
        set -l word $words[1]
        set -e words[1]
        switch $word
            case env
                while test (count $words) -gt 0
                    if string match -qr '^(-|[^=]+=)' -- $words[1]
                        set -e words[1]
                    else
                        break
                    end
                end
            case command builtin exec nohup
            case '*'
                set word (string split -r -m 1 '/' -- $word)[-1]
                if string match -rq '^[A-Za-z0-9._+@-]{1,64}$' -- $word
                    set -g __floeterm_terminal_program $word
                    return 0
                end
                return 1
        end
    end
    return 1
end

set -g __floeterm_terminal_prompt_seen 0
set -g __floeterm_terminal_command_running 0

function __floeterm_terminal_fish_preexec --on-event fish_preexec
    set -g __floeterm_terminal_command_running 1
    __floeterm_terminal_osc B
    if __floeterm_terminal_extract_program "$argv"
        __floeterm_terminal_osc "P;FloetermProgram=$__floeterm_terminal_program"
    end
    __floeterm_terminal_osc C
end

function __floeterm_terminal_fish_postexec --on-event fish_postexec
    if test "$__floeterm_terminal_prompt_seen" = "1" -a "$__floeterm_terminal_command_running" = "1"
        __floeterm_terminal_osc "D;$status"
    end
    set -g __floeterm_terminal_command_running 0
end

if not set -q __FLOETERM_COMMAND_LIFECYCLE_LOADED
    set -g __FLOETERM_COMMAND_LIFECYCLE_LOADED 1
    if functions -q fish_prompt
        functions -c fish_prompt __floeterm_terminal_original_fish_prompt
    end
    function fish_prompt
        set -g __floeterm_terminal_prompt_seen 1
        __floeterm_terminal_emit_cwd
        __floeterm_terminal_osc A
        if functions -q __floeterm_terminal_original_fish_prompt
            __floeterm_terminal_original_fish_prompt
        end
    end
end
`
}
