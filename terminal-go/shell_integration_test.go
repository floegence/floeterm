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
	default:
		return "unknown"
	}
}

type metadataCaptureHandler struct {
	mu      sync.Mutex
	updates []TerminalSessionInfo
}

type closingMetadataCaptureHandler struct {
	session *Session
	updates int
}

func (h *closingMetadataCaptureHandler) OnTerminalData(string, TerminalOutputEvent) {
	_ = h.session.Close()
}
func (h *closingMetadataCaptureHandler) OnTerminalNameChanged(string, string, string, string) {}
func (h *closingMetadataCaptureHandler) OnTerminalSessionCreated(*Session)                    {}
func (h *closingMetadataCaptureHandler) OnTerminalSessionClosed(string)                       {}
func (h *closingMetadataCaptureHandler) OnTerminalError(string, error)                        {}
func (h *closingMetadataCaptureHandler) OnTerminalSessionMetadataChanged(string, TerminalSessionInfo) {
	h.updates++
}

func (h *metadataCaptureHandler) OnTerminalData(string, TerminalOutputEvent)           {}
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
		ID:                   "session-command",
		Name:                 "repo",
		WorkingDir:           "/workspace/repo",
		CreatedAt:            time.Now(),
		LastActive:           time.Now(),
		connections:          make(map[string]*ConnectionInfo),
		liveAttachments:      make(map[string]liveAttachment),
		ringBuffer:           NewTerminalRingBuffer(8),
		historyGeneration:    1,
		historyStartSequence: 1,
		currentWorkingDir:    "/workspace/repo",
		eventHandler:         handler,
		config:               newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
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

	if err := session.ClearHistory(); err != nil {
		t.Fatal(err)
	}
	if got := session.ToSessionInfo().ForegroundCommand; got.Phase != ForegroundCommandRunning || got.DisplayName != "top" || got.Revision != 1 {
		t.Fatalf("clear history changed foreground command: %+v", got)
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

func TestDataHandlerClosePreventsStaleForegroundCommandUpdate(t *testing.T) {
	session := &Session{
		ID:              "session-close-during-output",
		connections:     make(map[string]*ConnectionInfo),
		liveAttachments: make(map[string]liveAttachment),
		config:          newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	handler := &closingMetadataCaptureHandler{session: session}
	session.eventHandler = handler

	session.processRawPTYData([]byte("\x1b]633;P;FloetermProgram=top\a\x1b]633;C\a"))

	if handler.updates != 0 {
		t.Fatalf("metadata updates after close = %d, want 0", handler.updates)
	}
	if got := session.ToSessionInfo().ForegroundCommand; got.Phase != ForegroundCommandUnknown || got.DisplayName != "" {
		t.Fatalf("foreground command after close = %+v, want unknown", got)
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
