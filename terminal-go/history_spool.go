package terminal

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const (
	historySpoolFormatVersion = 1
	historySegmentMagic       = "FTRAW01\n"
	historyRecordHeaderBytes  = 68
	defaultSegmentMaxBytes    = 4 * 1024 * 1024
	defaultHistoryMaxBytes    = 256 * 1024 * 1024
)

// TerminalHistorySpoolOptions configures a session-owned durable raw history journal.
type TerminalHistorySpoolOptions struct {
	Directory       string
	SegmentMaxBytes int64
	MaxBytes        int64
}

// TerminalHistoryCheckpoint is an opaque, same-engine checkpoint verified by
// the checkpoint actor before it is submitted to the durable history store.
type TerminalHistoryCheckpoint struct {
	FormatVersion          uint32 `json:"format_version"`
	EngineID               string `json:"engine_id"`
	CoveredThroughSequence int64  `json:"covered_through_sequence"`
	GeometryGeneration     uint64 `json:"geometry_generation"`
	ParserEpoch            uint64 `json:"parser_epoch"`
	Cols                   int    `json:"cols"`
	Rows                   int    `json:"rows"`
	ChecksumSHA256         string `json:"checksum_sha256"`
	StateDigestSHA256      string `json:"state_digest_sha256"`
	Bytes                  []byte `json:"-"`
}

// TerminalHistorySpoolSnapshot exposes non-sensitive durability diagnostics.
type TerminalHistorySpoolSnapshot struct {
	FirstSequence   int64
	LastSequence    int64
	RetentionFloor  int64
	SegmentCount    int
	RawBytes        int64
	CheckpointBytes int64
}

type historySpoolManifest struct {
	Version        int                       `json:"version"`
	Checkpoint     TerminalHistoryCheckpoint `json:"checkpoint"`
	CheckpointFile string                    `json:"checkpoint_file"`
}

type historySpoolRecord struct {
	chunk      TerminalDataChunk
	path       string
	dataOffset int64
	checksum   [sha256.Size]byte
}

type historySpoolSegment struct {
	path          string
	firstSequence int64
	lastSequence  int64
	bytes         int64
}

// TerminalHistorySpool keeps raw output durable until a validated checkpoint
// atomically covers it. It is safe for concurrent callers.
type TerminalHistorySpool struct {
	mu sync.Mutex

	directory       string
	segmentMaxBytes int64
	maxBytes        int64
	records         []historySpoolRecord
	segments        []historySpoolSegment
	retentionFloor  int64
	lastSequence    int64
	rawBytes        int64
	checkpoint      *TerminalHistoryCheckpoint
	checkpointFile  string
	activeFile      *os.File
	activePath      string
	activeBytes     int64
	closed          bool
}

// OpenTerminalHistorySpool opens or creates a durable raw history journal.
func OpenTerminalHistorySpool(options TerminalHistorySpoolOptions) (*TerminalHistorySpool, error) {
	if strings.TrimSpace(options.Directory) == "" {
		return nil, fmt.Errorf("terminal history spool directory is required")
	}
	if options.SegmentMaxBytes <= 0 {
		options.SegmentMaxBytes = defaultSegmentMaxBytes
	}
	if options.MaxBytes <= 0 {
		options.MaxBytes = defaultHistoryMaxBytes
	}
	if options.MaxBytes < options.SegmentMaxBytes {
		return nil, fmt.Errorf("terminal history spool max bytes must be at least the segment max bytes")
	}
	if err := os.MkdirAll(options.Directory, 0o700); err != nil {
		return nil, fmt.Errorf("create terminal history spool: %w", err)
	}
	spool := &TerminalHistorySpool{
		directory:       options.Directory,
		segmentMaxBytes: options.SegmentMaxBytes,
		maxBytes:        options.MaxBytes,
	}
	if err := spool.loadCheckpoint(); err != nil {
		return nil, err
	}
	if err := spool.loadSegments(); err != nil {
		return nil, err
	}
	return spool, nil
}

