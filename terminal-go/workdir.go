package terminal

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const maxWorkdirPendingBytes = 4096

type cwdSignal struct {
	path   string
	source string
}

// shouldCheckDirectoryChange determines whether output may contain an explicit
// working directory signal. Generic title updates are intentionally excluded.
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
	return false
}

// checkWorkingDirectoryChange parses PTY output as a stream and emits name
// updates when explicit cwd markers are observed.
func (s *Session) checkWorkingDirectoryChange(chunk []byte) {
	signals, malformedSources := s.consumeWorkingDirectorySignals(chunk)
	for _, source := range malformedSources {
		s.config.logger.Debug("Discarded malformed working directory sequence", "sessionID", s.ID, "source", source)
	}
	for _, signal := range signals {
		s.applyWorkingDirectoryChange(signal.path)
	}
}

func (s *Session) consumeWorkingDirectorySignals(chunk []byte) ([]cwdSignal, []string) {
	s.mu.Lock()
	buffer := append(make([]byte, 0, len(s.workdirPending)+len(chunk)), s.workdirPending...)
	buffer = append(buffer, chunk...)
	signals, malformedSources, pending := parseWorkingDirectorySignals(buffer)
	s.workdirPending = pending
	s.mu.Unlock()
	return signals, malformedSources
}

func parseWorkingDirectorySignals(buffer []byte) ([]cwdSignal, []string, []byte) {
	if len(buffer) == 0 {
		return nil, nil, nil
	}

	var (
		signals          []cwdSignal
		malformedSources []string
	)

	for index := 0; index < len(buffer); {
		start := indexOSCSequenceStart(buffer[index:])
		if start == -1 {
			return signals, malformedSources, nil
		}
		start += index

		payloadEnd, nextIndex, complete := findOSCTerminator(buffer, start+2)
		if !complete {
			return signals, malformedSources, clonePendingWorkdirFragment(buffer[start:])
		}

		payload := string(buffer[start+2 : payloadEnd])
		if signal, malformed, ok := parseWorkingDirectorySignalPayload(payload); ok {
			if malformed {
				malformedSources = append(malformedSources, signal.source)
			} else {
				signals = append(signals, signal)
			}
		}

		index = nextIndex
	}

	return signals, malformedSources, nil
}

func indexOSCSequenceStart(buffer []byte) int {
	for index := 0; index+1 < len(buffer); index++ {
		if buffer[index] == 0x1b && buffer[index+1] == ']' {
			return index
		}
	}
	return -1
}

func findOSCTerminator(buffer []byte, start int) (payloadEnd int, nextIndex int, complete bool) {
	for index := start; index < len(buffer); index++ {
		if buffer[index] == 0x07 {
			return index, index + 1, true
		}
		if buffer[index] == 0x1b {
			if index+1 >= len(buffer) {
				return 0, 0, false
			}
			if buffer[index+1] == '\\' {
				return index, index + 2, true
			}
		}
	}
	return 0, 0, false
}

func clonePendingWorkdirFragment(fragment []byte) []byte {
	if len(fragment) == 0 {
		return nil
	}
	if len(fragment) > maxWorkdirPendingBytes {
		fragment = fragment[len(fragment)-maxWorkdirPendingBytes:]
	}
	out := make([]byte, len(fragment))
	copy(out, fragment)
	return out
}

// parseWorkingDirectory extracts a working directory path from a complete
// output string. This helper remains useful for unit tests and non-streaming
// callers, but only trusts explicit cwd protocols.
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
	return ""
}

func parseWorkingDirectorySignalPayload(payload string) (cwdSignal, bool, bool) {
	if strings.HasPrefix(payload, "633;P;Cwd=") {
		path := normalizeExplicitWorkingDirectory(payload[len("633;P;Cwd="):])
		if path == "" {
			return cwdSignal{source: "osc_633"}, true, true
		}
		return cwdSignal{path: path, source: "osc_633"}, false, true
	}
	if strings.HasPrefix(payload, "1337;CurrentDir=") {
		path := normalizeExplicitWorkingDirectory(payload[len("1337;CurrentDir="):])
		if path == "" {
			return cwdSignal{source: "osc_1337"}, true, true
		}
		return cwdSignal{path: path, source: "osc_1337"}, false, true
	}
	if strings.HasPrefix(payload, "7;file://") {
		path, ok := parseOSC7Payload(payload)
		if !ok {
			return cwdSignal{source: "osc_7"}, true, true
		}
		return cwdSignal{path: path, source: "osc_7"}, false, true
	}
	return cwdSignal{}, false, false
}

func normalizeExplicitWorkingDirectory(raw string) string {
	path := strings.TrimSpace(raw)
	if path == "" {
		return ""
	}
	if strings.HasPrefix(path, "~") {
		path = expandHomeDirectory(path)
	}
	if path == "" || !filepath.IsAbs(path) {
		return ""
	}
	return filepath.Clean(path)
}

func expandHomeDirectory(path string) string {
	homeDir, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(homeDir) == "" {
		return ""
	}

	switch {
	case path == "~":
		return homeDir
	case strings.HasPrefix(path, "~/"):
		return filepath.Join(homeDir, path[2:])
	default:
		return ""
	}
}

func parseOSC7Payload(payload string) (string, bool) {
	urlPart := payload[len("7;file://"):]
	slashIndex := strings.Index(urlPart, "/")
	if slashIndex == -1 {
		return "", false
	}

	path := urlPart[slashIndex:]
	decodedPath, err := url.QueryUnescape(path)
	if err == nil {
		path = decodedPath
	}

	path = normalizeExplicitWorkingDirectory(path)
	if path == "" {
		return "", false
	}
	return path, true
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
	path, ok := parseOSC7Payload(sequence[2 : len(sequence)-2])
	if !ok {
		return ""
	}
	return path
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
	return normalizeExplicitWorkingDirectory(sequence[len("\x1b]633;P;Cwd=") : len(sequence)-1])
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
	return normalizeExplicitWorkingDirectory(sequence[len("\x1b]1337;CurrentDir=") : len(sequence)-1])
}

func (s *Session) applyWorkingDirectoryChange(currentDir string) {
	if currentDir == "" {
		return
	}

	newName := getDirectoryName(currentDir)

	// Protect currentWorkingDir/Name reads and updates.
	s.mu.Lock()
	oldDir := s.currentWorkingDir
	shouldRename := newName != s.Name
	if currentDir == oldDir {
		s.mu.Unlock()
		return
	}
	s.currentWorkingDir = currentDir
	s.WorkingDir = currentDir
	s.mu.Unlock()

	s.config.logger.Info("Working directory changed", "sessionID", s.ID, "from", filepath.Base(oldDir), "to", filepath.Base(currentDir))

	if shouldRename {
		s.onSessionNameChange(newName, currentDir)
	}
}

func (s *Session) onSessionNameChange(newName, workingDir string) {
	s.mu.RLock()
	oldName := s.Name
	handler := s.eventHandler
	sessionID := s.ID
	s.mu.RUnlock()

	s.mu.Lock()
	s.Name = newName
	s.mu.Unlock()

	s.config.logger.Info("Updated session name", "sessionID", sessionID, "oldName", oldName, "newName", newName)

	// Never call external handlers while holding locks.
	if handler != nil {
		handler.OnTerminalNameChanged(sessionID, oldName, newName, workingDir)
	}
}
