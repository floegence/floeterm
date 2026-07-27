package terminal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type contextProtocolVectorFile struct {
	Cases []struct {
		Name               string `json:"name"`
		Kind               string `json:"kind"`
		Valid              bool   `json:"valid"`
		Payload            string `json:"payload"`
		CanonicalAuthority string `json:"canonicalAuthority"`
	} `json:"cases"`
	StateCases []struct {
		Name     string   `json:"name"`
		Payloads []string `json:"payloads"`
		Expected struct {
			ContextRevision uint64            `json:"contextRevision"`
			WorkRevision    uint64            `json:"workRevision"`
			WorkPhase       TerminalWorkPhase `json:"workPhase"`
			TopFrameID      string            `json:"topFrameId"`
			Depth           int               `json:"depth"`
		} `json:"expected"`
	} `json:"stateCases"`
	TransitionCases []struct {
		Name  string `json:"name"`
		Steps []struct {
			Payload         string `json:"payload"`
			Operation       string `json:"operation"`
			Changed         bool   `json:"changed"`
			ContextRevision uint64 `json:"contextRevision"`
			WorkRevision    uint64 `json:"workRevision"`
			TopFrameID      string `json:"topFrameId"`
			Depth           int    `json:"depth"`
			Authority       string `json:"authority"`
			Label           string `json:"label"`
			Cwd             string `json:"cwd"`
		} `json:"steps"`
	} `json:"transitionCases"`
}

type contextVectorLogger struct {
	mu      sync.Mutex
	entries []string
}

func (l *contextVectorLogger) append(message string, values ...any) {
	l.mu.Lock()
	l.entries = append(l.entries, message+" "+fmt.Sprint(values...))
	l.mu.Unlock()
}

func (l *contextVectorLogger) Debug(message string, values ...any) { l.append(message, values...) }
func (l *contextVectorLogger) Info(message string, values ...any)  { l.append(message, values...) }
func (l *contextVectorLogger) Warn(message string, values ...any)  { l.append(message, values...) }
func (l *contextVectorLogger) Error(message string, values ...any) { l.append(message, values...) }

func (l *contextVectorLogger) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.entries...)
}

func TestTerminalContextV1SharedVectors(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "protocol", "terminal_context_v1_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors contextProtocolVectorFile
	if err := json.Unmarshal(content, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			valid := false
			var marker terminalContextMarker
			if vector.Kind == "work" {
				_, valid = parseFloetermWorkPayload(vector.Payload)
			} else {
				marker, valid = parseFloetermContextPayload(vector.Payload)
			}
			if valid != vector.Valid {
				t.Fatalf("valid=%v, want %v for %q", valid, vector.Valid, vector.Payload)
			}
			if valid && vector.CanonicalAuthority != "" && (marker.location == nil || marker.location.Authority != vector.CanonicalAuthority) {
				t.Fatalf("canonical authority=%q, want %q", marker.location.Authority, vector.CanonicalAuthority)
			}
		})
	}
}

