//go:build floeterm_native

package terminal

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestNativeHistoryRetentionPreservesScreenAndAppliesLimits(t *testing.T) {
	engine, err := NewNativeSemanticEngine(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPresentationStore(64)
	actor, err := NewSessionActor(engine, 80, 24, store)
	if err != nil {
		t.Fatal(err)
	}
	defer actor.Close()
	if err := actor.PublishInitialPresentation(); err != nil {
		t.Fatal(err)
	}
	original, err := actor.HistoryRetention()
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for n := 0; n < 5000; n++ {
		fmt.Fprintf(&output, "line-%04d\r\n", n)
	}
	before, err := actor.ApplyPTYOutput([]byte(output.String()))
	if err != nil {
		t.Fatal(err)
	}
	lines := uint64(100)
	state, after, err := actor.ConfigureHistoryRetention(HistoryRetentionLimits{MaxLines: &lines})
	if err != nil {
		t.Fatal(err)
	}
	if state.Effective.MaxLines == nil || *state.Effective.MaxLines != 100 {
		t.Fatalf("retention=%+v", state)
	}
	if after.Frame.History.TotalRows >= before.Frame.History.TotalRows {
		t.Fatal("history was not pruned")
	}
	if after.Geometry.Generation != before.Geometry.Generation || after.State.ContentEpoch != before.State.ContentEpoch || after.Sequence <= before.Sequence {
		t.Fatal("retention changed geometry/content or rolled back sequence")
	}
	if !reflect.DeepEqual(after.Frame.Rows, before.Frame.Rows) || after.Frame.Cursor != before.Frame.Cursor {
		t.Fatal("retention changed screen or cursor")
	}
	if after.Frame.History.HistoryEpoch <= before.Frame.History.HistoryEpoch {
		t.Fatal("history readers were not invalidated")
	}
	zero := uint64(0)
	_, cleared, err := actor.ConfigureHistoryRetention(HistoryRetentionLimits{MaxBytes: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Frame.History.TotalRows != 24 {
		t.Fatalf("zero budget left %d rows", cleared.Frame.History.TotalRows)
	}
	restored, _, err := actor.ConfigureHistoryRetention(HistoryRetentionLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if !sameLimit(original.Effective.MaxLines, restored.Effective.MaxLines) || !sameLimit(original.Effective.MaxBytes, restored.Effective.MaxBytes) {
		t.Fatal("restore did not use engine defaults")
	}
	invalid := uint64(9007199254740992)
	latest, _ := store.Latest()
	if _, _, err := actor.ConfigureHistoryRetention(HistoryRetentionLimits{MaxLines: &invalid}); err == nil {
		t.Fatal("accepted unsafe value")
	}
	unchanged, _ := store.Latest()
	if unchanged.Sequence != latest.Sequence {
		t.Fatal("invalid configuration mutated terminal")
	}
	if _, err := actor.ApplyPTYOutput([]byte("still-alive")); err != nil {
		t.Fatal(err)
	}
}
func sameLimit(a, b *uint64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func TestManagerRetentionDefaultsOnlyAffectNewSessions(t *testing.T) {
	m := NewManager(ManagerConfig{})
	defer m.Cleanup()
	first, err := m.CreateSession("first", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	before, err := first.HistoryRetention()
	if err != nil {
		t.Fatal(err)
	}
	lines := uint64(500)
	if err := m.SetHistoryRetentionDefaults(HistoryRetentionLimits{MaxLines: &lines}); err != nil {
		t.Fatal(err)
	}
	lines = 900 // The manager must own a copy.
	second, err := m.CreateSession("second", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	newer, err := second.HistoryRetention()
	if err != nil {
		t.Fatal(err)
	}
	older, err := first.HistoryRetention()
	if err != nil {
		t.Fatal(err)
	}
	if newer.Effective.MaxLines == nil || *newer.Effective.MaxLines != 500 {
		t.Fatal("new session did not inherit saved default")
	}
	if !sameLimit(before.Effective.MaxLines, older.Effective.MaxLines) {
		t.Fatal("existing session changed")
	}
	if _, err := first.ConfigureHistoryRetention("missing", "person", 1, HistoryRetentionLimits{}); err == nil {
		t.Fatal("unattached mutation accepted")
	}
}

func TestNativeRetentionSurvivesResetAlternateScreenAndConcurrentOutput(t *testing.T) {
	engine, err := NewNativeSemanticEngine(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	actor, err := NewSessionActor(engine, 80, 24, NewPresentationStore(64))
	if err != nil {
		t.Fatal(err)
	}
	defer actor.Close()
	if err := actor.PublishInitialPresentation(); err != nil {
		t.Fatal(err)
	}
	lines := uint64(100)
	if _, _, err := actor.ConfigureHistoryRetention(HistoryRetentionLimits{MaxLines: &lines}); err != nil {
		t.Fatal(err)
	}
	if _, err := actor.Clear(); err != nil {
		t.Fatal(err)
	}
	state, err := actor.HistoryRetention()
	if err != nil || !sameLimit(state.Effective.MaxLines, &lines) {
		t.Fatalf("reset lost retention: %+v %v", state, err)
	}
	if _, err := actor.ApplyPTYOutput([]byte("\x1b[?1049hALT")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := actor.ConfigureHistoryRetention(HistoryRetentionLimits{MaxLines: &lines}); err != nil {
		t.Fatal(err)
	}
	if _, err := actor.ApplyPTYOutput([]byte("\x1b[?1049l")); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for n := 0; n < 2; n++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for i := 0; i < 40; i++ {
				if n == 0 {
					if _, err := actor.ApplyPTYOutput([]byte("output\r\n")); err != nil {
						t.Error(err)
					}
				} else {
					if _, _, err := actor.ConfigureHistoryRetention(HistoryRetentionLimits{MaxLines: &lines}); err != nil {
						t.Error(err)
					}
				}
			}
		}(n)
	}
	wg.Wait()
}

func TestSessionRetentionFencesAttachmentAndPrincipalWithoutAcquiringControl(t *testing.T) {
	engine, err := NewNativeSemanticEngine(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	actor, err := NewSessionActor(engine, 80, 24, NewPresentationStore(4))
	if err != nil {
		t.Fatal(err)
	}
	defer actor.Close()
	if err := actor.PublishInitialPresentation(); err != nil {
		t.Fatal(err)
	}
	session := &Session{semanticActor: actor, semanticAttachments: map[string]SemanticAttachment{
		"owner": {PrincipalID: "person", TransportGeneration: 1}, "observer": {PrincipalID: "person", TransportGeneration: 2}, "other": {PrincipalID: "other", TransportGeneration: 3}},
		controllerState: ControllerState{AttachmentID: "owner", PrincipalID: "person", TransportGeneration: 1, Epoch: 4},
		liveAttachments: map[string]liveAttachment{}, latestPresentationSequence: 1}
	lines := uint64(100)
	limits := HistoryRetentionLimits{MaxLines: &lines}
	if _, err := session.ConfigureHistoryRetention("owner", "person", 2, limits); !errors.Is(err, ErrControllerTransport) {
		t.Fatalf("stale=%v", err)
	}
	if _, err := session.ConfigureHistoryRetention("other", "other", 3, limits); !errors.Is(err, ErrControllerPrincipal) {
		t.Fatalf("principal=%v", err)
	}
	if _, err := session.ConfigureHistoryRetention("observer", "person", 2, limits); err != nil {
		t.Fatal(err)
	}
	if session.Controller().AttachmentID != "owner" || session.Controller().Epoch != 4 {
		t.Fatal("configuration acquired control")
	}
}
