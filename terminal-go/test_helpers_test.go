package terminal

type testShellResolver struct{ shell string }

func (r testShellResolver) ResolveShell(Logger) string { return r.shell }

type testShellArgsProvider struct{}

func (testShellArgsProvider) GetShellArgs(string, string) ([]string, []string) {
	return []string{"-c", "printf 'ready\\n'; cat"}, nil
}

type quickExitShellArgsProvider struct{}

func (quickExitShellArgsProvider) GetShellArgs(string, string) ([]string, []string) {
	return []string{"-c", "exit 0"}, nil
}
