package server

import (
	"net"
	"net/http"
	"strings"
)

const (
	maxJSONBodyBytesDefault = int64(1 << 20) // 1 MiB
	maxInputBytes           = 64 * 1024      // 64 KiB

	minCols = 20
	minRows = 5
	maxCols = 500
	maxRows = 200
)

func clientKey(r *http.Request, sessionID, connID string) string {
	if strings.TrimSpace(sessionID) == "" {
		return ""
	}
	if strings.TrimSpace(connID) != "" {
		return sessionID + ":" + strings.TrimSpace(connID)
	}
	return sessionID + ":" + remoteIP(r)
}

func remoteIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func validateDims(cols, rows int) bool {
	if cols < minCols || cols > maxCols {
		return false
	}
	if rows < minRows || rows > maxRows {
		return false
	}
	return true
}

