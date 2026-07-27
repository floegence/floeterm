package terminal

import (
	"net"
	"net/netip"
	"net/url"
	"os"
	pathpkg "path"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxContextFrameIDBytes = 64
	maxContextFrames       = 16
	maxContextSeenFrameIDs = 64
	maxContextLabelBytes   = 128
)

type terminalContextFrame struct {
	id              string
	location        TerminalLocationInfo
	app             TerminalApplicationInfo
	ownsLocation    bool
	ownsApplication bool
}

type terminalContextMarker struct {
	action                     string
	frameID                    string
	location                   *TerminalLocationInfo
	locationAuthorityPresent   bool
	locationUserPresent        bool
	locationCwdPresent         bool
	application                *TerminalApplicationInfo
	applicationIdentityPresent bool
}

type terminalWorkMarker struct {
	frameID string
	phase   TerminalWorkPhase
}

var terminalAgentDisplayNames = map[string]string{
	"codex": "Codex", "claude": "Claude Code", "opencode": "OpenCode", "kimi": "Kimi",
	"gemini": "Gemini", "qwen": "Qwen", "copilot": "Copilot", "cline": "Cline",
	"roo": "Roo", "vibe": "Vibe", "cursor": "Cursor", "junie": "Junie", "kiro": "Kiro",
	"openhands": "OpenHands", "trae": "Trae", "kilo": "Kilo Code",
}

var terminalAgentCommands = map[string]string{
	"codex": "codex", "claude": "claude", "opencode": "opencode", "kimi": "kimi",
	"kimi-cli": "kimi", "gemini": "gemini", "qwen": "qwen", "copilot": "copilot",
	"cline": "cline", "roo": "roo", "vibe": "vibe", "cursor-agent": "cursor",
	"junie": "junie", "kiro-cli": "kiro", "openhands": "openhands", "trae-cli": "trae",
	"kilocode": "kilo",
}

func classifyTerminalAgentCLI(displayName string) (string, bool) {
	name, ok := normalizeForegroundCommandDisplayName(displayName)
	if !ok {
		return "", false
	}
	name = strings.ToLower(name)
	for _, suffix := range []string{".exe", ".cmd", ".bat"} {
		if strings.HasSuffix(name, suffix) {
			name = strings.TrimSuffix(name, suffix)
			break
		}
	}
	identity, ok := terminalAgentCommands[name]
	return identity, ok
}

func isSSHCommand(displayName string) bool {
	name, ok := normalizeForegroundCommandDisplayName(displayName)
	if !ok {
		return false
	}
	name = strings.ToLower(name)
	return name == "ssh" || name == "ssh.exe"
}

func newLocalExecutionContext(workingDir string) TerminalExecutionContextInfo {
	return TerminalExecutionContextInfo{
		Location: TerminalLocationInfo{
			Kind:             TerminalLocationLocal,
			Phase:            TerminalLocationPhaseReady,
			WorkingDirectory: workingDir,
			Source:           TerminalContextSourceShellIntegration,
		},
		Application: TerminalApplicationInfo{Kind: TerminalApplicationShell},
		Revision:    1,
		UpdatedAt:   time.Now().UnixMilli(),
	}
}

func normalizeExecutionContextInfo(info TerminalExecutionContextInfo) TerminalExecutionContextInfo {
	switch info.Location.Kind {
	case TerminalLocationLocal, TerminalLocationRemote:
	default:
		info.Location = TerminalLocationInfo{Kind: TerminalLocationUnknown, Phase: TerminalLocationPhaseUnknown}
	}
	if info.Location.Kind == TerminalLocationLocal {
		info.Location.Authority = ""
		info.Location.Label = ""
	}
	if info.Location.Kind == TerminalLocationUnknown {
		info.Location.Phase = TerminalLocationPhaseUnknown
		info.Location.Source = TerminalContextSourceUnknown
		info.Location.Authority = ""
		info.Location.Label = ""
		info.Location.WorkingDirectory = ""
	}
	switch info.Application.Kind {
	case TerminalApplicationShell, TerminalApplicationAgentCLI, TerminalApplicationInteractiveApp:
	default:
		info.Application = TerminalApplicationInfo{Kind: TerminalApplicationUnknown}
	}
	if info.Application.Kind != TerminalApplicationAgentCLI {
		info.Application.Identity = ""
	}
	if info.Application.Kind == TerminalApplicationShell {
		info.Application.DisplayName = ""
	}
	return info
}

