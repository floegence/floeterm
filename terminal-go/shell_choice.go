package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

type selectedShell string

func (shell selectedShell) ResolveShell(Logger) string { return string(shell) }

func executableShellPath(path string) bool {
	if !filepath.IsAbs(path) {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return false
	}
	_, err = exec.LookPath(path)
	return err == nil
}

type ShellChoice struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func InstalledShells(defaultShell string) []ShellChoice {
	registry, _ := os.ReadFile("/etc/shells")
	return installedShells(defaultShell, string(registry), exec.LookPath)
}

func installedShells(defaultShell, registry string, lookup func(string) (string, error)) []ShellChoice {
	seen := make(map[string]bool)
	shells := []ShellChoice{}
	add := func(path string) {
		name := filepath.Base(path)
		if seen[name] || name == "false" || name == "true" || name == "nologin" || !executableShellPath(path) {
			return
		}
		seen[name] = true
		shells = append(shells, ShellChoice{Name: name, Path: path})
	}
	add(defaultShell)
	for line := range strings.SplitSeq(registry, "\n") {
		path, _, _ := strings.Cut(line, "#")
		add(strings.TrimSpace(path))
	}
	for _, name := range []string{"bash", "zsh", "fish", "sh", "dash", "ash", "ksh", "mksh", "yash", "tcsh", "csh", "nu", "pwsh"} {
		if path, err := lookup(name); err == nil {
			add(path)
		}
	}
	slices.SortFunc(shells, func(left, right ShellChoice) int { return strings.Compare(left.Name, right.Name) })
	return shells
}

func ProgramThroughShell(shell string, program Program) (Program, error) {
	if !executableShellPath(shell) {
		return Program{}, fmt.Errorf("shell unavailable: %q", shell)
	}
	program, err := program.validatedCopy()
	if err != nil {
		return Program{}, err
	}
	if !filepath.IsAbs(program.Executable) {
		return Program{}, fmt.Errorf("shell-launched program requires an absolute executable")
	}
	var prefix []string
	switch filepath.Base(shell) {
	case "fish":
		prefix = []string{"-c", "exec $argv", "--"}
	case "csh", "tcsh":
		var script strings.Builder
		script.WriteString("exec")
		for index := range len(program.Args) + 1 {
			if index > 0 && program.Args[index-1] == "" {
				script.WriteString(` ""`)
			} else {
				fmt.Fprintf(&script, ` $argv[%d]:q`, index+1)
			}
		}
		prefix = []string{"-f", "-c", script.String()}
	case "nu", "pwsh":
		return Program{}, fmt.Errorf("shell %q does not support exact-argv program launch", shell)
	default:
		prefix = []string{"-c", `exec "$@"`, "floeterm"}
	}
	return Program{Executable: shell, Args: append(append(prefix, program.Executable), program.Args...), Env: program.Env}, nil
}
