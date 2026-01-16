package terminal

import "os"

// ShellEnvProvider builds environment variables for a new PTY session.
// The returned pathPrepend is used for shell init file injection when needed.
type ShellEnvProvider interface {
	BuildEnv(shellPath string, workingDir string) (env []string, pathPrepend string, err error)
}

// DefaultEnvProvider returns the current process environment unchanged.
type DefaultEnvProvider struct{}

func (DefaultEnvProvider) BuildEnv(string, string) ([]string, string, error) {
	return os.Environ(), "", nil
}

// StaticEnvProvider allows callers to provide explicit env and PATH prepends.
type StaticEnvProvider struct {
	Env         []string
	PathPrepend string
}

func (p StaticEnvProvider) BuildEnv(string, string) ([]string, string, error) {
	if len(p.Env) == 0 {
		return os.Environ(), p.PathPrepend, nil
	}
	return append([]string{}, p.Env...), p.PathPrepend, nil
}