func normalizeWorkStateInfo(info TerminalWorkStateInfo) TerminalWorkStateInfo {
	switch info.Phase {
	case TerminalWorkIdle, TerminalWorkWorking, TerminalWorkWaitingUser:
		info.Source = "semantic"
	default:
		info.Phase = TerminalWorkUnknown
		info.Source = ""
		info.ContextRevision = 0
		info.ForegroundCommandRevision = 0
	}
	return info
}

func parseFloetermContextPayload(payload string) (terminalContextMarker, bool) {
	fields, ok := parseStrictMarkerFields(payload, "633;P;FloetermContext=v1", map[string]bool{
		"action": true, "frame_id": true, "location": true, "authority": true,
		"user": true, "cwd": true, "application": true, "identity": true,
	})
	if !ok {
		return terminalContextMarker{}, false
	}
	marker := terminalContextMarker{action: fields["action"], frameID: fields["frame_id"]}
	_, marker.locationAuthorityPresent = fields["authority"]
	_, marker.locationUserPresent = fields["user"]
	_, marker.locationCwdPresent = fields["cwd"]
	_, marker.applicationIdentityPresent = fields["identity"]
	if !validFrameID(marker.frameID) {
		return terminalContextMarker{}, false
	}
	switch marker.action {
	case "pop":
		if len(fields) != 2 {
			return terminalContextMarker{}, false
		}
		return marker, true
	case "push", "replace":
	default:
		return terminalContextMarker{}, false
	}

	if rawKind, exists := fields["location"]; exists {
		location := TerminalLocationInfo{Source: TerminalContextSourceShellIntegration}
		switch rawKind {
		case "remote":
			if !marker.locationAuthorityPresent {
				return terminalContextMarker{}, false
			}
			authority, _, remote, valid := normalizeOSC7Authority(fields["authority"])
			if !valid || !remote {
				return terminalContextMarker{}, false
			}
			location.Kind = TerminalLocationRemote
			location.Phase = TerminalLocationPhaseReady
			location.Authority = authority
			user := fields["user"]
			if user != "" && !validPresentationAtom(user, 64, "._-") {
				return terminalContextMarker{}, false
			}
			location.Label = remoteLabel(user, authority)
			if cwd := fields["cwd"]; marker.locationCwdPresent {
				normalized, ok := normalizeRemoteWorkingDirectory(cwd)
				if !ok {
					return terminalContextMarker{}, false
				}
				location.WorkingDirectory = normalized
			}
		case "local":
			if marker.locationAuthorityPresent || marker.locationUserPresent || marker.locationCwdPresent {
				return terminalContextMarker{}, false
			}
			location.Kind = TerminalLocationLocal
			location.Phase = TerminalLocationPhaseReady
		default:
			return terminalContextMarker{}, false
		}
		marker.location = &location
	}

	if rawKind, exists := fields["application"]; exists {
		app := TerminalApplicationInfo{}
		switch rawKind {
		case "shell":
			if marker.applicationIdentityPresent {
				return terminalContextMarker{}, false
			}
			app.Kind = TerminalApplicationShell
		case "agent_cli":
			if !marker.applicationIdentityPresent {
				return terminalContextMarker{}, false
			}
			identity := fields["identity"]
			displayName, ok := terminalAgentDisplayNames[identity]
			if !ok {
				return terminalContextMarker{}, false
			}
			app = TerminalApplicationInfo{Kind: TerminalApplicationAgentCLI, Identity: identity, DisplayName: displayName}
		default:
			return terminalContextMarker{}, false
		}
		marker.application = &app
	}
	if marker.location == nil && (marker.locationAuthorityPresent || marker.locationUserPresent || marker.locationCwdPresent) {
		return terminalContextMarker{}, false
	}
	if marker.application == nil && marker.applicationIdentityPresent {
		return terminalContextMarker{}, false
	}
	if marker.location == nil && marker.application == nil {
		return terminalContextMarker{}, false
	}
	return marker, true
}

