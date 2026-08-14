package terminal

import (
	"reflect"
	"testing"
)

func TestSemanticDeliveryNeverRegressesAfterNewerActorCut(t *testing.T) {
	var delivered []uint64
	session := &Session{
		connections: map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		liveAttachments: map[string]liveAttachment{"view": {
			generation: 1,
			subscriber: LiveSubscriber{OnPresentation: func(p SemanticPresentation) bool {
				delivered = append(delivered, p.Sequence)
				return true
			}},
		}},
	}
	session.broadcastPresentation(SemanticPresentation{Sequence: 3}, nil)
	session.broadcastPresentation(SemanticPresentation{Sequence: 2}, nil)
	session.broadcastPresentation(SemanticPresentation{Sequence: 4}, nil)
	if !reflect.DeepEqual(delivered, []uint64{3, 4}) {
		t.Fatalf("delivered sequences=%v, want [3 4]", delivered)
	}
}

func TestSemanticAttachReturnsOneAtomicPresentationCut(t *testing.T) {
	store := NewPresentationStore(1)
	want := SemanticPresentation{
		Sequence: 7,
		Geometry: TerminalGeometry{Generation: 3, PresentationSequence: 7, Cols: 100, Rows: 30},
		State:    TerminalState{Sequence: 7},
		Frame:    SemanticFrame{Width: 100, Height: 30},
	}
	if err := store.Publish(want); err != nil {
		t.Fatal(err)
	}
	session := &Session{
		presentationStore:          store,
		latestPresentationSequence: 7,
		geometryGeneration:         3,
		lastAppliedCols:            100,
		lastAppliedRows:            30,
		connections:                make(map[string]*ConnectionInfo),
		liveAttachments:            make(map[string]liveAttachment),
	}
	attachment, err := session.AttachSemanticLiveConnection("view", 1, 80, 24, LiveSubscriber{})
	if err != nil {
		t.Fatal(err)
	}
	defer attachment.Detach()
	if attachment.Presentation.Sequence != 7 || attachment.Geometry != want.Geometry {
		t.Fatalf("attachment=%+v, want actor cut %+v", attachment, want)
	}
	if attachment.Geometry.PresentationSequence != attachment.Presentation.Sequence {
		t.Fatalf("geometry/presentation mismatch: %+v", attachment)
	}
}
