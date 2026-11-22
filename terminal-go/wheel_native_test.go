//go:build floeterm_native

package terminal

import "testing"

func TestNativeWheelRoutesAndInvalidates(t *testing.T) {
	engine, err := NewNativeSemanticEngine(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	mode := func(output string) uint64 {
		t.Helper()
		if _, err := engine.ApplyOutput([]byte(output)); err != nil {
			t.Fatal(err)
		}
		frame, err := engine.CaptureFrame()
		if err != nil {
			t.Fatal(err)
		}
		return frame.WheelGeneration
	}
	input := SemanticInput{Kind: "wheel", X: 4.5, Y: 2.5, Steps: -2, Modifiers: SemanticModifierAlt}
	check := func(want string) {
		t.Helper()
		got, err := engine.EncodeInput(input)
		if err != nil || string(got) != want {
			t.Fatalf("wheel = %q, %v; want %q", got, err, want)
		}
	}
	if mode("hello") != 0 {
		t.Fatal("ordinary shell captured wheel")
	}
	input.WheelGeneration = mode("\x1b[?1000h\x1b[?1006h")
	check("\x1b[<72;5;3M\x1b[<72;5;3M")
	input.WheelGeneration = mode("\x1b[?1049h")
	input.Steps = 1
	input.Modifiers = 0
	check("\x1b[<65;5;3M")
	input.WheelGeneration = mode("\x1b[?1000l\x1b[?1007h\x1b[?1h")
	check("\x1bOB")
	if mode("\x1b[?1007l") != 0 {
		t.Fatal("disabled alternate scroll captured wheel")
	}
	check("")
	mode("\x1b[?1049l")
	check("")
}
