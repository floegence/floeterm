package terminal

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type shellIntegrationActivityVectorFile struct {
	Cases []struct {
		Name   string   `json:"name"`
		Chunks []string `json:"chunks"`
		Tokens []string `json:"tokens"`
	} `json:"cases"`
}

func TestShellIntegrationActivityVectorsPreserveTokenOrder(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "protocol", "shell_integration_activity_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors shellIntegrationActivityVectorFile
	if err := json.Unmarshal(content, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			var pending []byte
			var got []string
			for _, chunk := range vector.Chunks {
				buffer := append(append([]byte(nil), pending...), []byte(chunk)...)
				tokens, malformed, nextPending := parseShellIntegrationTokens(buffer)
				if len(malformed) != 0 {
					t.Fatalf("malformed = %v", malformed)
				}
				pending = nextPending
				for _, token := range tokens {
					switch token.kind {
					case shellIntegrationDisplay:
						got = append(got, "display:"+string(token.data))
					case shellIntegrationMetadata:
						label := "signal:" + shellIntegrationSignalLabel(token.signal.kind)
						if token.signal.program != "" {
							label += ":" + token.signal.program
						}
						if token.signal.sshTarget != "" {
							label += ":" + token.signal.sshTarget
						}
						got = append(got, label)
					}
				}
			}
			if len(pending) != 0 {
				t.Fatalf("pending = %q", pending)
			}
			if strings.Join(got, "\n") != strings.Join(vector.Tokens, "\n") {
				t.Fatalf("tokens = %#v, want %#v", got, vector.Tokens)
			}
		})
	}
}

func shellIntegrationSignalLabel(kind shellIntegrationSignalKind) string {
	switch kind {
	case shellIntegrationCwd:
		return "cwd-update"
	case shellIntegrationPromptReady:
		return "prompt-ready"
	case shellIntegrationCommandStart:
		return "command-start"
	case shellIntegrationCommandExecuted:
		return "command-executed"
	case shellIntegrationCommandFinished:
		return "command-finished"
	case shellIntegrationProgram:
		return "program"
	case shellIntegrationSSHTarget:
		return "ssh-target"
	case shellIntegrationContext:
		return "context"
	case shellIntegrationWork:
		return "work"
	case shellIntegrationTitle:
		return "title"
	case shellIntegrationReady:
		return "integration-ready"
	default:
		return "unknown"
	}
}

func TestSSHTargetMarkerIsBoundToPendingSSHCommand(t *testing.T) {
	session := &Session{
		ID: "ssh-target", connections: make(map[string]*ConnectionInfo), liveAttachments: make(map[string]liveAttachment),
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.checkShellIntegrationChange([]byte(
		"\x1b]633;B\a" +
			"\x1b]633;P;FloetermProgram=ssh\a" +
			"\x1b]633;P;FloetermSshTarget=v1;target=root@Host.Example.\a" +
			"\x1b]633;C\a",
	))
	location := session.ToSessionInfo().ExecutionContext.Location
	if location.Kind != TerminalLocationRemote || location.Phase != TerminalLocationPhaseOpening ||
		location.Label != "root@host.example" || location.Authority != "" || location.Source != TerminalContextSourceForegroundCandidate {
		t.Fatalf("SSH target location = %+v", location)
	}

	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermSshTarget=v1;target=late.example\a"))
	if after := session.ToSessionInfo().ExecutionContext.Location; after != location {
		t.Fatalf("late SSH target changed running context: before=%+v after=%+v", location, after)
	}
}

func TestSSHTargetMarkerRejectsWrongOrderProgramAndMalformedTargets(t *testing.T) {
	for _, sequence := range []string{
		"\x1b]633;B\a\x1b]633;P;FloetermSshTarget=v1;target=host.example\a\x1b]633;P;FloetermProgram=ssh\a\x1b]633;C\a",
		"\x1b]633;B\a\x1b]633;P;FloetermProgram=top\a\x1b]633;P;FloetermSshTarget=v1;target=host.example\a\x1b]633;C\a",
		"\x1b]633;B\a\x1b]633;P;FloetermProgram=ssh\a\x1b]633;P;FloetermSshTarget=v1;target=bad%3Bhost\a\x1b]633;C\a",
	} {
		session := &Session{
			ID: "ssh-target-reject", connections: make(map[string]*ConnectionInfo), liveAttachments: make(map[string]liveAttachment),
			config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
		}
		session.checkShellIntegrationChange([]byte(sequence))
		location := session.ToSessionInfo().ExecutionContext.Location
		if location.Label != "SSH" && location.Kind == TerminalLocationRemote {
			t.Fatalf("rejected sequence produced label %q", location.Label)
		}
	}
}

type metadataCaptureHandler struct {
	mu      sync.Mutex
	updates []TerminalSessionInfo
}

func (h *metadataCaptureHandler) OnTerminalNameChanged(string, string, string, string) {}
func (h *metadataCaptureHandler) OnTerminalSessionCreated(*Session)                    {}
func (h *metadataCaptureHandler) OnTerminalSessionClosed(string)                       {}
func (h *metadataCaptureHandler) OnTerminalError(string, error)                        {}
func (h *metadataCaptureHandler) OnTerminalSessionMetadataChanged(_ string, info TerminalSessionInfo) {
	h.mu.Lock()
	h.updates = append(h.updates, info)
	h.mu.Unlock()
}

func (h *metadataCaptureHandler) snapshot() []TerminalSessionInfo {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]TerminalSessionInfo(nil), h.updates...)
}