// Append durably appends one contiguous output record.
func (s *TerminalHistorySpool) Append(chunk TerminalDataChunk) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("terminal history spool is closed")
	}
	if err := validateHistorySpoolChunk(chunk); err != nil {
		return err
	}
	expected := s.lastSequence + 1
	if expected <= s.retentionFloor {
		expected = s.retentionFloor + 1
	}
	if chunk.Sequence != expected {
		return fmt.Errorf("terminal history spool sequence gap: got %d, want %d", chunk.Sequence, expected)
	}
	recordBytes := int64(historyRecordHeaderBytes + 4 + len(chunk.Data))
	if s.rawBytes+recordBytes > s.maxBytes {
		return fmt.Errorf("terminal history spool quota exceeded: raw=%d append=%d max=%d", s.rawBytes, recordBytes, s.maxBytes)
	}
	if err := s.ensureActiveSegment(recordBytes, chunk.Sequence); err != nil {
		return err
	}

	checksum := sha256.Sum256(chunk.Data)
	encoded := make([]byte, historyRecordHeaderBytes+4+len(chunk.Data))
	copy(encoded[0:4], "REC1")
	binary.LittleEndian.PutUint32(encoded[4:8], uint32(len(chunk.Data)))
	binary.LittleEndian.PutUint64(encoded[8:16], uint64(chunk.Sequence))
	binary.LittleEndian.PutUint64(encoded[16:24], uint64(chunk.Timestamp))
	binary.LittleEndian.PutUint64(encoded[24:32], chunk.GeometryGeneration)
	binary.LittleEndian.PutUint32(encoded[32:36], uint32(chunk.Cols))
	binary.LittleEndian.PutUint32(encoded[36:40], uint32(chunk.Rows))
	copy(encoded[40:68], checksum[:28])
	// The remaining checksum bytes precede the payload so the fixed record
	// header can retain the output geometry without truncating the digest.
	copy(encoded[68:72], checksum[28:])
	copy(encoded[72:], chunk.Data)

	offset := s.activeBytes + historyRecordHeaderBytes + 4
	if err := writeAll(s.activeFile, encoded); err != nil {
		return fmt.Errorf("append terminal history segment: %w", err)
	}
	if err := s.activeFile.Sync(); err != nil {
		return fmt.Errorf("sync terminal history segment: %w", err)
	}
	writtenBytes := int64(len(encoded))
	s.activeBytes += writtenBytes
	s.rawBytes += writtenBytes
	s.lastSequence = chunk.Sequence
	owned := cloneTerminalDataChunk(chunk)
	owned.Data = nil
	s.records = append(s.records, historySpoolRecord{
		chunk:      owned,
		path:       s.activePath,
		dataOffset: offset,
		checksum:   checksum,
	})
	segment := &s.segments[len(s.segments)-1]
	segment.lastSequence = chunk.Sequence
	segment.bytes = s.activeBytes
	return nil
}

// ReadChunks reads an inclusive, contiguous sequence range from durable storage.
func (s *TerminalHistorySpool) ReadChunks(startSequence, endSequence int64) ([]TerminalDataChunk, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if startSequence <= s.retentionFloor {
		return nil, fmt.Errorf("terminal history starts after committed checkpoint %d", s.retentionFloor)
	}
	if endSequence > 0 && endSequence < startSequence {
		return nil, fmt.Errorf("terminal history end sequence precedes start sequence")
	}
	result := make([]TerminalDataChunk, 0)
	expected := startSequence
	for _, record := range s.records {
		if record.chunk.Sequence < startSequence {
			continue
		}
		if endSequence > 0 && record.chunk.Sequence > endSequence {
			break
		}
		if record.chunk.Sequence != expected {
			return nil, fmt.Errorf("terminal history spool sequence gap: got %d, want %d", record.chunk.Sequence, expected)
		}
		data, err := readHistorySpoolRecordData(record)
		if err != nil {
			return nil, err
		}
		chunk := cloneTerminalDataChunk(record.chunk)
		chunk.Data = data
		chunk.Size = len(data)
		result = append(result, chunk)
		expected++
	}
	if endSequence > 0 && expected <= endSequence {
		return nil, fmt.Errorf("terminal history spool coverage incomplete: covered through %d, want %d", expected-1, endSequence)
	}
	return result, nil
}

