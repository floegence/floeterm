package terminal

import (
	"bytes"
	"strings"
	"time"
)

const (
	maxShellIntegrationPendingBytes = 4096
	maxShellIntegrationPayloadBytes = 4092
	maxForegroundCommandNameBytes   = 64
)

type shellIntegrationSignalKind uint8

const (
	shellIntegrationCwd shellIntegrationSignalKind = iota + 1
	shellIntegrationPromptReady
	shellIntegrationCommandStart
	shellIntegrationCommandExecuted
	shellIntegrationCommandFinished
	shellIntegrationProgram
)

type shellIntegrationSignal struct {
	kind    shellIntegrationSignalKind
	path    string
	program string
}

func normalizeForegroundCommandDisplayName(raw string) (string, bool) {
	if raw == "" || len(raw) > maxForegroundCommandNameBytes {
		return "", false
	}
	for index := 0; index < len(raw); index++ {
		value := raw[index]
		if (value >= 'a' && value <= 'z') ||
			(value >= 'A' && value <= 'Z') ||
			(value >= '0' && value <= '9') ||
			strings.ContainsRune("._+@-", rune(value)) {
			continue
		}
		return "", false
	}
	return raw, true
}

func normalizeForegroundCommandInfo(info TerminalForegroundCommandInfo) TerminalForegroundCommandInfo {
	switch info.Phase {
	case ForegroundCommandIdle, ForegroundCommandRunning:
	default:
		info.Phase = ForegroundCommandUnknown
	}
	if info.Phase != ForegroundCommandRunning {
		info.DisplayName = ""
	} else if normalized, ok := normalizeForegroundCommandDisplayName(info.DisplayName); ok {
		info.DisplayName = normalized
	} else {
		info.DisplayName = ""
	}
	return info
}

func parseShellIntegrationSignals(buffer []byte) ([]shellIntegrationSignal, []string, []byte) {
	if len(buffer) == 0 {
		return nil, nil, nil
	}

	var signals []shellIntegrationSignal
	var malformed []string
	for index := 0; index < len(buffer); {
		start := indexOSCSequenceStart(buffer[index:])
		if start == -1 {
			if len(buffer) > 0 && buffer[len(buffer)-1] == 0x1b {
				return signals, malformed, []byte{0x1b}
			}
			return signals, malformed, nil
		}
		start += index
		payloadEnd, nextIndex, complete := findOSCTerminator(buffer, start+2)
		if !complete {
			fragment := buffer[start:]
			if len(fragment) > maxShellIntegrationPendingBytes {
				return signals, append(malformed, "oversized_pending"), nil
			}
			pending := make([]byte, len(fragment))
			copy(pending, fragment)
			return signals, malformed, pending
		}

		payload := buffer[start+2 : payloadEnd]
		if len(payload) <= maxShellIntegrationPayloadBytes {
			if signal, source, invalid, ok := parseShellIntegrationSignalPayload(string(payload)); ok {
				if invalid {
					malformed = append(malformed, source)
				} else {
					signals = append(signals, signal)
				}
			}
		} else if strings.HasPrefix(string(payload[:min(len(payload), len("633;P;FloetermProgram="))]), "633;P;FloetermProgram=") {
			malformed = append(malformed, "osc_633_program")
		}
		index = nextIndex
	}
	return signals, malformed, nil
}

func parseShellIntegrationSignalPayload(payload string) (shellIntegrationSignal, string, bool, bool) {
	if cwd, invalid, ok := parseWorkingDirectorySignalPayload(payload); ok {
		return shellIntegrationSignal{kind: shellIntegrationCwd, path: cwd.path}, cwd.source, invalid, true
	}
	switch {
	case payload == "633;A" || payload == "133;A":
		return shellIntegrationSignal{kind: shellIntegrationPromptReady}, "", false, true
	case payload == "633;B" || payload == "133;B":
		return shellIntegrationSignal{kind: shellIntegrationCommandStart}, "", false, true
	case payload == "633;C" || payload == "133;C":
		return shellIntegrationSignal{kind: shellIntegrationCommandExecuted}, "", false, true
	case payload == "633;D" || payload == "133;D" || strings.HasPrefix(payload, "633;D;") || strings.HasPrefix(payload, "133;D;"):
		return shellIntegrationSignal{kind: shellIntegrationCommandFinished}, "", false, true
	case strings.HasPrefix(payload, "633;P;FloetermProgram="):
		raw := strings.TrimPrefix(payload, "633;P;FloetermProgram=")
		program, ok := normalizeForegroundCommandDisplayName(raw)
		return shellIntegrationSignal{kind: shellIntegrationProgram, program: program}, "osc_633_program", !ok, true
	default:
		return shellIntegrationSignal{}, "", false, false
	}
}