func parseFloetermWorkPayload(payload string) (terminalWorkMarker, bool) {
	fields, ok := parseStrictMarkerFields(payload, "633;P;FloetermWork=v1", map[string]bool{
		"frame_id": true, "phase": true,
	})
	if !ok || len(fields) != 2 || !validFrameID(fields["frame_id"]) {
		return terminalWorkMarker{}, false
	}
	marker := terminalWorkMarker{frameID: fields["frame_id"], phase: TerminalWorkPhase(fields["phase"])}
	switch marker.phase {
	case TerminalWorkIdle, TerminalWorkWorking, TerminalWorkWaitingUser:
		return marker, true
	default:
		return terminalWorkMarker{}, false
	}
}

func parseStrictMarkerFields(payload, prefix string, allowed map[string]bool) (map[string]string, bool) {
	if payload == prefix {
		return nil, false
	}
	if !strings.HasPrefix(payload, prefix+";") {
		return nil, false
	}
	fields := make(map[string]string)
	for _, part := range strings.Split(strings.TrimPrefix(payload, prefix+";"), ";") {
		name, rawValue, found := strings.Cut(part, "=")
		if !found || name == "" || !allowed[name] {
			return nil, false
		}
		if _, duplicate := fields[name]; duplicate {
			return nil, false
		}
		for index := 0; index < len(name); index++ {
			if name[index] != '_' && (name[index] < 'a' || name[index] > 'z') {
				return nil, false
			}
		}
		value, err := url.PathUnescape(rawValue)
		if err != nil || !utf8.ValidString(value) || containsUnsafePresentationControl(value) {
			return nil, false
		}
		fields[name] = value
	}
	return fields, true
}

func validFrameID(value string) bool {
	if len(value) < 1 || len(value) > maxContextFrameIDBytes {
		return false
	}
	return validPresentationAtom(value, maxContextFrameIDBytes, "._-")
}

func validPresentationAtom(value string, maxBytes int, punctuation string) bool {
	if value == "" || len(value) > maxBytes {
		return false
	}
	for index := 0; index < len(value); index++ {
		char := value[index]
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || strings.ContainsRune(punctuation, rune(char)) {
			continue
		}
		return false
	}
	return true
}

func containsUnsafePresentationControl(value string) bool {
	for _, char := range value {
		if unicode.Is(unicode.Cc, char) || unicode.Is(unicode.Cf, char) {
			return true
		}
	}
	return false
}

func normalizeOSC7Authority(raw string) (authority string, host string, remote bool, valid bool) {
	if raw == "" {
		return "", "", false, true
	}
	if len(raw) > maxContextLabelBytes || !utf8.ValidString(raw) || containsUnsafePresentationControl(raw) {
		return "", "", false, false
	}
	if strings.ContainsAny(raw, "/?#@") {
		return "", "", false, false
	}
	if strings.HasPrefix(raw, "[") || strings.HasSuffix(raw, "]") {
		if !strings.HasPrefix(raw, "[") || !strings.HasSuffix(raw, "]") || strings.Count(raw, "[") != 1 || strings.Count(raw, "]") != 1 {
			return "", "", false, false
		}
		addr, err := netip.ParseAddr(raw[1 : len(raw)-1])
		if err != nil || !addr.Is6() || addr.Is4In6() || addr.Zone() != "" {
			return "", "", false, false
		}
		host = addr.String()
		if addr.IsLoopback() {
			return "", "", false, true
		}
		return "[" + host + "]", host, !isLocalTerminalHost(host), true
	}
	if strings.Contains(raw, ":") {
		return "", "", false, false
	}
	host = strings.ToLower(strings.TrimSuffix(raw, "."))
	if host == "" || len(host) > 253 {
		return "", "", false, false
	}
	if numericDottedHost(host) {
		addr, err := netip.ParseAddr(host)
		if err != nil || !addr.Is4() || addr.String() != host {
			return "", "", false, false
		}
		if addr.IsLoopback() {
			return "", "", false, true
		}
		return host, host, !isLocalTerminalHost(host), true
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) < 1 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' ||
			!validPresentationAtom(label, 63, "-") {
			return "", "", false, false
		}
	}
	return host, host, !isLocalTerminalHost(host), true
}

