package terminal

import (
	"errors"
	"strings"
)

// Program describes one executable and its exact argument vector.
// It is never parsed or evaluated by a shell.
type Program struct {
	Executable string
	Args       []string
	Env        []string
}

func (p Program) validatedCopy() (Program, error) {
	if p.Executable == "" {
		return Program{}, errors.New("program executable is required")
	}
	if strings.ContainsRune(p.Executable, '\x00') {
		return Program{}, errors.New("program executable contains a NUL byte")
	}
	copyProgram := Program{
		Executable: p.Executable,
		Args:       append([]string(nil), p.Args...),
		Env:        append([]string(nil), p.Env...),
	}
	for _, arg := range copyProgram.Args {
		if strings.ContainsRune(arg, '\x00') {
			return Program{}, errors.New("program argument contains a NUL byte")
		}
	}
	for _, entry := range copyProgram.Env {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || key == "" || strings.ContainsRune(entry, '\x00') {
			return Program{}, errors.New("invalid program environment entry")
		}
	}
	return copyProgram, nil
}

// ProgramObservation returns the live program PID and VT window title without cloning its frame.
func (s *Session) ProgramObservation() (pid int, title string) {
	s.mu.RLock()
	if s.config.program == nil || s.closed || !s.isActive || s.Cmd == nil || s.Cmd.Process == nil || channelClosed(s.procWaitDone) {
		s.mu.RUnlock()
		return 0, ""
	}
	pid, actor := s.Cmd.Process.Pid, s.semanticActor
	s.mu.RUnlock()
	if actor != nil {
		actor.mu.Lock()
		defer actor.mu.Unlock()
		if source, ok := actor.engine.(interface{ windowTitle() string }); ok {
			return pid, source.windowTitle()
		}
	}
	return pid, ""
}