func TestTerminalContextV1SharedStateVectors(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "protocol", "terminal_context_v1_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors contextProtocolVectorFile
	if err := json.Unmarshal(content, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.StateCases {
		t.Run(vector.Name, func(t *testing.T) {
			session := newExecutionContextTestSession()
			session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
			for _, payload := range vector.Payloads {
				session.checkShellIntegrationChange([]byte("\x1b]" + payload + "\a"))
			}
			info := session.ToSessionInfo()
			session.mu.RLock()
			depth := len(session.contextFrames)
			topFrameID := session.contextFrames[depth-1].id
			session.mu.RUnlock()
			if info.ExecutionContext.Revision != vector.Expected.ContextRevision ||
				info.WorkState.Revision != vector.Expected.WorkRevision ||
				info.WorkState.Phase != vector.Expected.WorkPhase || depth != vector.Expected.Depth || topFrameID != vector.Expected.TopFrameID {
				t.Fatalf("state context=%+v work=%+v top=%q depth=%d, want %+v", info.ExecutionContext, info.WorkState, topFrameID, depth, vector.Expected)
			}
		})
	}
}

func TestTerminalContextV1SharedTransitionVectors(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "protocol", "terminal_context_v1_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors contextProtocolVectorFile
	if err := json.Unmarshal(content, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.TransitionCases {
		t.Run(vector.Name, func(t *testing.T) {
			logger := &contextVectorLogger{}
			session := newExecutionContextTestSession()
			session.config.logger = logger
			session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
			for index, step := range vector.Steps {
				before := terminalContextTransitionSnapshot(session)
				switch step.Operation {
				case "":
					session.checkShellIntegrationChange([]byte("\x1b]" + step.Payload + "\a"))
				case "reset_foreground":
					session.updateForegroundCommand(ForegroundCommandIdle, "")
					session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
				case "fill_depth":
					for frame := 1; frame <= 14; frame++ {
						session.checkShellIntegrationChange([]byte(fmt.Sprintf("\x1b]633;P;FloetermContext=v1;action=push;frame_id=depth-%02d;application=shell\a", frame)))
					}
				case "fill_seen":
					for frame := 1; frame <= maxContextSeenFrameIDs; frame++ {
						frameID := fmt.Sprintf("seen-%02d", frame)
						session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=" + frameID + ";application=shell\a"))
						session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=" + frameID + "\a"))
					}
				default:
					t.Fatalf("step %d unknown operation %q", index, step.Operation)
				}
				after := terminalContextTransitionSnapshot(session)
				changed := !reflect.DeepEqual(after, before)
				if changed != step.Changed {
					t.Fatalf("step %d changed=%v, want %v: before=%+v after=%+v", index, changed, step.Changed, before, after)
				}
				topFrameID := ""
				if len(after.frames) > 0 {
					topFrameID = after.frames[len(after.frames)-1].id
				}
				if after.sessionInfo.ExecutionContext.Revision != step.ContextRevision || after.sessionInfo.WorkState.Revision != step.WorkRevision ||
					topFrameID != step.TopFrameID || len(after.frames) != step.Depth || after.sessionInfo.OutputActivity.Phase != OutputActivityUnknown {
					t.Fatalf("step %d snapshot=%+v", index, after)
				}
				if step.Authority != "" || step.Label != "" || step.Cwd != "" {
					location := after.sessionInfo.ExecutionContext.Location
					if location.Authority != step.Authority || location.Label != step.Label || location.WorkingDirectory != step.Cwd {
						t.Fatalf("step %d location=%+v", index, after)
					}
				}
				if !step.Changed {
					for _, entry := range logger.snapshot() {
						for _, atom := range rejectedPayloadAtoms(step.Payload) {
							if strings.Contains(entry, atom) {
								t.Fatalf("step %d logged rejected value %q: %q", index, atom, entry)
							}
						}
					}
				}
			}
		})
	}
}

type contextTransitionSnapshot struct {
	sessionInfo               TerminalSessionInfo
	frames                    []terminalContextFrame
	seenFrameIDs              []string
	contextForegroundRevision uint64
	shellIntegrationPending   []byte
}

func terminalContextTransitionSnapshot(session *Session) contextTransitionSnapshot {
	session.mu.RLock()
	defer session.mu.RUnlock()
	seenFrameIDs := make([]string, 0, len(session.contextSeenFrameIDs))
	for frameID := range session.contextSeenFrameIDs {
		seenFrameIDs = append(seenFrameIDs, frameID)
	}
	sort.Strings(seenFrameIDs)
	return contextTransitionSnapshot{
		sessionInfo:               session.toSessionInfoLocked(),
		frames:                    append([]terminalContextFrame(nil), session.contextFrames...),
		seenFrameIDs:              seenFrameIDs,
		contextForegroundRevision: session.contextForegroundRevision,
		shellIntegrationPending:   append([]byte(nil), session.shellIntegrationPending...),
	}
}

func rejectedPayloadAtoms(payload string) []string {
	var atoms []string
	for _, part := range strings.Split(payload, ";") {
		name, value, found := strings.Cut(part, "=")
		if !found || value == "" {
			continue
		}
		switch name {
		case "frame_id", "authority", "user", "cwd", "identity":
			if decoded, err := url.PathUnescape(value); err == nil && len(decoded) >= 3 {
				atoms = append(atoms, decoded)
			}
		}
	}
	return atoms
}

func TestRejectedTerminalContextVectorsNeverLogPayload(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "protocol", "terminal_context_v1_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors contextProtocolVectorFile
	if err := json.Unmarshal(content, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Cases {
		if vector.Valid {
			continue
		}
		t.Run(vector.Name, func(t *testing.T) {
			logger := &contextVectorLogger{}
			session := newExecutionContextTestSession()
			session.config.logger = logger
			session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
			session.checkShellIntegrationChange([]byte("\x1b]" + vector.Payload + "\a"))
			for _, entry := range logger.snapshot() {
				for _, atom := range rejectedPayloadAtoms(vector.Payload) {
					if strings.Contains(entry, atom) {
						t.Fatalf("logged rejected value %q: %q", atom, entry)
					}
				}
			}
		})
	}
}

type contextWorkCaptureHandler struct {
	metadata int
	contexts []TerminalExecutionContextInfo
	works    []TerminalWorkStateInfo
	data     [][]byte
}

type reentrantContextWorkHandler struct {
	contextWorkCaptureHandler
	session   *Session
	reentered chan string
}

type concurrentContextWorkHandler struct {
	contextWorkCaptureHandler
	mu sync.Mutex
}

func (h *concurrentContextWorkHandler) OnTerminalSessionMetadataChanged(string, TerminalSessionInfo) {
	h.mu.Lock()
	h.metadata++
	h.mu.Unlock()
}

func (h *concurrentContextWorkHandler) OnTerminalExecutionContextChanged(_ string, info TerminalExecutionContextInfo) {
	h.mu.Lock()
	h.contexts = append(h.contexts, info)
	h.mu.Unlock()
}

func (h *concurrentContextWorkHandler) OnTerminalSemanticWorkStateChanged(_ string, info TerminalWorkStateInfo) {
	h.mu.Lock()
	h.works = append(h.works, info)
	h.mu.Unlock()
}

func (h *concurrentContextWorkHandler) snapshot() ([]TerminalExecutionContextInfo, []TerminalWorkStateInfo) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]TerminalExecutionContextInfo(nil), h.contexts...), append([]TerminalWorkStateInfo(nil), h.works...)
}