func numericDottedHost(host string) bool {
	if !strings.Contains(host, ".") {
		return false
	}
	for index := 0; index < len(host); index++ {
		if host[index] != '.' && (host[index] < '0' || host[index] > '9') {
			return false
		}
	}
	return true
}

func isLocalTerminalHost(host string) bool {
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	local, err := os.Hostname()
	return err == nil && strings.EqualFold(strings.TrimSuffix(local, "."), strings.TrimSuffix(host, "."))
}

func normalizeRemoteWorkingDirectory(raw string) (string, bool) {
	if raw == "" || !utf8.ValidString(raw) || containsUnsafePresentationControl(raw) || !strings.HasPrefix(raw, "/") {
		return "", false
	}
	return pathpkg.Clean(raw), true
}

func remoteLabel(user, authority string) string {
	if user == "" {
		return authority
	}
	label := user + "@" + authority
	if len(label) > maxContextLabelBytes {
		return authority
	}
	return label
}

func contextCanonical(location TerminalLocationInfo, app TerminalApplicationInfo) string {
	values := []string{
		string(location.Kind), string(location.Phase), location.Label, location.Authority,
		location.WorkingDirectory, string(location.Source), string(app.Kind), app.Identity, app.DisplayName,
	}
	return strings.Join(values, "\x00")
}

func frameStateCanonical(frame terminalContextFrame) string {
	return contextCanonical(frame.location, frame.app) + "\x00" +
		strconv.FormatBool(frame.ownsLocation) + "\x00" + strconv.FormatBool(frame.ownsApplication)
}

func parseTerminalTitleLabel(raw string) (user, authority string, ok bool) {
	if raw == "" || len(raw) > maxContextLabelBytes || !utf8.ValidString(raw) || containsUnsafePresentationControl(raw) {
		return "", "", false
	}
	userPart, hostPart, hasUser := strings.Cut(raw, "@")
	if !hasUser {
		hostPart = userPart
		userPart = ""
	} else if strings.Contains(hostPart, "@") || !validPresentationAtom(userPart, 64, "._-") {
		return "", "", false
	}
	authority, _, remote, valid := normalizeOSC7Authority(hostPart)
	if !valid || !remote {
		return "", "", false
	}
	return userPart, authority, true
}

func (s *Session) applyOSC7Locked(signal shellIntegrationSignal, now time.Time) bool {
	if !signal.remote {
		return false
	}
	s.ensureContextBaseLocked()
	topIndex := s.topLocationOwnerLocked()
	if topIndex < 0 {
		return false
	}
	top := s.contextFrames[topIndex]
	if top.location.Kind != TerminalLocationRemote {
		return false
	}
	previousAuthority := top.location.Authority
	top.location.Kind = TerminalLocationRemote
	top.location.Phase = TerminalLocationPhaseReady
	top.location.Authority = signal.authority
	top.location.WorkingDirectory = signal.path
	top.location.Source = TerminalContextSourceOSC7
	keepTitleUser := previousAuthority == "" && strings.HasSuffix(top.location.Label, "@"+signal.authority)
	if (previousAuthority != signal.authority && !keepTitleUser) || top.location.Label == "" || top.location.Label == "SSH" {
		top.location.Label = signal.authority
	}
	s.contextFrames[topIndex] = top
	s.propagateLocationLocked(topIndex)
	visible := s.contextFrames[len(s.contextFrames)-1]
	return s.publishContextLocked(visible.location, visible.app, now)
}