// CommitCheckpoint atomically publishes an opaque validated checkpoint before
// pruning fully covered raw segments.
func (s *TerminalHistorySpool) CommitCheckpoint(checkpoint TerminalHistoryCheckpoint) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("terminal history spool is closed")
	}
	if err := s.validateCheckpoint(checkpoint); err != nil {
		return err
	}
	if err := s.closeActiveFile(); err != nil {
		return err
	}

	checkpointName := fmt.Sprintf("checkpoint-%020d-%s.bin", checkpoint.CoveredThroughSequence, checkpoint.ChecksumSHA256[:16])
	checkpointPath := filepath.Join(s.directory, checkpointName)
	if err := atomicWriteFile(checkpointPath, checkpoint.Bytes, 0o600); err != nil {
		return fmt.Errorf("write terminal history checkpoint: %w", err)
	}
	manifest := historySpoolManifest{
		Version:        historySpoolFormatVersion,
		Checkpoint:     checkpoint,
		CheckpointFile: checkpointName,
	}
	manifest.Checkpoint.Bytes = nil
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return fmt.Errorf("encode terminal history checkpoint manifest: %w", err)
	}
	if err := atomicWriteFile(filepath.Join(s.directory, "manifest.json"), manifestBytes, 0o600); err != nil {
		return fmt.Errorf("commit terminal history checkpoint manifest: %w", err)
	}

	previousCheckpointFile := s.checkpointFile
	owned := cloneTerminalHistoryCheckpoint(checkpoint)
	s.checkpoint = &owned
	s.checkpointFile = checkpointName
	s.retentionFloor = checkpoint.CoveredThroughSequence
	s.pruneCoveredSegmentsLocked()
	if previousCheckpointFile != "" && previousCheckpointFile != checkpointName {
		_ = os.Remove(filepath.Join(s.directory, previousCheckpointFile))
	}
	return nil
}

// Checkpoint returns a copy of the latest committed checkpoint.
func (s *TerminalHistorySpool) Checkpoint() (*TerminalHistoryCheckpoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.checkpoint == nil {
		return nil, nil
	}
	copy := cloneTerminalHistoryCheckpoint(*s.checkpoint)
	return &copy, nil
}

// Reset clears the current checkpoint and all raw segments while preserving
// the configured directory and the global output sequence boundary.
func (s *TerminalHistorySpool) Reset(coveredThroughSequence int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("terminal history spool is closed")
	}
	if coveredThroughSequence < 0 {
		return fmt.Errorf("terminal history reset sequence must be non-negative")
	}
	if err := s.closeActiveFile(); err != nil {
		return err
	}
	paths, err := filepath.Glob(filepath.Join(s.directory, "segment-*.ftraw"))
	if err != nil {
		return fmt.Errorf("list terminal history segments: %w", err)
	}
	if s.checkpointFile != "" {
		paths = append(paths, filepath.Join(s.directory, s.checkpointFile))
	}
	paths = append(paths, filepath.Join(s.directory, "manifest.json"))
	for _, path := range paths {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("reset terminal history spool: %w", err)
		}
	}
	s.records = nil
	s.segments = nil
	s.retentionFloor = coveredThroughSequence
	s.lastSequence = coveredThroughSequence
	s.rawBytes = 0
	s.checkpoint = nil
	s.checkpointFile = ""
	return nil
}

// Snapshot returns non-sensitive durability diagnostics.
func (s *TerminalHistorySpool) Snapshot() TerminalHistorySpoolSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	firstSequence := int64(0)
	if len(s.records) > 0 {
		firstSequence = s.records[0].chunk.Sequence
	}
	checkpointBytes := int64(0)
	if s.checkpoint != nil {
		checkpointBytes = int64(len(s.checkpoint.Bytes))
	}
	return TerminalHistorySpoolSnapshot{
		FirstSequence:   firstSequence,
		LastSequence:    s.lastSequence,
		RetentionFloor:  s.retentionFloor,
		SegmentCount:    len(s.segments),
		RawBytes:        s.rawBytes,
		CheckpointBytes: checkpointBytes,
	}
}

// Close flushes and closes the current segment.
func (s *TerminalHistorySpool) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return s.closeActiveFile()
}

