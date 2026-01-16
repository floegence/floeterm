package terminal

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// shouldCheckDirectoryChange determines whether output may contain working directory hints.
// Priority order matches common terminal integrations:
// VSCode (OSC 633) > iTerm2 (OSC 1337) > OSC 7 > OSC 0/2 (title).
func (s *Session) shouldCheckDirectoryChange(output string) bool {
	if strings.Contains(output, "\x1b]633;P;Cwd=") {
		return true
	}
	if strings.Contains(output, "\x1b]1337;CurrentDir=") {
		return true
	}
	if strings.Contains(output, "\x1b]7;file://") {
		return true
	}
	if strings.Contains(output, "\x1b]0;") || strings.Contains(output, "\x1b]2;") {
		return true
	}
	return false
}

// checkWorkingDirectoryChange parses output and emits name updates if needed.
func (s *Session) checkWorkingDirectoryChange(output string) {
	currentDir := s.parseWorkingDirectory(output)
	if currentDir == "" {
		s.config.logger.Debug("Failed to parse working directory", "sessionID", s.ID)
		return
	}

	if currentDir == s.currentWorkingDir {
		return
	}

	s.config.logger.Info("Working directory changed", "sessionID", s.ID, "from", filepath.Base(s.currentWorkingDir), "to", filepath.Base(currentDir))

	s.currentWorkingDir = currentDir
	newName := getDirectoryName(currentDir)

	if newName != s.Name {
		s.onSessionNameChange(newName, currentDir)
	}
}

// parseWorkingDirectory extracts a working directory path from output.
func (s *Session) parseWorkingDirectory(output string) string {
	if path := s.parseVSCodeCwdSequence(output); path != "" {
		return path
	}
	if path := s.parseITerm2CurrentDirSequence(output); path != "" {
		return path
	}
	if path := s.parseOSC7Sequence(output); path != "" {
		return path
	}
	if path := s.parseOSCTitleSequence(output); path != "" {
		return path
	}
	return ""
}

// parseOSC7Sequence parses standard OSC 7 sequences: ESC ] 7 ; file://host/path ST.
func (s *Session) parseOSC7Sequence(output string) string {
	start := strings.Index(output, "\x1b]7;file://")
	if start == -1 {
		return ""
	}

	end := strings.Index(output[start:], "\x1b\\")
	if end == -1 {
		return ""
	}

	sequence := output[start : start+end+2]
	urlPart := sequence[len("\x1b]7;file://") : len(sequence)-2]

	slashIndex := strings.Index(urlPart, "/")
	if slashIndex == -1 {
		return ""
	}

	path := urlPart[slashIndex:]
	decodedPath, err := url.QueryUnescape(path)
	if err != nil {
		return path
	}
	return decodedPath
}

// parseVSCodeCwdSequence parses VSCode shell integration: ESC ] 633 ; P ; Cwd=/path BEL.
func (s *Session) parseVSCodeCwdSequence(output string) string {
	start := strings.Index(output, "\x1b]633;P;Cwd=")
	if start == -1 {
		return ""
	}

	end := strings.Index(output[start:], "\a")
	if end == -1 {
		return ""
	}

	sequence := output[start : start+end+1]
	return sequence[len("\x1b]633;P;Cwd=") : len(sequence)-1]
}

// parseITerm2CurrentDirSequence parses iTerm2 integration: ESC ] 1337 ; CurrentDir=/path BEL.
func (s *Session) parseITerm2CurrentDirSequence(output string) string {
	start := strings.Index(output, "\x1b]1337;CurrentDir=")
	if start == -1 {
		return ""
	}

	end := strings.Index(output[start:], "\a")
	if end == -1 {
		return ""
	}

	sequence := output[start : start+end+1]
	return sequence[len("\x1b]1337;CurrentDir=") : len(sequence)-1]
}

// parseOSCTitleSequence tries OSC 0/2 title sequences as a fallback.
func (s *Session) parseOSCTitleSequence(output string) string {
	if path := s.extractPathFromOSCTitle(output, "\x1b]0;"); path != "" {
		return path
	}
	return s.extractPathFromOSCTitle(output, "\x1b]2;")
}

func (s *Session) extractPathFromOSCTitle(output, prefix string) string {
	start := strings.Index(output, prefix)
	if start == -1 {
		return ""
	}

	remaining := output[start+len(prefix):]
	var end int
	var title string

	if belIdx := strings.Index(remaining, "\a"); belIdx != -1 {
		end = belIdx
		title = remaining[:end]
	} else if stIdx := strings.Index(remaining, "\x1b\\"); stIdx != -1 {
		end = stIdx
		title = remaining[:end]
	} else {
		return ""
	}

	return s.extractPathFromTitle(title)
}

func (s *Session) extractPathFromTitle(title string) string {
	if colonIdx := strings.LastIndex(title, ":"); colonIdx != -1 {
		return s.expandPath(title[colonIdx+1:])
	}

	if strings.HasPrefix(title, "~") || strings.HasPrefix(title, "/") {
		return s.expandPath(title)
	}

	for _, indicator := range []string{"~/", "/"} {
		if idx := strings.Index(title, indicator); idx != -1 {
			pathPart := title[idx:]
			if spaceIdx := strings.Index(pathPart, " "); spaceIdx != -1 {
				pathPart = pathPart[:spaceIdx]
			}
			return s.expandPath(pathPart)
		}
	}

	return ""
}

func (s *Session) expandPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}

	if strings.HasPrefix(path, "~") {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		if path == "~" {
			return homeDir
		}
		path = homeDir + path[1:]
	}

	if info, err := os.Stat(path); err == nil && info.IsDir() {
		return path
	}

	return ""
}

func (s *Session) onSessionNameChange(newName, workingDir string) {
	s.mu.RLock()
	oldName := s.Name
	s.mu.RUnlock()

	s.mu.Lock()
	s.Name = newName
	s.mu.Unlock()

	s.config.logger.Info("Updated session name", "sessionID", s.ID, "oldName", oldName, "newName", newName)

	if s.eventHandler != nil {
		s.eventHandler.OnTerminalNameChanged(s.ID, oldName, newName, workingDir)
	}
}
