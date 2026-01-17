package terminal

import (
	"sync"
	"sync/atomic"
	"time"
)

// RingBufferStats captures summary information about the history buffer.
type RingBufferStats struct {
	TotalChunks     int
	UsedChunks      int
	TotalBytes      int64
	WriteCount      int64
	ReadCount       int64
	MemoryUsage     int64
	OldestTimestamp int64
	NewestTimestamp int64
}

// TerminalRingBuffer stores fixed-size chunks of terminal output in FIFO order.
type TerminalRingBuffer struct {
	chunks []TerminalDataChunk
	head   int
	tail   int
	size   int
	full   bool

	totalBytes   int64
	writeCount   int64
	readCount    int64
	nextSequence int64

	mutex sync.RWMutex
}

// NewTerminalRingBuffer creates a ring buffer with the provided capacity.
func NewTerminalRingBuffer(size int) *TerminalRingBuffer {
	if size <= 0 {
		size = 2048
	}

	return &TerminalRingBuffer{
		chunks:       make([]TerminalDataChunk, size),
		size:         size,
		head:         0,
		tail:         0,
		full:         false,
		nextSequence: 1,
	}
}

// Write appends data to the ring buffer.
func (rb *TerminalRingBuffer) Write(data []byte) error {
	if len(data) == 0 {
		return nil
	}

	dataCopy := make([]byte, len(data))
	copy(dataCopy, data)
	return rb.writeOwned(dataCopy)
}

func (rb *TerminalRingBuffer) writeOwned(data []byte) error {
	if len(data) == 0 {
		return nil
	}

	rb.mutex.Lock()
	defer rb.mutex.Unlock()

	// When the buffer is full, the next write overwrites the oldest chunk at head.
	// Adjust byte accounting before overwriting so TotalBytes stays correct.
	if rb.full {
		oldChunk := rb.chunks[rb.head]
		atomic.AddInt64(&rb.totalBytes, -int64(oldChunk.Size))
		rb.tail = (rb.tail + 1) % rb.size
	}

	chunk := TerminalDataChunk{
		Sequence:  atomic.LoadInt64(&rb.nextSequence),
		Data:      data,
		Timestamp: time.Now().UnixMilli(),
		Size:      len(data),
	}

	rb.chunks[rb.head] = chunk

	atomic.AddInt64(&rb.totalBytes, int64(len(data)))
	atomic.AddInt64(&rb.writeCount, 1)
	atomic.AddInt64(&rb.nextSequence, 1)

	rb.head = (rb.head + 1) % rb.size
	rb.full = rb.head == rb.tail

	return nil
}

// ReadAll returns all data slices in chronological order.
func (rb *TerminalRingBuffer) ReadAll() [][]byte {
	rb.mutex.RLock()
	defer rb.mutex.RUnlock()

	atomic.AddInt64(&rb.readCount, 1)

	if rb.isEmpty() {
		return [][]byte{}
	}

	usedChunks := rb.getUsedChunks()
	result := make([][]byte, 0, usedChunks)

	for i := 0; i < usedChunks; i++ {
		index := (rb.tail + i) % rb.size
		chunk := rb.chunks[index]
		if chunk.Data != nil {
			dataCopy := make([]byte, len(chunk.Data))
			copy(dataCopy, chunk.Data)
			result = append(result, dataCopy)
		}
	}

	return result
}

// ReadAllChunks returns all chunks in chronological order.
func (rb *TerminalRingBuffer) ReadAllChunks() []TerminalDataChunk {
	rb.mutex.RLock()
	defer rb.mutex.RUnlock()

	atomic.AddInt64(&rb.readCount, 1)

	if rb.isEmpty() {
		return []TerminalDataChunk{}
	}

	usedChunks := rb.getUsedChunks()
	result := make([]TerminalDataChunk, 0, usedChunks)

	for i := 0; i < usedChunks; i++ {
		index := (rb.tail + i) % rb.size
		chunk := rb.chunks[index]
		if chunk.Data != nil {
			copyChunk := TerminalDataChunk{
				Sequence:  chunk.Sequence,
				Data:      make([]byte, len(chunk.Data)),
				Timestamp: chunk.Timestamp,
				Size:      chunk.Size,
			}
			copy(copyChunk.Data, chunk.Data)
			result = append(result, copyChunk)
		}
	}

	return result
}

// ReadChunksFrom returns chunks with timestamp >= the provided value.
func (rb *TerminalRingBuffer) ReadChunksFrom(timestamp int64) []TerminalDataChunk {
	rb.mutex.RLock()
	defer rb.mutex.RUnlock()

	atomic.AddInt64(&rb.readCount, 1)

	if rb.isEmpty() {
		return []TerminalDataChunk{}
	}

	usedChunks := rb.getUsedChunks()
	result := make([]TerminalDataChunk, 0)

	for i := 0; i < usedChunks; i++ {
		index := (rb.tail + i) % rb.size
		chunk := rb.chunks[index]
		if chunk.Timestamp >= timestamp && chunk.Data != nil {
			copyChunk := TerminalDataChunk{
				Sequence:  chunk.Sequence,
				Data:      make([]byte, len(chunk.Data)),
				Timestamp: chunk.Timestamp,
				Size:      chunk.Size,
			}
			copy(copyChunk.Data, chunk.Data)
			result = append(result, copyChunk)
		}
	}

	return result
}

// GetStats returns snapshot statistics for the buffer.
func (rb *TerminalRingBuffer) GetStats() RingBufferStats {
	rb.mutex.RLock()
	defer rb.mutex.RUnlock()

	usedChunks := rb.getUsedChunks()
	var oldestTimestamp, newestTimestamp int64

	if usedChunks > 0 {
		oldestTimestamp = rb.chunks[rb.tail].Timestamp
		newestIndex := rb.head - 1
		if newestIndex < 0 {
			newestIndex = rb.size - 1
		}
		newestTimestamp = rb.chunks[newestIndex].Timestamp
	}

	return RingBufferStats{
		TotalChunks:     rb.size,
		UsedChunks:      usedChunks,
		TotalBytes:      atomic.LoadInt64(&rb.totalBytes),
		WriteCount:      atomic.LoadInt64(&rb.writeCount),
		ReadCount:       atomic.LoadInt64(&rb.readCount),
		MemoryUsage:     rb.estimateMemoryUsage(),
		OldestTimestamp: oldestTimestamp,
		NewestTimestamp: newestTimestamp,
	}
}

// Clear resets the ring buffer contents.
func (rb *TerminalRingBuffer) Clear() {
	rb.mutex.Lock()
	defer rb.mutex.Unlock()

	for i := 0; i < rb.size; i++ {
		rb.chunks[i] = TerminalDataChunk{}
	}

	rb.head = 0
	rb.tail = 0
	rb.full = false
	atomic.StoreInt64(&rb.totalBytes, 0)
	atomic.StoreInt64(&rb.nextSequence, 1)
}

func (rb *TerminalRingBuffer) isEmpty() bool {
	return !rb.full && rb.head == rb.tail
}

func (rb *TerminalRingBuffer) getUsedChunks() int {
	if rb.full {
		return rb.size
	}
	if rb.head >= rb.tail {
		return rb.head - rb.tail
	}
	return rb.size - rb.tail + rb.head
}

func (rb *TerminalRingBuffer) estimateMemoryUsage() int64 {
	chunkStructMemory := int64(rb.size) * 32
	dataMemory := atomic.LoadInt64(&rb.totalBytes)
	overhead := int64(rb.size) * 16
	return chunkStructMemory + dataMemory + overhead
}