func (s *TerminalHistorySpool) ensureActiveSegment(recordBytes int64, sequence int64) error {
	if s.activeFile != nil && s.activeBytes > int64(len(historySegmentMagic)) && s.activeBytes+recordBytes > s.segmentMaxBytes {
		if err := s.closeActiveFile(); err != nil {
			return err
		}
	}
	if s.activeFile != nil {
		return nil
	}
	path := filepath.Join(s.directory, fmt.Sprintf("segment-%020d.ftraw", sequence))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create terminal history segment: %w", err)
	}
	if err := writeAll(file, []byte(historySegmentMagic)); err != nil {
		_ = file.Close()
		return fmt.Errorf("initialize terminal history segment: %w", err)
	}
	s.activeFile = file
	s.activePath = path
	s.activeBytes = int64(len(historySegmentMagic))
	s.rawBytes += int64(len(historySegmentMagic))
	s.segments = append(s.segments, historySpoolSegment{
		path:          path,
		firstSequence: sequence,
		lastSequence:  sequence - 1,
		bytes:         s.activeBytes,
	})
	return nil
}

func (s *TerminalHistorySpool) closeActiveFile() error {
	if s.activeFile == nil {
		return nil
	}
	if err := s.activeFile.Sync(); err != nil {
		return fmt.Errorf("sync terminal history segment: %w", err)
	}
	if err := s.activeFile.Close(); err != nil {
		return fmt.Errorf("close terminal history segment: %w", err)
	}
	s.activeFile = nil
	s.activePath = ""
	s.activeBytes = 0
	return nil
}

func (s *TerminalHistorySpool) validateCheckpoint(checkpoint TerminalHistoryCheckpoint) error {
	if checkpoint.FormatVersion != 1 || checkpoint.EngineID != "floegence-ghostty-web" {
		return fmt.Errorf("unsupported terminal history checkpoint contract")
	}
	if checkpoint.CoveredThroughSequence <= s.retentionFloor || checkpoint.CoveredThroughSequence > s.lastSequence {
		return fmt.Errorf("terminal history checkpoint sequence is outside durable coverage")
	}
	if checkpoint.GeometryGeneration == 0 || checkpoint.ParserEpoch == 0 || checkpoint.Cols <= 0 || checkpoint.Rows <= 0 {
		return fmt.Errorf("terminal history checkpoint geometry is invalid")
	}
	if len(checkpoint.Bytes) == 0 {
		return fmt.Errorf("terminal history checkpoint bytes are empty")
	}
	checksum, err := decodeSHA256(checkpoint.ChecksumSHA256)
	if err != nil {
		return fmt.Errorf("terminal history checkpoint checksum is invalid: %w", err)
	}
	actual := sha256.Sum256(checkpoint.Bytes)
	if actual != checksum {
		return fmt.Errorf("terminal history checkpoint checksum mismatch")
	}
	if _, err := decodeSHA256(checkpoint.StateDigestSHA256); err != nil {
		return fmt.Errorf("terminal history checkpoint state digest is invalid: %w", err)
	}
	for _, record := range s.records {
		if record.chunk.Sequence != checkpoint.CoveredThroughSequence {
			continue
		}
		if record.chunk.GeometryGeneration != checkpoint.GeometryGeneration || record.chunk.Cols != checkpoint.Cols || record.chunk.Rows != checkpoint.Rows {
			return fmt.Errorf("terminal history checkpoint geometry does not match covered output")
		}
		return nil
	}
	return fmt.Errorf("terminal history checkpoint sequence is not present in durable raw coverage")
}

func (s *TerminalHistorySpool) pruneCoveredSegmentsLocked() {
	keptRecords := s.records[:0]
	for _, record := range s.records {
		if record.chunk.Sequence > s.retentionFloor {
			keptRecords = append(keptRecords, record)
		}
	}
	s.records = keptRecords
	keptSegments := s.segments[:0]
	for _, segment := range s.segments {
		if segment.lastSequence <= s.retentionFloor {
			if err := os.Remove(segment.path); err == nil || errors.Is(err, os.ErrNotExist) {
				s.rawBytes -= segment.bytes
				continue
			}
		}
		keptSegments = append(keptSegments, segment)
	}
	s.segments = keptSegments
}

