package terminal

import (
    "bufio"
    "os"
    "os/user"
    "path/filepath"
    "strings"
)

// ShellResolver returns the executable path for the login shell.
type ShellResolver interface {
    ResolveShell(logger Logger) string
}

// ShellArgsProvider returns extra argv and env variables for a shell invocation.
// The pathPrepend is computed by the EnvProvider and may be used to inject PATH.
type ShellArgsProvider interface {
    GetShellArgs(shellPath string, pathPrepend string) (args []string, env []string)
}

// ShellInitWriter allows writing shell init files for PATH injection when needed.
type ShellInitWriter interface {
    EnsureShellInitFiles(pathPrepend string) error
}

// DefaultShellResolver implements the shell lookup strategy used by the original agent.
type DefaultShellResolver struct{}

func (DefaultShellResolver) ResolveShell(logger Logger) string {
    if shell := os.Getenv("SHELL"); shell != "" {
        if _, err := os.Stat(shell); err == nil {
            return shell
        }
        logger.Warn("SHELL points to missing file", "shell", shell)
    }

    if shell := resolveShellFromPasswd(logger); shell != "" {
        return shell
    }

    for _, shell := range []string{"/bin/bash", "/bin/zsh", "/bin/sh"} {
        if _, err := os.Stat(shell); err == nil {
            logger.Info("Using fallback shell", "shell", filepath.Base(shell))
            return shell
        }
    }

    logger.Warn("No suitable shell found, using /bin/sh")
    return "/bin/sh"
}

func resolveShellFromPasswd(logger Logger) string {
    currentUser, err := user.Current()
    if err != nil {
        logger.Warn("Failed to resolve current user", "error", err)
        return ""
    }

    passwdFile, err := os.Open("/etc/passwd")
    if err != nil {
        logger.Warn("Failed to open /etc/passwd", "error", err)
        return ""
    }
    defer passwdFile.Close()

    scanner := bufio.NewScanner(passwdFile)
    for scanner.Scan() {
        line := scanner.Text()
        if strings.HasPrefix(line, "#") || strings.TrimSpace(line) == "" {
            continue
        }

        fields := strings.Split(line, ":")
        if len(fields) < 7 {
            continue
        }
        if fields[0] != currentUser.Username {
            continue
        }
        shell := fields[6]
        if _, err := os.Stat(shell); err == nil {
            logger.Info("Found shell from /etc/passwd", "shell", filepath.Base(shell))
            return shell
        }
        logger.Warn("Shell from /etc/passwd missing", "shell", filepath.Base(shell))
    }

    if err := scanner.Err(); err != nil {
        logger.Warn("Error reading /etc/passwd", "error", err)
    }

    return ""
}

// DefaultShellArgsProvider is conservative: it returns no args/env overrides.
type DefaultShellArgsProvider struct{}

func (DefaultShellArgsProvider) GetShellArgs(string, string) ([]string, []string) {
    return nil, nil
}
