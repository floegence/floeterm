//go:build floeterm_native && floeterm_test_fault && (darwin || linux)

package nativevt

import (
	"bytes"
	"os"
	"os/exec"
	"testing"
)

func TestNativeFatalFaultIsContainedToDisposableSubprocess(t *testing.T) {
	if os.Getenv("FLOETERM_NATIVE_FATAL_CHILD") == "1" {
		triggerNativeFatalForTest()
		os.Exit(99)
	}

	command := exec.Command(os.Args[0], "-test.run=^TestNativeFatalFaultIsContainedToDisposableSubprocess$")
	command.Env = append(os.Environ(), "FLOETERM_NATIVE_FATAL_CHILD=1")
	output, err := command.CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("native fatal child error = %v, want process termination", err)
	}
	if exitError.ExitCode() == 0 || (!bytes.Contains(output, []byte("SIGABRT")) && !bytes.Contains(output, []byte("abort"))) {
		t.Fatalf("native fatal child status = %v output=%q, want an aborting fault", exitError.ProcessState, output)
	}

	engine, err := New(2, 1)
	if err != nil {
		t.Fatalf("parent process cannot create native engine after child fault: %v", err)
	}
	engine.Close()
}
