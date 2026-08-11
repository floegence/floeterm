package server

const maxJSONBodyBytesDefault = int64(1 << 20) // 1 MiB
const maxCheckpointBytes = 16 * 1024 * 1024
const maxCheckpointJSONBodyBytes = int64(23 * 1024 * 1024)

const (
	defaultHistoryPageBytes = int64(512 * 1024)
	maxHistoryPageBytes     = int64(1 << 20)
	maxHistoryPageChunks    = 256
)