func (s *TerminalHistorySpool) loadCheckpoint() error {
	manifestPath := filepath.Join(s.directory, "manifest.json")
	manifestBytes, err := os.ReadFile(manifestPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read terminal history checkpoint manifest: %w", err)
	}
	var manifest historySpoolManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return fmt.Errorf("decode terminal history checkpoint manifest: %w", err)
	}
	if manifest.Version != historySpoolFormatVersion || filepath.Base(manifest.CheckpointFile) != manifest.CheckpointFile {
		return fmt.Errorf("terminal history checkpoint manifest is incompatible")
	}
	checkpointBytes, err := os.ReadFile(filepath.Join(s.directory, manifest.CheckpointFile))
	if err != nil {
		return fmt.Errorf("read terminal history checkpoint: %w", err)
	}
	manifest.Checkpoint.Bytes = checkpointBytes
	if manifest.Checkpoint.FormatVersion != 1 || manifest.Checkpoint.EngineID != "floegence-ghostty-web" ||
		manifest.Checkpoint.CoveredThroughSequence <= 0 || manifest.Checkpoint.GeometryGeneration == 0 || manifest.Checkpoint.ParserEpoch == 0 ||
		manifest.Checkpoint.Cols <= 0 || manifest.Checkpoint.Rows <= 0 {
		return fmt.Errorf("terminal history checkpoint manifest is incompatible")
	}
	checksum, err := decodeSHA256(manifest.Checkpoint.ChecksumSHA256)
	if err != nil || sha256.Sum256(checkpointBytes) != checksum {
		return fmt.Errorf("terminal history checkpoint checksum mismatch")
	}
	if _, err := decodeSHA256(manifest.Checkpoint.StateDigestSHA256); err != nil {
		return fmt.Errorf("terminal history checkpoint state digest is invalid")
	}
	checkpoint := cloneTerminalHistoryCheckpoint(manifest.Checkpoint)
	s.checkpoint = &checkpoint
	s.checkpointFile = manifest.CheckpointFile
	s.retentionFloor = checkpoint.CoveredThroughSequence
	s.lastSequence = checkpoint.CoveredThroughSequence
	return nil
}

func (s *TerminalHistorySpool) loadSegments() error {
	paths, err := filepath.Glob(filepath.Join(s.directory, "segment-*.ftraw"))
	if err != nil {
		return fmt.Errorf("list terminal history segments: %w", err)
	}
	sort.Strings(paths)
	for _, path := range paths {
		segment, records, err := readHistorySpoolSegment(path)
		if err != nil {
			return err
		}
		for _, record := range records {
			if record.chunk.Sequence <= s.retentionFloor {
				continue
			}
			if record.chunk.Sequence != s.lastSequence+1 {
				return fmt.Errorf("terminal history spool sequence gap: got %d, want %d", record.chunk.Sequence, s.lastSequence+1)
			}
			s.records = append(s.records, record)
			s.lastSequence = record.chunk.Sequence
		}
		s.segments = append(s.segments, segment)
		s.rawBytes += segment.bytes
	}
	if s.rawBytes > s.maxBytes {
		return fmt.Errorf("terminal history spool exceeds configured quota")
	}
	return nil
}