func TestSessionTracksForegroundCommandMetadataFromShellIntegration(t *testing.T) {
	handler := &metadataCaptureHandler{}
	session := &Session{
		ID:                "session-command",
		Name:              "repo",
		WorkingDir:        "/workspace/repo",
		CreatedAt:         time.Now(),
		LastActive:        time.Now(),
		connections:       make(map[string]*ConnectionInfo),
		liveAttachments:   make(map[string]liveAttachment),
		currentWorkingDir: "/workspace/repo",
		eventHandler:      handler,
		config:            newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	session.processRawPTYData([]byte("\x1b]633;P;FloetermProgram=top\a\x1b]633;C\a"))
	info := session.ToSessionInfo()
	if info.ForegroundCommand.Phase != ForegroundCommandRunning || info.ForegroundCommand.DisplayName != "top" {
		t.Fatalf("foreground command = %+v, want running top", info.ForegroundCommand)
	}
	if info.ForegroundCommand.Revision != 1 {
		t.Fatalf("revision = %d, want 1", info.ForegroundCommand.Revision)
	}

	session.processRawPTYData([]byte("top output\r\n"))
	if got := session.ToSessionInfo().ForegroundCommand.Revision; got != 1 {
		t.Fatalf("ordinary output changed revision to %d", got)
	}
	if updates := handler.snapshot(); len(updates) != 1 {
		t.Fatalf("metadata updates = %d, want 1", len(updates))
	}

	session.processRawPTYData([]byte("\x1b]633;D;0\a\x1b]633;A\a"))
	info = session.ToSessionInfo()
	if info.ForegroundCommand.Phase != ForegroundCommandIdle || info.ForegroundCommand.DisplayName != "" {
		t.Fatalf("foreground command = %+v, want idle", info.ForegroundCommand)
	}
	if info.ForegroundCommand.Revision != 2 {
		t.Fatalf("revision = %d, want 2", info.ForegroundCommand.Revision)
	}
	if updates := handler.snapshot(); len(updates) != 2 {
		t.Fatalf("metadata updates = %d, want 2", len(updates))
	} else if updates[1].OutputActivity != info.OutputActivity {
		t.Fatalf("metadata output activity = %+v, want snapshot %+v", updates[1].OutputActivity, info.OutputActivity)
	}
}

func TestShellIntegrationProgramMarkerIsBoundedAndSafe(t *testing.T) {
	tests := []struct {
		name  string
		token string
		valid bool
	}{
		{name: "simple", token: "top", valid: true},
		{name: "path basename", token: "node-20.1", valid: true},
		{name: "space", token: "top --secret", valid: false},
		{name: "bel injection", token: "top\aevil", valid: false},
		{name: "unicode", token: "工具", valid: false},
		{name: "too long", token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", valid: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := normalizeForegroundCommandDisplayName(test.token)
			if ok != test.valid {
				t.Fatalf("valid = %v, want %v (value %q)", ok, test.valid, got)
			}
			if test.valid && got != test.token {
				t.Fatalf("value = %q, want %q", got, test.token)
			}
			if !test.valid && got != "" {
				t.Fatalf("invalid value = %q, want empty", got)
			}
		})
	}
}

func TestShellIntegrationLifecycleMarkerRequiresStrictNonceAndEvent(t *testing.T) {
	const nonce = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for _, event := range []string{"integration_ready", "command_finished", "prompt_ready"} {
		signal, source, invalid, recognized := parseShellIntegrationSignalPayload(
			"633;P;FloetermLifecycle=v1;nonce=" + nonce + ";event=" + event,
		)
		if !recognized || invalid || source != "osc_633_lifecycle" || signal.lifecycleNonce != nonce {
			t.Fatalf("valid lifecycle marker event=%s signal=%+v source=%q invalid=%v recognized=%v", event, signal, source, invalid, recognized)
		}
	}
	for _, payload := range []string{
		"633;P;FloetermLifecycle=v1;nonce=short;event=command_finished",
		"633;P;FloetermLifecycle=v1;nonce=" + strings.Repeat("A", 64) + ";event=command_finished",
		"633;P;FloetermLifecycle=v1;nonce=" + nonce + ";event=command_started",
		"633;P;FloetermLifecycle=v1;nonce=" + nonce + ";event=prompt_ready;extra=x",
	} {
		_, source, invalid, recognized := parseShellIntegrationSignalPayload(payload)
		if !recognized || !invalid || source != "osc_633_lifecycle" {
			t.Fatalf("invalid lifecycle marker accepted: payload=%q source=%q invalid=%v recognized=%v", payload, source, invalid, recognized)
		}
	}
}

