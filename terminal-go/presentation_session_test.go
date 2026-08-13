package terminal

import "testing"

func TestSessionPresentationPublishesCanonicalGeometryAndClosesWithSession(t *testing.T) {
	session := &Session{config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}), lastAppliedCols: 80, lastAppliedRows: 24, geometryGeneration: 3}
	frame := SemanticFrame{Width: 80, Height: 24, Rows: []SemanticRow{{Cells: []SemanticCell{{Text: "界"}}}}}
	if err := session.PublishPresentation(frame, TerminalState{Title: "shell"}); err != nil {
		t.Fatal(err)
	}
	presentation, ok := session.LatestPresentation()
	if !ok || presentation.Sequence != 1 || presentation.Geometry.Cols != 80 || presentation.Geometry.Rows != 24 || presentation.State.Title != "shell" {
		t.Fatalf("presentation=%+v ok=%v", presentation, ok)
	}
	frame.Rows[0].Cells[0].Text = "mutated"
	got, _ := session.LatestPresentation()
	if got.Frame.Rows[0].Cells[0].Text != "界" {
		t.Fatalf("session retained mutable frame: %+v", got.Frame)
	}
	session.cleanup()
	if err := session.PublishPresentation(SemanticFrame{}, TerminalState{}); err == nil {
		t.Fatal("publish succeeded after cleanup")
	}
}