func (s *Session) applyRemoteCwdLocked(path string, now time.Time) bool {
	if normalized, ok := normalizeRemoteWorkingDirectory(path); ok {
		s.ensureContextBaseLocked()
		topIndex := s.topLocationOwnerLocked()
		if topIndex < 0 {
			return false
		}
		top := s.contextFrames[topIndex]
		if top.location.Kind == TerminalLocationRemote {
			top.location.WorkingDirectory = normalized
			top.location.Source = TerminalContextSourceShellIntegration
			s.contextFrames[topIndex] = top
			s.propagateLocationLocked(topIndex)
			visible := s.contextFrames[len(s.contextFrames)-1]
			return s.publishContextLocked(visible.location, visible.app, now)
		}
	}
	return false
}

func (s *Session) applyTitleLocked(title string, now time.Time) bool {
	user, authority, ok := parseTerminalTitleLabel(title)
	if !ok {
		return false
	}
	s.ensureContextBaseLocked()
	topIndex := s.topLocationOwnerLocked()
	if topIndex < 0 {
		return false
	}
	top := s.contextFrames[topIndex]
	if top.location.Kind != TerminalLocationRemote {
		return false
	}
	if top.location.Authority == "" {
		if top.location.Phase != TerminalLocationPhaseOpening {
			return false
		}
		if top.location.Label != "" && top.location.Label != "SSH" {
			return false
		}
		top.location.Label = remoteLabel(user, authority)
		top.location.Source = TerminalContextSourceOSCTitle
		s.contextFrames[topIndex] = top
		s.propagateLocationLocked(topIndex)
		visible := s.contextFrames[len(s.contextFrames)-1]
		return s.publishContextLocked(visible.location, visible.app, now)
	}
	if top.location.Authority != authority {
		return false
	}
	if top.location.Label != "" && top.location.Label != top.location.Authority && top.location.Label != "SSH" {
		return false
	}
	top.location.Label = remoteLabel(user, authority)
	top.location.Source = TerminalContextSourceOSCTitle
	s.contextFrames[topIndex] = top
	s.propagateLocationLocked(topIndex)
	visible := s.contextFrames[len(s.contextFrames)-1]
	return s.publishContextLocked(visible.location, visible.app, now)
}

func (s *Session) topLocationOwnerLocked() int {
	for index := len(s.contextFrames) - 1; index >= 0; index-- {
		if s.contextFrames[index].ownsLocation {
			return index
		}
	}
	return -1
}

func (s *Session) propagateLocationLocked(ownerIndex int) {
	location := s.contextFrames[ownerIndex].location
	for index := ownerIndex + 1; index < len(s.contextFrames); index++ {
		if s.contextFrames[index].ownsLocation {
			break
		}
		s.contextFrames[index].location = location
	}
}

func (s *Session) hasActiveRemoteLocationLocked() bool {
	for index := len(s.contextFrames) - 1; index >= 0; index-- {
		if s.contextFrames[index].location.Kind == TerminalLocationRemote {
			return true
		}
	}
	return false
}

func (s *Session) ensureContextBaseLocked() {
	if len(s.contextFrames) != 0 {
		return
	}
	base := normalizeExecutionContextInfo(s.executionContext)
	s.contextFrames = []terminalContextFrame{{
		id: "", location: base.Location, app: base.Application, ownsLocation: true, ownsApplication: true,
	}}
}

func (s *Session) publishContextBoundaryLocked(location TerminalLocationInfo, app TerminalApplicationInfo, now time.Time) {
	current := normalizeExecutionContextInfo(s.executionContext)
	next := normalizeExecutionContextInfo(TerminalExecutionContextInfo{Location: location, Application: app})
	current.Location = next.Location
	current.Application = next.Application
	current.Revision++
	current.UpdatedAt = now.UnixMilli()
	s.executionContext = current
	s.clearWorkStateLocked(now)
}

