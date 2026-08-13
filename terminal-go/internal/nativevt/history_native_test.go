//go:build floeterm_native

package nativevt

import (
	"fmt"
	"strings"
	"testing"
)

func historyRowText(row Row) string {
	var value strings.Builder
	for _, cell := range row.Cells {
		value.WriteString(cell.Text)
	}
	return strings.TrimRight(value.String(), " ")
}

func TestReadonlyHistoryUsesIndependentTrackedAnchorsWithoutMovingViewport(t *testing.T) {
	engine, err := New(10, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	if _, err := engine.Apply([]byte("alpha\r\nbravo\r\ncharlie")); err != nil {
		t.Fatal(err)
	}
	alpha, err := engine.TrackHistoryCell(0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer alpha.Close()
	bravo, err := engine.TrackHistoryCell(0, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer bravo.Close()
	before, err := engine.ViewportActive()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Apply([]byte("\r\necho\r\nfoxtrot")); err != nil {
		t.Fatal(err)
	}
	alphaPage, alphaStatus, err := engine.ReadHistory(alpha, 2)
	if err != nil || alphaStatus != AnchorValid {
		t.Fatalf("alpha history status=%v error=%v", alphaStatus, err)
	}
	bravoPage, bravoStatus, err := engine.ReadHistory(bravo, 2)
	if err != nil || bravoStatus != AnchorValid {
		t.Fatalf("bravo history status=%v error=%v", bravoStatus, err)
	}
	after, err := engine.ViewportActive()
	if err != nil {
		t.Fatal(err)
	}
	if got := historyRowText(alphaPage.Rows[0]); got != "alpha" {
		t.Fatalf("alpha row=%q", got)
	}
	if got := historyRowText(bravoPage.Rows[0]); got != "bravo" {
		t.Fatalf("bravo row=%q", got)
	}
	if before != after {
		t.Fatalf("readonly query moved shared viewport: before=%v after=%v", before, after)
	}
}

func TestHistoryAnchorSurvivesReflowOrBecomesStructurallyInvalid(t *testing.T) {
	engine, err := New(8, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	if _, err := engine.Apply([]byte("abcdefgh\r\nijklmnop\r\nqrstuvwx")); err != nil {
		t.Fatal(err)
	}
	anchor, err := engine.TrackHistoryCell(3, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer anchor.Close()
	if err := engine.Resize(4, 3); err != nil {
		t.Fatal(err)
	}
	page, status, err := engine.ReadHistory(anchor, 1)
	if err != nil || status != AnchorValid || len(page.Rows) != 1 || historyRowText(page.Rows[0]) == "" {
		t.Fatalf("reflowed anchor status=%v page=%+v error=%v", status, page, err)
	}
	if err := engine.Reset(); err != nil {
		t.Fatal(err)
	}
	_, status, err = engine.ReadHistory(anchor, 1)
	if err != nil || status != AnchorInvalid {
		t.Fatalf("reset anchor status=%v error=%v, want structured invalid", status, err)
	}
}

func TestReadonlyHistoryPreservesSemanticUnicodeAndHyperlink(t *testing.T) {
	engine, err := New(12, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	input := "\x1b[1;38;2;1;2;3m\x1b]8;;https://history.test\x1b\\界e\u0301\x1b]8;;\x1b\\\x1b[0m\r\nnext\r\nlast"
	if _, err := engine.Apply([]byte(input)); err != nil {
		t.Fatal(err)
	}
	anchor, err := engine.TrackHistoryCell(0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer anchor.Close()
	if _, err := engine.Apply([]byte("\r\nscroll")); err != nil {
		t.Fatal(err)
	}
	page, status, err := engine.ReadHistory(anchor, 1)
	if err != nil || status != AnchorValid {
		t.Fatalf("history status=%v error=%v", status, err)
	}
	first := page.Rows[0].Cells[0]
	if first.Text != "界" || first.Width != 1 || !first.Bold || first.Hyperlink != "https://history.test" {
		t.Fatalf("first history cell=%+v", first)
	}
	if first.Foreground != (Color{Kind: 2, R: 1, G: 2, B: 3}) {
		t.Fatalf("history foreground=%+v", first.Foreground)
	}
	if got := page.Rows[0].Cells[2].Text; got != "e\u0301" {
		t.Fatalf("combining history cell=%q", got)
	}
}

func TestNativeHistoryTotalRowsGrowsWithOutput(t *testing.T) {
	engine, err := New(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	initial, err := engine.HistoryTotalRows()
	if err != nil {
		t.Fatal(err)
	}
	if initial != 24 {
		t.Fatalf("initial total rows=%d, want viewport rows 24", initial)
	}
	var output strings.Builder
	for i := 0; i < 320; i++ {
		fmt.Fprintf(&output, "SCROLLBAR_PHYSICAL_%04d\r\n", i)
	}
	if _, err := engine.Apply([]byte(output.String())); err != nil {
		t.Fatal(err)
	}
	total, err := engine.HistoryTotalRows()
	if err != nil {
		t.Fatal(err)
	}
	if total <= initial {
		t.Fatalf("total rows=%d after 320 lines, want > %d", total, initial)
	}
}
