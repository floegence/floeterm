package main

import (
	"path/filepath"
	"testing"
)

func TestResolveStatePathsKeepsHistorySpoolUnderExplicitStateRoot(t *testing.T) {
	stateRoot := filepath.Join(t.TempDir(), "standalone-state")
	paths, err := resolveStatePaths(stateRoot)
	if err != nil {
		t.Fatal(err)
	}
	if paths.Root != stateRoot {
		t.Fatalf("state root = %q, want %q", paths.Root, stateRoot)
	}
	if paths.HistorySpoolRoot != filepath.Join(stateRoot, "history-spool") {
		t.Fatalf("history spool root = %q", paths.HistorySpoolRoot)
	}
}

func TestResolveStatePathsEnablesDurableHistoryByDefault(t *testing.T) {
	paths, err := resolveStatePaths("")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(paths.Root) || paths.HistorySpoolRoot == "" {
		t.Fatalf("default state paths are not durable: %+v", paths)
	}
}
