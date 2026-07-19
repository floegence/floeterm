package server

const maxJSONBodyBytesDefault = int64(1 << 20) // 1 MiB

const (
	defaultHistoryPageBytes = int64(512 * 1024)
	maxHistoryPageBytes     = int64(1 << 20)
	maxHistoryPageChunks    = 256
)