func TestPrivateLifecycleFilterFlushesOnlyOrdinaryPartialPrefixes(t *testing.T) {
	for _, test := range []struct {
		name    string
		pending string
		want    string
	}{
		{name: "ordinary partial prefix", pending: "tail\x1b]633;P;FloetermLife", want: "tail\x1b]633;P;FloetermLife"},
		{name: "private marker fragment", pending: "\x1b]633;P;FloetermLifecycle=v1;nonce=secret", want: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			session := &Session{shellLifecycleFilterPending: []byte(test.pending)}
			if got := string(session.flushPrivateShellLifecycleFilter()); got != test.want {
				t.Fatalf("flush = %q, want %q", got, test.want)
			}
			if len(session.shellLifecycleFilterPending) != 0 {
				t.Fatalf("flush retained pending bytes: %q", session.shellLifecycleFilterPending)
			}
		})
	}
}

func TestOversizedKnownControlsKeepContentFreeDiagnosticSources(t *testing.T) {
	tests := []struct {
		prefix string
		source string
	}{
		{prefix: "633;P;FloetermProgram=", source: "osc_633_program"},
		{prefix: "633;P;FloetermSshTarget=", source: "osc_633_ssh_target"},
		{prefix: "633;P;FloetermContext=", source: "osc_633_context"},
		{prefix: "633;P;FloetermWork=", source: "osc_633_work"},
		{prefix: "633;P;Cwd=", source: "osc_633"},
		{prefix: "1337;CurrentDir=", source: "osc_1337"},
		{prefix: "7;file://", source: "osc_7"},
		{prefix: "0;", source: "osc_title"},
		{prefix: "2;", source: "osc_title"},
	}
	for _, test := range tests {
		t.Run(test.source+"_"+test.prefix, func(t *testing.T) {
			sequence := []byte("\x1b]" + test.prefix + strings.Repeat("x", maxShellIntegrationPayloadBytes) + "\a")
			tokens, malformed, pending := parseShellIntegrationTokens(sequence)
			if len(tokens) != 0 || len(pending) != 0 || len(malformed) != 1 || malformed[0] != test.source {
				t.Fatalf("tokens=%+v malformed=%+v pending=%q", tokens, malformed, pending)
			}
			if strings.Contains(malformed[0], strings.Repeat("x", 8)) {
				t.Fatalf("diagnostic source contained payload: %q", malformed[0])
			}
		})
	}
}

func TestParseShellIntegrationSignalsKeepsFragmentedProgramAndCommandTogether(t *testing.T) {
	firstSignals, firstMalformed, pending := parseShellIntegrationSignals([]byte("before\x1b]633;P;FloetermPro"))
	if len(firstSignals) != 0 || len(firstMalformed) != 0 || len(pending) == 0 {
		t.Fatalf("first parse = signals=%v malformed=%v pending=%q", firstSignals, firstMalformed, pending)
	}

	buffer := append(append([]byte(nil), pending...), []byte("gram=top\a\x1b]633;C\a")...)
	signals, malformed, pending := parseShellIntegrationSignals(buffer)
	if len(malformed) != 0 || len(pending) != 0 {
		t.Fatalf("second parse malformed=%v pending=%q", malformed, pending)
	}
	if len(signals) != 2 || signals[0].kind != shellIntegrationProgram || signals[0].program != "top" || signals[1].kind != shellIntegrationCommandExecuted {
		t.Fatalf("signals = %+v", signals)
	}
}

func TestParseShellIntegrationSignalsKeepsSplitOscIntroducer(t *testing.T) {
	firstSignals, firstMalformed, pending := parseShellIntegrationSignals([]byte("before\x1b"))
	if len(firstSignals) != 0 || len(firstMalformed) != 0 || string(pending) != "\x1b" {
		t.Fatalf("first parse = signals=%v malformed=%v pending=%q", firstSignals, firstMalformed, pending)
	}

	buffer := append(append([]byte(nil), pending...), []byte("]633;P;FloetermProgram=top\a\x1b]633;C\a")...)
	signals, malformed, pending := parseShellIntegrationSignals(buffer)
	if len(malformed) != 0 || len(pending) != 0 || len(signals) != 2 {
		t.Fatalf("second parse = signals=%v malformed=%v pending=%q", signals, malformed, pending)
	}
}

