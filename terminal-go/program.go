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
	}
	for _, arg := range copyProgram.Args {
		if strings.ContainsRune(arg, '\x00') {
			return Program{}, errors.New("program argument contains a NUL byte")
		}
	}
	return copyProgram, nil
}