func (s *Session) publishContextLocked(location TerminalLocationInfo, app TerminalApplicationInfo, now time.Time) bool {
	current := normalizeExecutionContextInfo(s.executionContext)
	next := normalizeExecutionContextInfo(TerminalExecutionContextInfo{Location: location, Application: app})
	if contextCanonical(current.Location, current.Application) == contextCanonical(next.Location, next.Application) {
		return false
	}
	current.Location = next.Location
	current.Application = next.Application
	current.Revision++
	current.UpdatedAt = now.UnixMilli()
	s.executionContext = current
	s.clearWorkStateLocked(now)
	return true
}

func (s *Session) resetContextEpochLocked(now time.Time) bool {
	local := newLocalExecutionContext(s.WorkingDir)
	local.Revision = s.executionContext.Revision
	local.UpdatedAt = s.executionContext.UpdatedAt
	s.contextFrames = nil
	s.contextSeenFrameIDs = make(map[string]struct{})
	s.contextForegroundRevision = s.foregroundCommand.Revision
	return s.publishContextLocked(local.Location, local.Application, now)
}

func (s *Session) startForegroundContextLocked(displayName string, now time.Time) bool {
	s.contextFrames = nil
	s.contextSeenFrameIDs = make(map[string]struct{})
	s.contextForegroundRevision = s.foregroundCommand.Revision
	s.ensureContextBaseLocked()
	base := s.contextFrames[0]
	if isSSHCommand(displayName) {
		frame := terminalContextFrame{
			id: "@ssh-candidate",
			location: TerminalLocationInfo{Kind: TerminalLocationRemote, Phase: TerminalLocationPhaseOpening,
				Label: "SSH", Source: TerminalContextSourceForegroundCandidate},
			app: base.app, ownsLocation: true,
		}
		s.contextFrames = append(s.contextFrames, frame)
		return s.publishContextLocked(frame.location, frame.app, now)
	}
	if identity, ok := classifyTerminalAgentCLI(displayName); ok {
		frame := terminalContextFrame{id: "@agent-candidate", location: base.location,
			app: TerminalApplicationInfo{Kind: TerminalApplicationAgentCLI, Identity: identity, DisplayName: terminalAgentDisplayNames[identity]}, ownsApplication: true}
		s.contextFrames = append(s.contextFrames, frame)
		return s.publishContextLocked(frame.location, frame.app, now)
	}
	return false
}