func TestShellIntegrationCommandStartClearsStaleProgramAndRunningCannotBeOverwritten(t *testing.T) {
	session := &Session{
		ID:              "session-boundaries",
		connections:     make(map[string]*ConnectionInfo),
		liveAttachments: make(map[string]liveAttachment),
		config:          newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	session.checkShellIntegrationChange([]byte("\x1b]633;A\a\x1b]633;P;FloetermProgram=stale\a\x1b]633;B\a\x1b]633;C\a"))
	first := session.ToSessionInfo().ForegroundCommand
	if first.Phase != ForegroundCommandRunning || first.DisplayName != "" {
		t.Fatalf("foreground command after stale pending = %+v", first)
	}

	session.checkShellIntegrationChange([]byte("\x1b]633;D;0\a\x1b]633;A\a\x1b]633;B\a\x1b]633;P;FloetermProgram=top\a\x1b]633;C\a"))
	running := session.ToSessionInfo().ForegroundCommand
	if running.Phase != ForegroundCommandRunning || running.DisplayName != "top" {
		t.Fatalf("foreground command = %+v, want running top", running)
	}

	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermProgram=evil\a\x1b]633;C\a"))
	afterDuplicate := session.ToSessionInfo().ForegroundCommand
	if afterDuplicate != running {
		t.Fatalf("duplicate C overwrote running command: before=%+v after=%+v", running, afterDuplicate)
	}
}

func TestShellIntegrationPreservesLongWorkingDirectorySignals(t *testing.T) {
	longPath := "/" + strings.Repeat("deep/", 100) + "repo"
	signals, malformed, pending := parseShellIntegrationSignals([]byte("\x1b]633;P;Cwd=" + longPath + "\a"))
	if len(malformed) != 0 || len(pending) != 0 {
		t.Fatalf("malformed=%v pending=%d", malformed, len(pending))
	}
	if len(signals) != 1 || signals[0].kind != shellIntegrationCwd || signals[0].path != longPath {
		t.Fatalf("signals = %+v", signals)
	}
}

func TestSessionCloseClearsForegroundCommandSnapshot(t *testing.T) {
	session := &Session{
		ID:              "session-close-command",
		connections:     make(map[string]*ConnectionInfo),
		liveAttachments: make(map[string]liveAttachment),
		foregroundCommand: TerminalForegroundCommandInfo{
			Phase:       ForegroundCommandRunning,
			DisplayName: "top",
			Revision:    2,
			UpdatedAt:   time.Now().UnixMilli(),
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if got := session.ToSessionInfo().ForegroundCommand; got.Phase != ForegroundCommandUnknown || got.DisplayName != "" || got.Revision != 3 {
		t.Fatalf("foreground command after close = %+v", got)
	}
}

func BenchmarkParseShellIntegrationSignalsNoMetadata64KiB(b *testing.B) {
	payload := bytes.Repeat([]byte("terminal output without control metadata\n"), 2048)
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	for index := 0; index < b.N; index++ {
		signals, malformed, pending := parseShellIntegrationSignals(payload)
		if len(signals) != 0 || len(malformed) != 0 || len(pending) != 0 {
			b.Fatalf("unexpected parser result: signals=%d malformed=%d pending=%d", len(signals), len(malformed), len(pending))
		}
	}
}

func BenchmarkSessionCheckShellIntegrationNoMetadata64KiB(b *testing.B) {
	payload := bytes.Repeat([]byte("terminal output without control metadata\n"), 2048)
	session := &Session{}
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	for index := 0; index < b.N; index++ {
		session.checkShellIntegrationChange(payload)
	}
}

func BenchmarkSessionCheckShellIntegrationSteadyStreaming64KiB(b *testing.B) {
	payload := bytes.Repeat([]byte("terminal output without control metadata\n"), 2048)
	session := &Session{
		foregroundCommand: TerminalForegroundCommandInfo{
			Phase:       ForegroundCommandRunning,
			DisplayName: "codex",
			Revision:    1,
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.checkShellIntegrationChange(payload)
	b.Cleanup(func() { _ = session.Close() })
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		session.checkShellIntegrationChange(payload)
	}
}

func BenchmarkSessionCheckShellIntegrationSteadyStreamingANSI64KiB(b *testing.B) {
	payload := bytes.Repeat([]byte("\x1b[38;5;81magent output\x1b[0m\r"), 2800)
	session := &Session{
		foregroundCommand: TerminalForegroundCommandInfo{
			Phase:       ForegroundCommandRunning,
			DisplayName: "claude",
			Revision:    1,
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.checkShellIntegrationChange(payload)
	b.Cleanup(func() { _ = session.Close() })
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		session.checkShellIntegrationChange(payload)
	}
}
