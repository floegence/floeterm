package terminal

import (
    "crypto/rand"
    "encoding/hex"
)

// generateSessionID creates a short random identifier for a session.
func generateSessionID() string {
    buf := make([]byte, 16)
    if _, err := rand.Read(buf); err != nil {
        return "session-unknown"
    }
    return "session-" + hex.EncodeToString(buf)
}