func (s *Session) applyContextMarkerLocked(marker terminalContextMarker, now time.Time) bool {
	if s.contextForegroundRevision != s.foregroundCommand.Revision || s.foregroundCommand.Phase != ForegroundCommandRunning {
		return false
	}
	s.ensureContextBaseLocked()
	top := s.contextFrames[len(s.contextFrames)-1]
	switch marker.action {
	case "pop":
		if len(s.contextFrames) <= 1 || top.id != marker.frameID || strings.HasPrefix(top.id, "@") {
			return false
		}
		if s.hasActiveRemoteLocationLocked() {
			remoteAfterPop := false
			for _, frame := range s.contextFrames[:len(s.contextFrames)-1] {
				if frame.location.Kind == TerminalLocationRemote {
					remoteAfterPop = true
					break
				}
			}
			if !remoteAfterPop {
				return false
			}
		}
		s.contextFrames = s.contextFrames[:len(s.contextFrames)-1]
		next := s.contextFrames[len(s.contextFrames)-1]
		s.publishContextBoundaryLocked(next.location, next.app, now)
		return true
	case "replace":
		if len(s.contextFrames) <= 1 || top.id != marker.frameID || strings.HasPrefix(top.id, "@") {
			return false
		}
		if marker.location != nil && marker.location.Kind == TerminalLocationLocal && s.hasActiveRemoteLocationLocked() {
			return false
		}
		oldCanonical := frameStateCanonical(top)
		location, app := top.location, top.app
		if marker.location != nil {
			top.ownsLocation = true
			if marker.location.Kind == TerminalLocationLocal {
				location = *marker.location
				location.WorkingDirectory = s.WorkingDir
			} else {
				sameAuthority := location.Kind == TerminalLocationRemote && location.Authority == marker.location.Authority
				previous := location
				location = *marker.location
				if sameAuthority && !marker.locationUserPresent {
					location.Label = previous.Label
				}
				if sameAuthority && !marker.locationCwdPresent {
					location.WorkingDirectory = previous.WorkingDirectory
				}
			}
		}
		if marker.application != nil {
			top.ownsApplication = true
			if marker.application.Identity != app.Identity && (marker.application.Identity != "" || app.Identity != "") {
				return false
			}
			app = *marker.application
		}
		top.location, top.app = location, app
		if frameStateCanonical(top) == oldCanonical {
			return false
		}
		s.contextFrames[len(s.contextFrames)-1] = top
		s.publishContextBoundaryLocked(location, app, now)
		return true
	case "push":
		if marker.location != nil && marker.location.Kind == TerminalLocationLocal && s.hasActiveRemoteLocationLocked() {
			return false
		}
		location, app := top.location, top.app
		if marker.location != nil {
			location = *marker.location
			if location.Kind == TerminalLocationLocal {
				location.WorkingDirectory = s.WorkingDir
			}
		}
		if marker.application != nil {
			app = *marker.application
		}
		if _, exists := s.contextSeenFrameIDs[marker.frameID]; exists {
			return false
		}
		if len(s.contextFrames) >= maxContextFrames || len(s.contextSeenFrameIDs) >= maxContextSeenFrameIDs {
			return false
		}
		s.contextSeenFrameIDs[marker.frameID] = struct{}{}
		s.contextFrames = append(s.contextFrames, terminalContextFrame{
			id: marker.frameID, location: location, app: app,
			ownsLocation: marker.location != nil, ownsApplication: marker.application != nil,
		})
		s.publishContextBoundaryLocked(location, app, now)
		return true
	default:
		return false
	}
}

func (s *Session) applyWorkMarkerLocked(marker terminalWorkMarker, now time.Time) bool {
	if s.contextForegroundRevision != s.foregroundCommand.Revision || s.foregroundCommand.Phase != ForegroundCommandRunning || len(s.contextFrames) == 0 {
		return false
	}
	top := s.contextFrames[len(s.contextFrames)-1]
	if top.id != marker.frameID || top.app.Kind != TerminalApplicationAgentCLI {
		return false
	}
	current := normalizeWorkStateInfo(s.workState)
	if current.Phase == marker.phase && current.ContextRevision == s.executionContext.Revision &&
		current.ForegroundCommandRevision == s.foregroundCommand.Revision {
		return false
	}
	current.Phase = marker.phase
	current.Source = "semantic"
	current.ContextRevision = s.executionContext.Revision
	current.ForegroundCommandRevision = s.foregroundCommand.Revision
	current.Revision++
	current.UpdatedAt = now.UnixMilli()
	s.workState = current
	return true
}

func (s *Session) clearWorkStateLocked(now time.Time) bool {
	current := normalizeWorkStateInfo(s.workState)
	if current.Phase == TerminalWorkUnknown {
		s.workState = current
		return false
	}
	current.Phase = TerminalWorkUnknown
	current.Source = ""
	current.ContextRevision = 0
	current.ForegroundCommandRevision = 0
	current.Revision++
	current.UpdatedAt = now.UnixMilli()
	s.workState = current
	return true
}

func (s *Session) clearExecutionContextLocked(now time.Time) bool {
	current := normalizeExecutionContextInfo(s.executionContext)
	next := TerminalExecutionContextInfo{
		Location:    TerminalLocationInfo{Kind: TerminalLocationUnknown, Phase: TerminalLocationPhaseUnknown},
		Application: TerminalApplicationInfo{Kind: TerminalApplicationUnknown},
		Revision:    current.Revision,
		UpdatedAt:   current.UpdatedAt,
	}
	s.contextFrames = nil
	s.contextSeenFrameIDs = make(map[string]struct{})
	s.contextForegroundRevision = 0
	changed := s.publishContextLocked(next.Location, next.Application, now)
	s.clearWorkStateLocked(now)
	return changed
}
