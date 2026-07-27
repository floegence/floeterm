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

var shellIntegrationOSCStart = []byte{0x1b, ']'}

type shellIntegrationSignalKind uint8

const (
	shellIntegrationCwd shellIntegrationSignalKind = iota + 1
	shellIntegrationPromptReady
	shellIntegrationCommandStart
	shellIntegrationCommandExecuted
	shellIntegrationCommandFinished
	shellIntegrationProgram
	shellIntegrationContext
	shellIntegrationWork
	shellIntegrationTitle
)

type shellIntegrationSignal struct {
	kind      shellIntegrationSignalKind
	path      string
	program   string
	authority string
	remote    bool
	context   terminalContextMarker
	work      terminalWorkMarker
	title     string
}

type shellIntegrationTokenKind uint8

const (
	shellIntegrationDisplay shellIntegrationTokenKind = iota + 1
	shellIntegrationMetadata
)

type shellIntegrationToken struct {
	kind   shellIntegrationTokenKind
	data   []byte
	signal shellIntegrationSignal
}

func containsShellIntegrationOSCStart(chunk []byte) bool {
	return bytes.Index(chunk, shellIntegrationOSCStart) >= 0
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

func normalizeOutputActivityInfo(info TerminalOutputActivityInfo) TerminalOutputActivityInfo {
	switch info.Phase {
	case OutputActivityStreaming, OutputActivitySettled:
	default:
		info.Phase = OutputActivityUnknown
	}
	return info
}

func parseShellIntegrationSignals(buffer []byte) ([]shellIntegrationSignal, []string, []byte) {
	tokens, malformed, pending := parseShellIntegrationTokens(buffer)
	signals := make([]shellIntegrationSignal, 0, len(tokens))
	for _, token := range tokens {
		if token.kind == shellIntegrationMetadata {
			signals = append(signals, token.signal)
		}
	}
	return signals, malformed, pending
}

func parseShellIntegrationTokens(buffer []byte) ([]shellIntegrationToken, []string, []byte) {
	if len(buffer) == 0 {
		return nil, nil, nil
	}

	var tokens []shellIntegrationToken
	var malformed []string
	segmentStart := 0
	for index := 0; index < len(buffer); {
		start := indexOSCSequenceStart(buffer[index:])
		if start == -1 {
			if len(buffer) > 0 && buffer[len(buffer)-1] == 0x1b {
				tokens = appendShellIntegrationDisplay(tokens, buffer[segmentStart:len(buffer)-1])
				return tokens, malformed, []byte{0x1b}
			}
			tokens = appendShellIntegrationDisplay(tokens, buffer[segmentStart:])
			return tokens, malformed, nil
		}
		start += index
		payloadEnd, nextIndex, complete := findOSCTerminator(buffer, start+2)
		if !complete {
			tokens = appendShellIntegrationDisplay(tokens, buffer[segmentStart:start])
			fragment := buffer[start:]
			if len(fragment) > maxShellIntegrationPendingBytes {
				tokens = appendShellIntegrationDisplay(tokens, fragment)
				return tokens, append(malformed, "oversized_pending"), nil
			}
			pending := make([]byte, len(fragment))
			copy(pending, fragment)
			return tokens, malformed, pending
		}

		payload := buffer[start+2 : payloadEnd]
		var signal shellIntegrationSignal
		var source string
		var invalid bool
		var recognized bool
		if len(payload) <= maxShellIntegrationPayloadBytes {
			signal, source, invalid, recognized = parseShellIntegrationSignalPayload(string(payload))
		} else if oversizedSource, ok := knownOversizedControlSource(payload); ok {
			recognized = true
			invalid = true
			source = oversizedSource
		}
		if recognized {
			tokens = appendShellIntegrationDisplay(tokens, buffer[segmentStart:start])
			if invalid {
				malformed = append(malformed, source)
			} else {
				tokens = append(tokens, shellIntegrationToken{kind: shellIntegrationMetadata, signal: signal})
			}
			segmentStart = nextIndex
		}
		index = nextIndex
	}
	tokens = appendShellIntegrationDisplay(tokens, buffer[segmentStart:])
	return tokens, malformed, nil
}

func knownOversizedControlSource(payload []byte) (string, bool) {
	text := string(payload[:min(len(payload), 64)])
	for _, candidate := range []struct {
		prefix string
		source string
	}{
		{prefix: "633;P;FloetermProgram=", source: "osc_633_program"},
		{prefix: "633;P;FloetermContext=", source: "osc_633_context"},
		{prefix: "633;P;FloetermWork=", source: "osc_633_work"},
		{prefix: "633;P;Cwd=", source: "osc_633"},
		{prefix: "1337;CurrentDir=", source: "osc_1337"},
		{prefix: "7;file://", source: "osc_7"},
		{prefix: "0;", source: "osc_title"},
		{prefix: "2;", source: "osc_title"},
	} {
		if strings.HasPrefix(text, candidate.prefix) {
			return candidate.source, true
		}
	}
	return "", false
}

func appendShellIntegrationDisplay(tokens []shellIntegrationToken, data []byte) []shellIntegrationToken {
	if len(data) == 0 {
		return tokens
	}
	return append(tokens, shellIntegrationToken{kind: shellIntegrationDisplay, data: data})
}

func parseShellIntegrationSignalPayload(payload string) (shellIntegrationSignal, string, bool, bool) {
	if cwd, invalid, ok := parseWorkingDirectorySignalPayload(payload); ok {
		return shellIntegrationSignal{kind: shellIntegrationCwd, path: cwd.path, authority: cwd.authority, remote: cwd.remote}, cwd.source, invalid, true
	}
	switch {
	case strings.HasPrefix(payload, "633;P;FloetermContext="):
		marker, ok := parseFloetermContextPayload(payload)
		return shellIntegrationSignal{kind: shellIntegrationContext, context: marker}, "osc_633_context", !ok, true
	case strings.HasPrefix(payload, "633;P;FloetermWork="):
		marker, ok := parseFloetermWorkPayload(payload)
		return shellIntegrationSignal{kind: shellIntegrationWork, work: marker}, "osc_633_work", !ok, true
	case strings.HasPrefix(payload, "0;") || strings.HasPrefix(payload, "2;"):
		title := strings.TrimPrefix(strings.TrimPrefix(payload, "0;"), "2;")
		_, _, ok := parseTerminalTitleLabel(title)
		return shellIntegrationSignal{kind: shellIntegrationTitle, title: title}, "osc_title", !ok, true
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
	if len(s.shellIntegrationPending) == 0 {
		if bytes.IndexByte(chunk, 0x1b) == -1 ||
			(chunk[len(chunk)-1] != 0x1b && !containsShellIntegrationOSCStart(chunk)) {
			s.mu.Unlock()
			s.observeOutputActivity()
			return
		}
	}
	buffer := chunk
	if len(s.shellIntegrationPending) > 0 {
		buffer = append(make([]byte, 0, len(s.shellIntegrationPending)+len(chunk)), s.shellIntegrationPending...)
		buffer = append(buffer, chunk...)
	}
	tokens, malformed, pending := parseShellIntegrationTokens(buffer)
	s.shellIntegrationPending = pending
	s.mu.Unlock()

	for _, source := range malformed {
		s.config.logger.Debug("Discarded malformed shell integration sequence", "sessionID", s.ID, "source", source)
	}
	for _, token := range tokens {
		if token.kind == shellIntegrationDisplay {
			s.observeOutputActivity()
			continue
		}
		signal := token.signal
		switch signal.kind {
		case shellIntegrationCwd:
			if signal.remote {
				s.applyShellIntegrationMetadata(func(now time.Time) bool { return s.applyOSC7Locked(signal, now) })
				continue
			}
			s.mu.RLock()
			remote := s.executionContext.Location.Kind == TerminalLocationRemote
			s.mu.RUnlock()
			if remote {
				s.applyShellIntegrationMetadata(func(now time.Time) bool { return s.applyRemoteCwdLocked(signal.path, now) })
			} else {
				s.applyWorkingDirectoryChange(normalizeExplicitWorkingDirectory(signal.path))
			}
		case shellIntegrationContext:
			s.applyShellIntegrationMetadata(func(now time.Time) bool { return s.applyContextMarkerLocked(signal.context, now) })
		case shellIntegrationWork:
			s.applyShellIntegrationMetadata(func(now time.Time) bool { return s.applyWorkMarkerLocked(signal.work, now) })
		case shellIntegrationTitle:
			s.applyShellIntegrationMetadata(func(now time.Time) bool { return s.applyTitleLocked(signal.title, now) })
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
	now := time.Now()
	previousContextRevision := s.executionContext.Revision
	previousWorkRevision := s.workState.Revision
	current.Phase = phase
	current.DisplayName = displayName
	current.Revision++
	current.UpdatedAt = now.UnixMilli()
	s.foregroundCommand = current
	if phase == ForegroundCommandRunning {
		s.startForegroundContextLocked(displayName, now)
	} else {
		s.resetContextEpochLocked(now)
	}
	outputChanged, outputInfo := s.resetOutputActivityLocked(now)
	handler := s.eventHandler
	info := s.toSessionInfoLocked()
	s.mu.Unlock()

	if metadataHandler, ok := handler.(TerminalSessionMetadataEventHandler); ok {
		metadataHandler.OnTerminalSessionMetadataChanged(info.ID, info)
	}
	notifyTerminalContextAndWork(handler, info.ID, info, previousContextRevision, previousWorkRevision)
	if outputChanged {
		notifyTerminalOutputActivity(handler, info.ID, outputInfo)
	}
}

func (s *Session) applyShellIntegrationMetadata(apply func(time.Time) bool) {
	s.mu.Lock()
	previousContextRevision := s.executionContext.Revision
	previousWorkRevision := s.workState.Revision
	if s.closed || !apply(time.Now()) {
		s.mu.Unlock()
		return
	}
	handler := s.eventHandler
	info := s.toSessionInfoLocked()
	s.mu.Unlock()
	notifyTerminalContextAndWork(handler, info.ID, info, previousContextRevision, previousWorkRevision)
}

func notifyTerminalContextAndWork(
	handler TerminalEventHandler,
	sessionID string,
	info TerminalSessionInfo,
	previousContextRevision uint64,
	previousWorkRevision uint64,
) {
	if info.ExecutionContext.Revision != previousContextRevision {
		if contextHandler, ok := handler.(TerminalExecutionContextEventHandler); ok {
			contextHandler.OnTerminalExecutionContextChanged(sessionID, info.ExecutionContext)
		}
	}
	if info.WorkState.Revision != previousWorkRevision {
		if workHandler, ok := handler.(TerminalSemanticWorkStateEventHandler); ok {
			workHandler.OnTerminalSemanticWorkStateChanged(sessionID, info.WorkState)
		}
	}
}

func (s *Session) clearForegroundCommandLocked() {
	current := normalizeForegroundCommandInfo(s.foregroundCommand)
	now := time.Now()
	_, _ = s.resetOutputActivityLocked(now)
	s.clearExecutionContextLocked(now)
	if current.Phase == ForegroundCommandUnknown && current.DisplayName == "" {
		return
	}
	current.Phase = ForegroundCommandUnknown
	current.DisplayName = ""
	current.Revision++
	current.UpdatedAt = now.UnixMilli()
	s.foregroundCommand = current
	s.pendingForegroundProgram = ""
}

func (s *Session) observeOutputActivity() {
	if s == nil {
		return
	}
	now := time.Now()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	command := normalizeForegroundCommandInfo(s.foregroundCommand)
	if command.Phase != ForegroundCommandRunning {
		s.mu.Unlock()
		return
	}
	current := normalizeOutputActivityInfo(s.outputActivity)
	changed := current.Phase != OutputActivityStreaming
	if changed {
		current.Phase = OutputActivityStreaming
		current.Revision++
		current.UpdatedAt = now.UnixMilli()
		s.outputActivity = current
	}
	s.outputActivityCommandRevision = command.Revision
	s.outputActivityDeadline = now.Add(s.config.outputActivityQuietDuration)
	if s.outputActivityTimer == nil {
		s.outputActivityGeneration++
		generation := s.outputActivityGeneration
		commandRevision := command.Revision
		s.outputActivityTimer = time.AfterFunc(s.config.outputActivityQuietDuration, func() {
			s.settleOutputActivity(generation, commandRevision)
		})
	} else {
		s.outputActivityTimer.Stop()
		s.outputActivityTimer.Reset(s.config.outputActivityQuietDuration)
	}
	handler := s.eventHandler
	sessionID := s.ID
	s.mu.Unlock()

	if changed {
		notifyTerminalOutputActivity(handler, sessionID, current)
	}
}

func (s *Session) settleOutputActivity(generation, commandRevision uint64) {
	if s == nil {
		return
	}
	now := time.Now()
	s.mu.Lock()
	if s.outputActivityTimer == nil || s.outputActivityGeneration != generation {
		s.mu.Unlock()
		return
	}
	command := normalizeForegroundCommandInfo(s.foregroundCommand)
	current := normalizeOutputActivityInfo(s.outputActivity)
	if s.closed || command.Phase != ForegroundCommandRunning ||
		command.Revision != commandRevision ||
		s.outputActivityCommandRevision != commandRevision || current.Phase != OutputActivityStreaming {
		changed, _ := s.resetOutputActivityLocked(now)
		handler := s.eventHandler
		sessionID := s.ID
		closed := s.closed
		info := normalizeOutputActivityInfo(s.outputActivity)
		s.mu.Unlock()
		if changed && !closed {
			notifyTerminalOutputActivity(handler, sessionID, info)
		}
		return
	}
	if remaining := s.outputActivityDeadline.Sub(now); remaining > 0 {
		s.outputActivityTimer.Reset(remaining)
		s.mu.Unlock()
		return
	}
	s.outputActivityTimer = nil
	current.Phase = OutputActivitySettled
	current.Revision++
	current.UpdatedAt = now.UnixMilli()
	s.outputActivity = current
	handler := s.eventHandler
	sessionID := s.ID
	s.mu.Unlock()

	notifyTerminalOutputActivity(handler, sessionID, current)
}

func (s *Session) resetOutputActivityLocked(now time.Time) (bool, TerminalOutputActivityInfo) {
	if s.outputActivityTimer != nil {
		s.outputActivityTimer.Stop()
		s.outputActivityTimer = nil
	}
	s.outputActivityGeneration++
	s.outputActivityCommandRevision = 0
	s.outputActivityDeadline = time.Time{}
	current := normalizeOutputActivityInfo(s.outputActivity)
	if current.Phase == OutputActivityUnknown {
		s.outputActivity = current
		return false, current
	}
	current.Phase = OutputActivityUnknown
	current.Revision++
	current.UpdatedAt = now.UnixMilli()
	s.outputActivity = current
	return true, current
}

func notifyTerminalOutputActivity(handler TerminalEventHandler, sessionID string, info TerminalOutputActivityInfo) {
	if outputHandler, ok := handler.(TerminalOutputActivityEventHandler); ok {
		outputHandler.OnTerminalOutputActivityChanged(sessionID, info)
	}
}
