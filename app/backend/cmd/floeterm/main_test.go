package main

import (
	"path/filepath"
	"testing"
)

func TestResolveStatePathsUsesExplicitRootWithoutLegacyHistorySpool(t *testing.T) {
	stateRoot := filepath.Join(t.TempDir(), "floeterm-state")
	paths, err := resolveStatePaths(stateRoot)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := filepath.Abs(stateRoot)
	if paths.Root != want {
		t.Fatalf("state root = %q, want %q", paths.Root, want)
	}
}

func TestResolveStatePathsReturnsAbsoluteDefault(t *testing.T) {
	paths, err := resolveStatePaths("")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(paths.Root) {
		t.Fatalf("state root is not absolute: %q", paths.Root)
	}
}