func (h *reentrantContextWorkHandler) OnTerminalExecutionContextChanged(_ string, info TerminalExecutionContextInfo) {
	h.contexts = append(h.contexts, info)
	_ = h.session.ToSessionInfo()
	h.reentered <- "context"
}

func (h *reentrantContextWorkHandler) OnTerminalSemanticWorkStateChanged(_ string, info TerminalWorkStateInfo) {
	h.works = append(h.works, info)
	_ = h.session.ToSessionInfo()
	h.reentered <- "work"
}

func (h *contextWorkCaptureHandler) OnTerminalData(_ string, event TerminalOutputEvent) {
	h.data = append(h.data, append([]byte(nil), event.Data...))
}
func (*contextWorkCaptureHandler) OnTerminalNameChanged(string, string, string, string) {}
func (*contextWorkCaptureHandler) OnTerminalSessionCreated(*Session)                    {}
func (*contextWorkCaptureHandler) OnTerminalSessionClosed(string)                       {}
func (*contextWorkCaptureHandler) OnTerminalError(string, error)                        {}
func (h *contextWorkCaptureHandler) OnTerminalSessionMetadataChanged(string, TerminalSessionInfo) {
	h.metadata++
}
func (h *contextWorkCaptureHandler) OnTerminalExecutionContextChanged(_ string, info TerminalExecutionContextInfo) {
	h.contexts = append(h.contexts, info)
}
func (h *contextWorkCaptureHandler) OnTerminalSemanticWorkStateChanged(_ string, info TerminalWorkStateInfo) {
	h.works = append(h.works, info)
}

func newExecutionContextTestSession() *Session {
	workingDir := "/local/project"
	return &Session{
		ID: "context-test", Name: "project", WorkingDir: workingDir,
		CreatedAt: time.Now(), LastActive: time.Now(), currentWorkingDir: workingDir,
		foregroundCommand:   TerminalForegroundCommandInfo{Phase: ForegroundCommandIdle},
		outputActivity:      TerminalOutputActivityInfo{Phase: OutputActivityUnknown},
		executionContext:    newLocalExecutionContext(workingDir),
		workState:           TerminalWorkStateInfo{Phase: TerminalWorkUnknown},
		contextSeenFrameIDs: make(map[string]struct{}),
		config:              sessionConfig{logger: NopLogger{}, outputActivityQuietDuration: time.Hour},
	}
}

func TestContextMarkerStrictParsing(t *testing.T) {
	marker, ok := parseFloetermContextPayload("633;P;FloetermContext=v1;action=push;frame_id=remote-1;location=remote;authority=host.example;user=root;cwd=%2Froot;application=shell")
	if !ok || marker.frameID != "remote-1" || marker.location == nil || marker.location.Label != "root@host.example" || marker.location.WorkingDirectory != "/root" {
		t.Fatalf("parsed marker = %+v, ok=%v", marker, ok)
	}
	for _, payload := range []string{
		"633;P;FloetermContext=v2;action=push;frame_id=x;application=shell",
		"633;P;FloetermContext=v1;action=push;frame_id=x;application=shell;unknown=x",
		"633;P;FloetermContext=v1;action=push;frame_id=x;frame_id=x;application=shell",
		"633;P;FloetermContext=v1;action=push;frame_id=x;location=remote;authority=host%0Aevil;application=shell",
		"633;P;FloetermContext=v1;action=push;frame_id=x;application=agent_cli;identity=unknown",
		"633;P;FloetermContext=v1;action=push;frame_id=x;application=shell;cwd=%2Ftmp",
		"633;P;FloetermContext=v1;action=push;frame_id=x;application=shell;identity=",
	} {
		if _, ok := parseFloetermContextPayload(payload); ok {
			t.Fatalf("accepted invalid marker %q", payload)
		}
	}
}

func TestContextReplacePreservesOmittedFieldsForSameAuthority(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=remote-1;location=remote;authority=host.example;user=root;cwd=%2Froot;application=shell\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=replace;frame_id=remote-1;location=remote;authority=host.example\a"))
	location := session.ToSessionInfo().ExecutionContext.Location
	if location.Label != "root@host.example" || location.WorkingDirectory != "/root" {
		t.Fatalf("same-authority replace cleared omitted fields: %+v", location)
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=replace;frame_id=remote-1;location=remote;authority=other.example\a"))
	location = session.ToSessionInfo().ExecutionContext.Location
	if location.Label != "other.example" || location.WorkingDirectory != "" {
		t.Fatalf("changed-authority replace retained stale fields: %+v", location)
	}
}

func TestContextSameValueReplacePreservesEpochAndWork(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "codex")
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a"))
	before := session.ToSessionInfo()

	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=replace;frame_id=agent-1;application=agent_cli;identity=codex\a"))
	after := session.ToSessionInfo()

	if after.ExecutionContext.Revision != before.ExecutionContext.Revision || after.WorkState != before.WorkState {
		t.Fatalf("same-value replace changed epoch or work: before=%+v after=%+v", before, after)
	}
}