func (s *Session) checkShellIntegrationChange(chunk []byte) {
	if s == nil || len(chunk) == 0 {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if len(s.shellIntegrationPending) == 0 && bytes.IndexByte(chunk, 0x1b) == -1 {
		s.mu.Unlock()
		return
	}
	buffer := chunk
	if len(s.shellIntegrationPending) > 0 {
		buffer = append(make([]byte, 0, len(s.shellIntegrationPending)+len(chunk)), s.shellIntegrationPending...)
		buffer = append(buffer, chunk...)
	}
	signals, malformed, pending := parseShellIntegrationSignals(buffer)
	s.shellIntegrationPending = pending
	s.mu.Unlock()

	for _, source := range malformed {
		s.config.logger.Debug("Discarded malformed shell integration sequence", "sessionID", s.ID, "source", source)
	}
	for _, signal := range signals {
		switch signal.kind {
		case shellIntegrationCwd:
			s.applyWorkingDirectoryChange(signal.path)
		case shellIntegrationProgram:
			s.mu.Lock()
			if !s.closed && normalizeForegroundCommandInfo(s.foregroundCommand).Phase != ForegroundCommandRunning {
				s.pendingForegroundProgram = signal.program
			}
			s.mu.Unlock()
		case shellIntegrationCommandStart:
			s.mu.Lock()
			if !s.closed {
				s.pendingForegroundProgram = ""
			}
			s.mu.Unlock()
		case shellIntegrationCommandExecuted:
			s.mu.Lock()
			closed := s.closed
			alreadyRunning := closed || normalizeForegroundCommandInfo(s.foregroundCommand).Phase == ForegroundCommandRunning
			program := s.pendingForegroundProgram
			s.pendingForegroundProgram = ""
			s.mu.Unlock()
			if !alreadyRunning {
				s.updateForegroundCommand(ForegroundCommandRunning, program)
			}
		case shellIntegrationCommandFinished, shellIntegrationPromptReady:
			s.mu.Lock()
			s.pendingForegroundProgram = ""
			s.mu.Unlock()
			s.updateForegroundCommand(ForegroundCommandIdle, "")
		}
	}
}

func (s *Session) updateForegroundCommand(phase ForegroundCommandPhase, displayName string) {
	if s == nil {
		return
	}
	if phase != ForegroundCommandRunning {
		displayName = ""
	} else if normalized, ok := normalizeForegroundCommandDisplayName(displayName); ok {
		displayName = normalized
	} else {
		displayName = ""
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	current := normalizeForegroundCommandInfo(s.foregroundCommand)
	if current.Phase == phase && current.DisplayName == displayName {
		s.mu.Unlock()
		return
	}
	current.Phase = phase
	current.DisplayName = displayName
	current.Revision++
	current.UpdatedAt = time.Now().UnixMilli()
	s.foregroundCommand = current
	handler := s.eventHandler
	info := TerminalSessionInfo{
		ID:                s.ID,
		Name:              s.Name,
		WorkingDir:        s.WorkingDir,
		CreatedAt:         s.CreatedAt.UnixMilli(),
		LastActive:        s.LastActive.UnixMilli(),
		IsActive:          s.isActive,
		ForegroundCommand: current,
	}
	s.mu.Unlock()

	if metadataHandler, ok := handler.(TerminalSessionMetadataEventHandler); ok {
		metadataHandler.OnTerminalSessionMetadataChanged(info.ID, info)
	}
}

func (s *Session) clearForegroundCommandLocked() {
	current := normalizeForegroundCommandInfo(s.foregroundCommand)
	if current.Phase == ForegroundCommandUnknown && current.DisplayName == "" {
		return
	}
	current.Phase = ForegroundCommandUnknown
	current.DisplayName = ""
	current.Revision++
	current.UpdatedAt = time.Now().UnixMilli()
	s.foregroundCommand = current
	s.pendingForegroundProgram = ""
}
