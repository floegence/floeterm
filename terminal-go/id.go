package terminal

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// generateSessionID creates a short random identifier for a session.
func generateSessionID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "session-unknown"
	}
	return "session-" + hex.EncodeToString(buf)
}

func generateShellLifecycleNonce() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate shell lifecycle nonce: %w", err)
	}
	return hex.EncodeToString(buf), nil
}
