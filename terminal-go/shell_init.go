package terminal

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	pathPrependEnvKey      = "FLOETERM_PATH_PREPEND"
	originalZdotdirEnvKey  = "FLOETERM_ORIGINAL_ZDOTDIR"
	defaultShellInitFolder = "shell-init"
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
	BaseDir string
}

func (w DefaultShellInitWriter) EnsureShellInitFiles(pathPrepend string) error {
	if strings.TrimSpace(pathPrepend) == "" {
		return nil
	}

	paths := newShellInitPaths(w.BaseDir)

	if err := os.MkdirAll(paths.BaseDir(), 0o755); err != nil {
		return fmt.Errorf("failed to create shell init directory: %w", err)
	}
	if err := os.MkdirAll(paths.ZshDir(), 0o755); err != nil {
		return fmt.Errorf("failed to create zsh init directory: %w", err)
	}

	if err := writeFile(paths.BashRC(), bashInitScript()); err != nil {
		return err
	}
	if err := writeFile(paths.ZshRC(), zshInitScript()); err != nil {
		return err
	}
	if err := writeFile(paths.FishConfig(), fishInitScript()); err != nil {
		return err
	}
	if err := writeFile(paths.PosixRC(), posixInitScript()); err != nil {
		return err
	}

	return nil
}

func writeFile(path string, content string) error {
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fmt.Errorf("failed to write %s: %w", filepath.Base(path), err)
	}
	return nil
}

func bashInitScript() string {
	return `#!/bin/bash
# floeterm shell integration - auto-generated, do not edit.

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
}

func zshInitScript() string {
	homeDir, _ := os.UserHomeDir()
	if homeDir == "" {
		homeDir = "$HOME"
	}

	return fmt.Sprintf(`# floeterm shell integration - auto-generated, do not edit.

# Restore original ZDOTDIR for nested shells.
if [ -n "$%s" ]; then
    export ZDOTDIR="$%s"
else
    unset ZDOTDIR
fi

# Source global zsh configs first (system-wide).
if [ -f /etc/zsh/zshenv ]; then
    source /etc/zsh/zshenv
fi
if [ -f /etc/zsh/zshrc ]; then
    source /etc/zsh/zshrc
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
}

func fishInitScript() string {
	homeDir, _ := os.UserHomeDir()
	if homeDir == "" {
		homeDir = "$HOME"
	}

	return fmt.Sprintf(`# floeterm shell integration - auto-generated, do not edit.

# Source user's original fish configuration.
if test -f "%s/.config/fish/config.fish"
    source "%s/.config/fish/config.fish"
end

# Inject floeterm paths (after user's config to take priority).
if set -q %s
    set -l prepend_paths (string split ':' $%s)
    for p in $prepend_paths
        if not contains $p $PATH
            set -gx PATH $p $PATH
        end
    end
end
`, homeDir, homeDir, pathPrependEnvKey, pathPrependEnvKey)
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