func readHistorySpoolSegment(path string) (historySpoolSegment, []historySpoolRecord, error) {
	file, err := os.Open(path)
	if err != nil {
		return historySpoolSegment{}, nil, fmt.Errorf("open terminal history segment: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return historySpoolSegment{}, nil, fmt.Errorf("stat terminal history segment: %w", err)
	}
	magic := make([]byte, len(historySegmentMagic))
	if _, err := io.ReadFull(file, magic); err != nil || string(magic) != historySegmentMagic {
		return historySpoolSegment{}, nil, fmt.Errorf("terminal history segment format is invalid")
	}
	segment := historySpoolSegment{path: path, bytes: info.Size()}
	records := make([]historySpoolRecord, 0)
	offset := int64(len(historySegmentMagic))
	for offset < info.Size() {
		header := make([]byte, historyRecordHeaderBytes)
		if _, err := io.ReadFull(file, header); err != nil {
			return historySpoolSegment{}, nil, fmt.Errorf("terminal history segment record is truncated")
		}
		if string(header[0:4]) != "REC1" {
			return historySpoolSegment{}, nil, fmt.Errorf("terminal history segment record format is invalid")
		}
		dataLength := int(binary.LittleEndian.Uint32(header[4:8]))
		if dataLength <= 0 || int64(dataLength) > info.Size()-offset-historyRecordHeaderBytes-4 {
			return historySpoolSegment{}, nil, fmt.Errorf("terminal history segment record length is invalid")
		}
		checksumTail := make([]byte, 4)
		if _, err := io.ReadFull(file, checksumTail); err != nil {
			return historySpoolSegment{}, nil, fmt.Errorf("terminal history segment checksum is truncated")
		}
		data := make([]byte, dataLength)
		if _, err := io.ReadFull(file, data); err != nil {
			return historySpoolSegment{}, nil, fmt.Errorf("terminal history segment record is truncated")
		}
		var checksum [sha256.Size]byte
		copy(checksum[:28], header[40:68])
		copy(checksum[28:], checksumTail)
		if sha256.Sum256(data) != checksum {
			return historySpoolSegment{}, nil, fmt.Errorf("terminal history segment checksum mismatch")
		}
		sequence := int64(binary.LittleEndian.Uint64(header[8:16]))
		chunk := TerminalDataChunk{
			Sequence:           sequence,
			Timestamp:          int64(binary.LittleEndian.Uint64(header[16:24])),
			Size:               dataLength,
			GeometryGeneration: binary.LittleEndian.Uint64(header[24:32]),
			Cols:               int(binary.LittleEndian.Uint32(header[32:36])),
			Rows:               int(binary.LittleEndian.Uint32(header[36:40])),
		}
		if err := validateHistorySpoolChunkWithDataLength(chunk, dataLength); err != nil {
			return historySpoolSegment{}, nil, err
		}
		record := historySpoolRecord{
			chunk:      chunk,
			path:       path,
			dataOffset: offset + historyRecordHeaderBytes + 4,
			checksum:   checksum,
		}
		records = append(records, record)
		if segment.firstSequence == 0 {
			segment.firstSequence = sequence
		}
		segment.lastSequence = sequence
		offset += historyRecordHeaderBytes + 4 + int64(dataLength)
	}
	return segment, records, nil
}

func readHistorySpoolRecordData(record historySpoolRecord) ([]byte, error) {
	file, err := os.Open(record.path)
	if err != nil {
		return nil, fmt.Errorf("open terminal history segment record: %w", err)
	}
	defer file.Close()
	data := make([]byte, record.chunk.Size)
	if _, err := file.ReadAt(data, record.dataOffset); err != nil {
		return nil, fmt.Errorf("read terminal history segment record: %w", err)
	}
	if sha256.Sum256(data) != record.checksum {
		return nil, fmt.Errorf("terminal history segment checksum mismatch")
	}
	return data, nil
}

func validateHistorySpoolChunk(chunk TerminalDataChunk) error {
	return validateHistorySpoolChunkWithDataLength(chunk, len(chunk.Data))
}

func validateHistorySpoolChunkWithDataLength(chunk TerminalDataChunk, dataLength int) error {
	if chunk.Sequence <= 0 || dataLength <= 0 || chunk.Size != dataLength {
		return fmt.Errorf("terminal history spool record metadata is invalid")
	}
	if chunk.GeometryGeneration == 0 || chunk.Cols <= 0 || chunk.Rows <= 0 {
		return fmt.Errorf("terminal history spool record geometry is invalid")
	}
	return nil
}

func cloneTerminalDataChunk(chunk TerminalDataChunk) TerminalDataChunk {
	copy := chunk
	copy.Data = append([]byte(nil), chunk.Data...)
	return copy
}

func cloneTerminalHistoryCheckpoint(checkpoint TerminalHistoryCheckpoint) TerminalHistoryCheckpoint {
	copy := checkpoint
	copy.Bytes = append([]byte(nil), checkpoint.Bytes...)
	return copy
}

func decodeSHA256(value string) ([sha256.Size]byte, error) {
	var result [sha256.Size]byte
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return result, fmt.Errorf("expected 64 lowercase hexadecimal characters")
	}
	if value != strings.ToLower(value) {
		return result, fmt.Errorf("expected lowercase hexadecimal characters")
	}
	copy(result[:], decoded)
	return result, nil
}

func writeAll(file *os.File, data []byte) error {
	for len(data) > 0 {
		written, err := file.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".floeterm-history-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	cleanup := true
	defer func() {
		_ = temporary.Close()
		if cleanup {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(mode); err != nil {
		return err
	}
	if err := writeAll(temporary, data); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}