func TestContextStackRejectsNonTopDuplicateAndDelayedABAPop(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	pushA := []byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-a;application=agent_cli;identity=codex\a")
	pushB := []byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-b;application=agent_cli;identity=codex\a")
	session.checkShellIntegrationChange(pushA)
	session.checkShellIntegrationChange(pushB)
	beforeDuplicate := session.ToSessionInfo().ExecutionContext.Revision
	session.checkShellIntegrationChange(pushA)
	if got := session.ToSessionInfo().ExecutionContext.Revision; got != beforeDuplicate {
		t.Fatalf("non-top duplicate changed revision: %d -> %d", beforeDuplicate, got)
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-b;phase=working\a"))
	if got := session.ToSessionInfo().WorkState.Phase; got != TerminalWorkWorking {
		t.Fatalf("duplicate displaced top frame: work=%s", got)
	}

	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=agent-b\a"))
	afterPop := session.ToSessionInfo().ExecutionContext.Revision
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=agent-b\a"))
	if got := session.ToSessionInfo().ExecutionContext.Revision; got != afterPop {
		t.Fatalf("delayed ABA pop changed revision: %d -> %d", afterPop, got)
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-a;phase=waiting_user\a"))
	if got := session.ToSessionInfo().WorkState.Phase; got != TerminalWorkWaitingUser {
		t.Fatalf("delayed pop removed restored parent: work=%s", got)
	}
}

func TestRetiredIDReuseAndDelayedPopCannotAffectDifferentFrame(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	pushA := []byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-a;application=agent_cli;identity=codex\a")
	session.checkShellIntegrationChange(pushA)
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=agent-a\a"))
	afterPop := session.ToSessionInfo().ExecutionContext.Revision
	session.checkShellIntegrationChange(pushA)
	if got := session.ToSessionInfo().ExecutionContext.Revision; got != afterPop {
		t.Fatalf("retired id reuse changed revision: %d -> %d", afterPop, got)
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-b;application=agent_cli;identity=codex\a"))
	beforeDelayedPop := session.ToSessionInfo().ExecutionContext.Revision
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=agent-a\a"))
	if got := session.ToSessionInfo().ExecutionContext.Revision; got != beforeDelayedPop {
		t.Fatalf("delayed retired pop changed different frame: %d -> %d", beforeDelayedPop, got)
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-b;phase=working\a"))
	if got := session.ToSessionInfo().WorkState.Phase; got != TerminalWorkWorking {
		t.Fatalf("different active frame was displaced: work=%s", got)
	}
}

func TestContextStackTombstonesAndWorkFences(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a"))
	context := session.ToSessionInfo().ExecutionContext
	if context.Application.Identity != "codex" || context.Location.Phase != TerminalLocationPhaseOpening {
		t.Fatalf("agent context = %+v", context)
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a"))
	work := session.ToSessionInfo().WorkState
	if work.Phase != TerminalWorkWorking || work.ContextRevision != context.Revision || work.ForegroundCommandRevision != session.ToSessionInfo().ForegroundCommand.Revision {
		t.Fatalf("work state = %+v", work)
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=agent-1\a"))
	if got := session.ToSessionInfo().WorkState.Phase; got != TerminalWorkUnknown {
		t.Fatalf("work survived context pop: %s", got)
	}
	revision := session.ToSessionInfo().ExecutionContext.Revision
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a"))
	if got := session.ToSessionInfo().ExecutionContext.Revision; got != revision {
		t.Fatalf("retired frame id was reused: revision %d -> %d", revision, got)
	}
}

func TestNestedAgentKeepsParentLocationLiveAndCreatesWorkEpoch(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a"))
	firstRevision := session.ToSessionInfo().ExecutionContext.Revision
	session.checkShellIntegrationChange([]byte("\x1b]7;file://host.example/root/repo\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-2;application=agent_cli;identity=codex\a"))
	afterPush := session.ToSessionInfo()
	if afterPush.ExecutionContext.Revision <= firstRevision || afterPush.WorkState.Phase != TerminalWorkUnknown {
		t.Fatalf("same-identity push did not create work epoch: %+v", afterPush)
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=waiting_user\a"))
	if got := session.ToSessionInfo().WorkState.Phase; got != TerminalWorkUnknown {
		t.Fatalf("stale parent work applied to child frame: %s", got)
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=agent-2\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=agent-1\a"))
	location := session.ToSessionInfo().ExecutionContext.Location
	if location.Phase != TerminalLocationPhaseReady || location.Authority != "host.example" || location.WorkingDirectory != "/root/repo" {
		t.Fatalf("agent pop restored stale SSH location: %+v", location)
	}
}

func TestDedicatedHandlersAndDuplicatePushAreNoOp(t *testing.T) {
	handler := &contextWorkCaptureHandler{}
	session := newExecutionContextTestSession()
	session.eventHandler = handler
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	if handler.metadata != 1 || len(handler.contexts) != 1 {
		t.Fatalf("foreground callbacks metadata=%d context=%d", handler.metadata, len(handler.contexts))
	}
	push := []byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a")
	session.checkShellIntegrationChange(push)
	contextCallbacks := len(handler.contexts)
	metadataCallbacks := handler.metadata
	session.checkShellIntegrationChange(push)
	if len(handler.contexts) != contextCallbacks || handler.metadata != metadataCallbacks {
		t.Fatalf("duplicate push emitted callbacks metadata=%d context=%d", handler.metadata, len(handler.contexts))
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a"))
	if len(handler.works) != 1 || handler.metadata != metadataCallbacks {
		t.Fatalf("work callback routing metadata=%d work=%d", handler.metadata, len(handler.works))
	}
}

func TestDedicatedContextAndWorkHandlersAllowSynchronousReentry(t *testing.T) {
	session := newExecutionContextTestSession()
	handler := &reentrantContextWorkHandler{session: session, reentered: make(chan string, 4)}
	session.eventHandler = handler
	done := make(chan struct{})
	go func() {
		defer close(done)
		session.updateForegroundCommand(ForegroundCommandRunning, "codex")
		session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a"))
		session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a"))
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("dedicated context/work handler deadlocked during synchronous reentry")
	}
	if len(handler.contexts) < 2 || len(handler.works) != 1 || len(handler.reentered) < 3 {
		t.Fatalf("reentrant callbacks context=%d work=%d reentered=%d", len(handler.contexts), len(handler.works), len(handler.reentered))
	}
}

func TestConcurrentContextMetadataAndClose(t *testing.T) {
	session := newExecutionContextTestSession()
	handler := &concurrentContextWorkHandler{}
	session.eventHandler = handler
	session.updateForegroundCommand(ForegroundCommandRunning, "codex")
	contextMarker := []byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a")
	workMarker := []byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a")
	session.checkShellIntegrationChange(contextMarker)
	session.checkShellIntegrationChange(workMarker)
	var workers sync.WaitGroup
	for index := 0; index < 4; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for attempt := 0; attempt < 100; attempt++ {
				session.checkShellIntegrationChange(contextMarker)
				session.checkShellIntegrationChange(workMarker)
				_ = session.ToSessionInfo()
			}
		}()
	}
	workers.Add(1)
	go func() {
		defer workers.Done()
		_ = session.Close()
	}()
	workers.Wait()
	session.mu.RLock()
	closed := session.closed
	session.mu.RUnlock()
	if !closed {
		t.Fatal("session remained open")
	}
	contexts, works := handler.snapshot()
	if len(contexts) != 2 || contexts[0].Revision >= contexts[1].Revision || len(works) != 1 || works[0].Revision != 1 {
		t.Fatalf("dedicated handler revisions context=%+v work=%+v", contexts, works)
	}
}

func TestSSHContextKeepsRemotePathOutOfLocalSessionMetadata(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	opening := session.ToSessionInfo().ExecutionContext
	if opening.Location.Kind != TerminalLocationRemote || opening.Location.Phase != TerminalLocationPhaseOpening || opening.Location.Label != "SSH" {
		t.Fatalf("opening context = %+v", opening)
	}
	session.checkShellIntegrationChange([]byte("\x1b]2;root@server.example\a"))
	titleCandidate := session.ToSessionInfo().ExecutionContext.Location
	if titleCandidate.Phase != TerminalLocationPhaseOpening || titleCandidate.Authority != "" || titleCandidate.Label != "root@server.example" {
		t.Fatalf("title-only candidate = %+v", titleCandidate)
	}
	session.checkShellIntegrationChange([]byte("\x1b]7;file://server.example/root/project\a"))
	ready := session.ToSessionInfo()
	if ready.WorkingDir != "/local/project" || ready.Name != "project" {
		t.Fatalf("remote OSC7 changed local metadata: %+v", ready)
	}
	if ready.ExecutionContext.Location.Phase != TerminalLocationPhaseReady || ready.ExecutionContext.Location.Authority != "server.example" || ready.ExecutionContext.Location.WorkingDirectory != "/root/project" {
		t.Fatalf("ready context = %+v", ready.ExecutionContext)
	}
	if ready.ExecutionContext.Location.Label != "root@server.example" {
		t.Fatalf("OSC7 discarded matching title user: %+v", ready.ExecutionContext.Location)
	}
	session.checkShellIntegrationChange([]byte("\x1b]2;root@server.example\a"))
	if got := session.ToSessionInfo().ExecutionContext.Location.Label; got != "root@server.example" {
		t.Fatalf("title label = %q", got)
	}
	revision := session.ToSessionInfo().ExecutionContext.Revision
	session.checkShellIntegrationChange([]byte("\x1b]2;root@other.example\a"))
	if got := session.ToSessionInfo().ExecutionContext; got.Revision != revision || got.Location.Label != "root@server.example" {
		t.Fatalf("mismatched title changed context: %+v", got)
	}
	session.checkShellIntegrationChange([]byte("\x1b]633;P;Cwd=/root/next\a"))
	if got := session.ToSessionInfo(); got.WorkingDir != "/local/project" || got.ExecutionContext.Location.WorkingDirectory != "/root/next" {
		t.Fatalf("remote cwd isolation failed: %+v", got)
	}
	t.Setenv("HOME", "/local/secret-home")
	session.checkShellIntegrationChange([]byte("\x1b]633;P;Cwd=~\a"))
	if got := session.ToSessionInfo().ExecutionContext.Location.WorkingDirectory; got != "/root/next" {
		t.Fatalf("remote tilde used local HOME: %q", got)
	}
	session.updateForegroundCommand(ForegroundCommandIdle, "")
	local := session.ToSessionInfo().ExecutionContext
	if local.Location.Kind != TerminalLocationLocal || local.Location.WorkingDirectory != "/local/project" || local.Application.Kind != TerminalApplicationShell {
		t.Fatalf("restored local context = %+v", local)
	}
}

func TestExplicitRemoteIdentityRejectsLateTitleWithoutClearingAgentWork(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=remote-1;location=remote;authority=host.example;user=root;application=shell\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a"))
	before := session.ToSessionInfo()

	session.checkShellIntegrationChange([]byte("\x1b]2;other@host.example\a"))
	after := session.ToSessionInfo()
	if after.ExecutionContext != before.ExecutionContext || after.WorkState != before.WorkState {
		t.Fatalf("late title overrode explicit context: before=%+v after=%+v", before, after)
	}
}

func TestActiveRemoteContextRejectsForgedLocalFramesUntilForegroundExit(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	before := session.ToSessionInfo()

	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=forged-local;location=local;application=shell\a"))
	afterPush := session.ToSessionInfo()
	if afterPush.ExecutionContext != before.ExecutionContext || afterPush.WorkState != before.WorkState {
		t.Fatalf("forged local push changed remote context: before=%+v after=%+v", before, afterPush)
	}
	session.mu.RLock()
	_, seen := session.contextSeenFrameIDs["forged-local"]
	depth := len(session.contextFrames)
	session.mu.RUnlock()
	if seen || depth != 2 {
		t.Fatalf("rejected local push mutated frame state: seen=%v depth=%d", seen, depth)
	}

	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=remote-1;location=remote;authority=host.example;user=root;application=shell\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a"))
	beforeReplace := session.ToSessionInfo()
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=replace;frame_id=agent-1;location=local\a"))
	afterReplace := session.ToSessionInfo()
	if afterReplace.ExecutionContext != beforeReplace.ExecutionContext || afterReplace.WorkState != beforeReplace.WorkState {
		t.Fatalf("forged local replace changed remote Agent context: before=%+v after=%+v", beforeReplace, afterReplace)
	}

	session.updateForegroundCommand(ForegroundCommandIdle, "")
	local := session.ToSessionInfo().ExecutionContext
	if local.Location.Kind != TerminalLocationLocal || local.Location.WorkingDirectory != "/local/project" {
		t.Fatalf("foreground exit did not restore local context: %+v", local)
	}
}

func TestActiveRemoteContextRejectsFinalPopButAllowsNestedRemotePops(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "sudo")
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=remote-1;location=remote;authority=host.example;user=root;application=shell\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a"))

	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=agent-1\a"))
	afterAgentPop := session.ToSessionInfo()
	if afterAgentPop.ExecutionContext.Location.Kind != TerminalLocationRemote || afterAgentPop.ExecutionContext.Location.Authority != "host.example" || afterAgentPop.ExecutionContext.Application.Kind != TerminalApplicationShell {
		t.Fatalf("nested Agent pop did not preserve remote parent: %+v", afterAgentPop.ExecutionContext)
	}

	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=remote-2;location=remote;authority=nested.example;application=shell\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=remote-2\a"))
	afterNestedRemotePop := session.ToSessionInfo()
	if afterNestedRemotePop.ExecutionContext.Location.Kind != TerminalLocationRemote || afterNestedRemotePop.ExecutionContext.Location.Authority != "host.example" {
		t.Fatalf("nested remote pop did not restore remote parent: %+v", afterNestedRemotePop.ExecutionContext)
	}

	beforeFinalPop := session.ToSessionInfo()
	session.mu.RLock()
	depthBeforeFinalPop := len(session.contextFrames)
	session.mu.RUnlock()
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=remote-1\a"))
	afterFinalPop := session.ToSessionInfo()
	session.mu.RLock()
	depthAfterFinalPop := len(session.contextFrames)
	session.mu.RUnlock()
	if afterFinalPop.ExecutionContext != beforeFinalPop.ExecutionContext || afterFinalPop.WorkState != beforeFinalPop.WorkState || depthAfterFinalPop != depthBeforeFinalPop {
		t.Fatalf("final remote pop mutated context floor: before=%+v after=%+v depth=%d->%d", beforeFinalPop, afterFinalPop, depthBeforeFinalPop, depthAfterFinalPop)
	}
}

func TestActiveRemoteContextRejectsForgedPTYLifecycleUntilAuthenticatedLocalExit(t *testing.T) {
	const nonce = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	session := newExecutionContextTestSession()
	session.shellLifecycleNonce = nonce
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	session.processRawPTYData([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=remote-1;location=remote;authority=host.example;user=root;application=shell\a"))
	session.processRawPTYData([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a"))
	session.processRawPTYData([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a"))
	before := session.ToSessionInfo()

	session.processRawPTYData([]byte(
		"\x1b]633;D;0\a\x1b]633;A\a" +
			"\x1b]633;B\a\x1b]633;P;FloetermProgram=top\a\x1b]633;C\a" +
			"\x1b]633;P;FloetermContext=v1;action=push;frame_id=forged-local;location=local;application=shell\a",
	))
	afterForged := session.ToSessionInfo()
	if afterForged.ForegroundCommand != before.ForegroundCommand || afterForged.ExecutionContext != before.ExecutionContext || afterForged.WorkState != before.WorkState {
		t.Fatalf("forged PTY lifecycle changed remote epoch: before=%+v after=%+v", before, afterForged)
	}

	session.processRawPTYData([]byte("\x1b]633;P;FloetermLifecycle=v1;nonce=" + strings.Repeat("f", 64) + ";event=command_finished\a"))
	afterWrongNonce := session.ToSessionInfo()
	if afterWrongNonce.ForegroundCommand != before.ForegroundCommand || afterWrongNonce.ExecutionContext != before.ExecutionContext || afterWrongNonce.WorkState != before.WorkState {
		t.Fatalf("wrong lifecycle nonce changed remote epoch: before=%+v after=%+v", before, afterWrongNonce)
	}

	session.processRawPTYData([]byte("\x1b]633;P;FloetermLifecycle=v1;nonce=" + nonce + ";event=command_finished\a"))
	local := session.ToSessionInfo()
	if local.ForegroundCommand.Phase != ForegroundCommandIdle || local.ExecutionContext.Location.Kind != TerminalLocationLocal || local.ExecutionContext.Location.WorkingDirectory != "/local/project" {
		t.Fatalf("authenticated local lifecycle did not restore local idle context: %+v", local)
	}
	if local.WorkState.Phase != TerminalWorkUnknown {
		t.Fatalf("authenticated local lifecycle did not clear remote work: %+v", local.WorkState)
	}
}

func TestLocalContextMarkerRemainsValidWithoutRemoteFloor(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "top")
	beforeRevision := session.ToSessionInfo().ExecutionContext.Revision

	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=local-1;location=local;application=shell\a"))
	local := session.ToSessionInfo().ExecutionContext
	if local.Location.Kind != TerminalLocationLocal || local.Location.WorkingDirectory != "/local/project" || local.Revision <= beforeRevision {
		t.Fatalf("valid local context marker was rejected: before=%d after=%+v", beforeRevision, local)
	}
}

func TestLocalWorkingDirectoryContextChangeNotifiesClearedWork(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "codex")
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a"))
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a"))
	handler := &contextWorkCaptureHandler{}
	session.eventHandler = handler

	session.applyWorkingDirectoryChange("/local/next")

	if len(handler.contexts) != 1 || len(handler.works) != 1 || handler.works[0].Phase != TerminalWorkUnknown {
		t.Fatalf("cwd callbacks context=%+v work=%+v", handler.contexts, handler.works)
	}
}

func TestStandardOSCIsPreservedInHistoryAndLiveOutput(t *testing.T) {
	session := newExecutionContextTestSession()
	handler := &contextWorkCaptureHandler{}
	session.eventHandler = handler
	session.ringBuffer = NewTerminalRingBufferWithLimits(8, 8, 64*1024)
	session.liveAttachments = make(map[string]liveAttachment)
	session.connections = make(map[string]*ConnectionInfo)
	var subscriberBytes []byte
	attachment, err := session.AttachLiveConnection("context-live", 1, 80, 24, LiveSubscriber{
		OnOutput: func(event TerminalOutputEvent) bool {
			subscriberBytes = append(subscriberBytes, event.Data...)
			return true
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer attachment.Detach()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	parts := [][]byte{
		[]byte("\x1b]2;root@host.example\a"),
		[]byte("\x1b]7;file://host.example/root\x1b"),
		[]byte("\\"),
	}
	for _, part := range parts {
		session.processRawPTYData(part)
	}
	history, err := session.GetHistoryFromSequence(1)
	if err != nil {
		t.Fatal(err)
	}
	var historyBytes []byte
	for _, chunk := range history {
		historyBytes = append(historyBytes, chunk.Data...)
	}
	var liveBytes []byte
	for _, chunk := range handler.data {
		liveBytes = append(liveBytes, chunk...)
	}
	want := bytes.Join(parts, nil)
	if !bytes.Equal(historyBytes, want) || !bytes.Equal(liveBytes, want) || !bytes.Equal(subscriberBytes, want) {
		t.Fatalf("OSC bytes changed: history=%q handler=%q subscriber=%q want=%q", historyBytes, liveBytes, subscriberBytes, want)
	}
	if got := session.ToSessionInfo().OutputActivity.Phase; got != OutputActivityUnknown {
		t.Fatalf("standard OSC produced output activity: %s", got)
	}
}

func FuzzFloetermContextParserNeverPanics(f *testing.F) {
	f.Add("633;P;FloetermContext=v1;action=push;frame_id=x;application=shell")
	f.Add("633;P;FloetermWork=v1;frame_id=x;phase=working")
	f.Fuzz(func(t *testing.T, payload string) {
		_, _ = parseFloetermContextPayload(payload)
		_, _ = parseFloetermWorkPayload(payload)
	})
}

func TestMetadataControlsDoNotCreateOutputActivity(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	for _, control := range []string{
		"\x1b]7;file://server.example/root\a",
		"\x1b]2;root@server.example\a",
		"\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\a",
		"\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working\a",
	} {
		session.checkShellIntegrationChange([]byte(control))
	}
	if got := session.ToSessionInfo().OutputActivity.Phase; got != OutputActivityUnknown {
		t.Fatalf("metadata produced output activity: %s", got)
	}
	session.checkShellIntegrationChange([]byte("visible output"))
	if got := session.ToSessionInfo().OutputActivity.Phase; got != OutputActivityStreaming {
		t.Fatalf("visible output phase = %s", got)
	}
}

func TestContextFrameLimitsFailClosed(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	for index := 0; index < maxContextFrames+4; index++ {
		marker := "\x1b]633;P;FloetermContext=v1;action=push;frame_id=f" + strings.Repeat("x", index) + ";application=shell\a"
		session.checkShellIntegrationChange([]byte(marker))
	}
	session.mu.RLock()
	depth := len(session.contextFrames)
	session.mu.RUnlock()
	if depth != maxContextFrames {
		t.Fatalf("context depth = %d, want %d", depth, maxContextFrames)
	}
}

func TestContextSeenFrameLimitAndWrongPopFailClosed(t *testing.T) {
	session := newExecutionContextTestSession()
	session.updateForegroundCommand(ForegroundCommandRunning, "ssh")
	for index := 0; index < maxContextSeenFrameIDs; index++ {
		frameID := "f" + strconv.Itoa(index)
		session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=" + frameID + ";application=shell\a"))
		beforeWrongPop := session.ToSessionInfo().ExecutionContext.Revision
		session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=wrong\a"))
		if session.ToSessionInfo().ExecutionContext.Revision != beforeWrongPop {
			t.Fatal("wrong-frame pop changed context")
		}
		session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=pop;frame_id=" + frameID + "\a"))
	}
	revision := session.ToSessionInfo().ExecutionContext.Revision
	session.checkShellIntegrationChange([]byte("\x1b]633;P;FloetermContext=v1;action=push;frame_id=overflow;application=shell\a"))
	if got := session.ToSessionInfo().ExecutionContext.Revision; got != revision {
		t.Fatalf("seen frame limit accepted overflow: %d -> %d", revision, got)
	}
}

func TestContextAndWorkMarkersParseAtEveryByteBoundary(t *testing.T) {
	cases := []struct {
		name     string
		payload  string
		wantKind shellIntegrationSignalKind
	}{
		{name: "context", payload: "633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex", wantKind: shellIntegrationContext},
		{name: "work", payload: "633;P;FloetermWork=v1;frame_id=agent-1;phase=working", wantKind: shellIntegrationWork},
	}
	for _, testCase := range cases {
		for _, terminator := range []string{"\a", "\x1b\\"} {
			sequence := "\x1b]" + testCase.payload + terminator
			for split := 1; split < len(sequence); split++ {
				_, malformed, pending := parseShellIntegrationTokens([]byte(sequence[:split]))
				if len(malformed) != 0 {
					t.Fatalf("%s split %d malformed first chunk: %v", testCase.name, split, malformed)
				}
				tokens, malformed, pending := parseShellIntegrationTokens(append(pending, []byte(sequence[split:])...))
				if len(malformed) != 0 || len(pending) != 0 || len(tokens) != 1 || tokens[0].signal.kind != testCase.wantKind {
					t.Fatalf("case=%s terminator=%q split=%d tokens=%+v malformed=%v pending=%q", testCase.name, terminator, split, tokens, malformed, pending)
				}
			}
		}
	}
}
