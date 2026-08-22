package terminal

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	// A remote client may fetch a bounded multi-viewport window and slice it
	// locally. The encoded snapshot byte limit remains the authoritative payload
	// guard; 4,000 rows covers a 20x window at the maximum terminal height.
	MaxSemanticHistoryRows              = 4000
	MaxSemanticHistoryChunkPayloadBytes = 60 * 1024
	MaxSemanticHistorySnapshotBytes     = 16 * 1024 * 1024
)

type SemanticHistoryLane string

const (
	HistoryViewportLane SemanticHistoryLane = "viewport"
	HistorySearchLane   SemanticHistoryLane = "search"
)

type SemanticHistoryPriority string

const (
	HistoryDemandPriority   SemanticHistoryPriority = "demand"
	HistoryPrefetchPriority SemanticHistoryPriority = "prefetch"
)

func normalizeSemanticHistoryPriority(priority SemanticHistoryPriority) SemanticHistoryPriority {
	if priority == "" {
		return HistoryDemandPriority
	}
	return priority
}

func normalizeSemanticHistoryLane(lane SemanticHistoryLane) SemanticHistoryLane {
	if lane == "" {
		return HistoryViewportLane
	}
	return lane
}

var (
	ErrSemanticHistoryAnchor     = errors.New("semantic history anchor is invalid")
	ErrSemanticHistorySuperseded = errors.New("semantic history snapshot was superseded")
)

type SemanticHistoryDirection string

const (
	HistoryStart    SemanticHistoryDirection = "start"
	HistoryEnd      SemanticHistoryDirection = "end"
	HistoryForward  SemanticHistoryDirection = "forward"
	HistoryBackward SemanticHistoryDirection = "backward"
)

type AnchorStatus uint8

const (
	AnchorValid AnchorStatus = iota
	AnchorInvalid
)

type SemanticHistoryAnchor interface {
	Close()
}

// SemanticHistoryEngine is deliberately separate from SemanticEngine so a
// non-native build fails closed instead of inventing a second history source.
type SemanticHistoryEngine interface {
	TrackHistoryCell(column, screenRow int) (SemanticHistoryAnchor, error)
	HistoryAnchorScreenRow(SemanticHistoryAnchor) (int, AnchorStatus, error)
	HistoryTotalRows() (int, error)
	ReadHistory(SemanticHistoryAnchor, int) (SemanticFrame, AnchorStatus, error)
}

type SemanticHistoryRequest struct {
	ViewID          string                   `json:"-"`
	Lane            SemanticHistoryLane      `json:"lane,omitempty"`
	Priority        SemanticHistoryPriority  `json:"priority,omitempty"`
	Anchor          string                   `json:"anchor,omitempty"`
	SnapshotID      string                   `json:"snapshotId,omitempty"`
	Continuation    string                   `json:"continuation,omitempty"`
	Direction       SemanticHistoryDirection `json:"direction,omitempty"`
	Offset          int                      `json:"offset,omitempty"`
	ScrollDeltaRows int                      `json:"scrollDeltaRows,omitempty"`
	TargetOffset    *int                     `json:"targetOffset,omitempty"`
	ViewportRows    int                      `json:"viewportRows,omitempty"`
}

// SemanticHistoryChunk is one transport-bounded part of a complete immutable
// viewport snapshot. All chunks share one identity and must be reassembled
// before any frame becomes visible.
type SemanticHistoryChunk struct {
	SnapshotID            string              `json:"snapshotId"`
	Continuation          string              `json:"continuation,omitempty"`
	Lane                  SemanticHistoryLane `json:"lane"`
	ChunkIndex            int                 `json:"chunkIndex"`
	ChunkCount            int                 `json:"chunkCount"`
	PayloadBytes          int                 `json:"payloadBytes"`
	PayloadSHA256         string              `json:"payloadSha256"`
	Payload               []byte              `json:"payload"`
	Revision              uint64              `json:"revision"`
	TransportGeneration   uint64              `json:"transportGeneration"`
	ContentEpoch          uint64              `json:"contentEpoch"`
	GeometryGeneration    uint64              `json:"geometryGeneration"`
	Cols                  int                 `json:"cols"`
	Rows                  int                 `json:"rows"`
	Anchor                string              `json:"anchor"`
	FirstAvailable        string              `json:"firstAvailable"`
	LastAvailable         string              `json:"lastAvailable"`
	ScreenStart           string              `json:"screenStart"`
	Offset                int                 `json:"offset"`
	TotalRows             int                 `json:"totalRows"`
	ScreenStartOffset     int                 `json:"screenStartOffset"`
	HistoryEpoch          uint64              `json:"historyEpoch"`
	FirstRowOrdinal       uint64              `json:"firstRowOrdinal"`
	ScreenStartRowOrdinal uint64              `json:"screenStartRowOrdinal"`
	HasPrevious           bool                `json:"hasPrevious"`
	HasNext               bool                `json:"hasNext"`
}

type semanticHistoryView struct {
	anchorID         string
	firstAvailableID string
	lastAvailableID  string
	screenStartID    string
	firstAvailable   SemanticHistoryAnchor
	lastAvailable    SemanticHistoryAnchor
	screenStart      SemanticHistoryAnchor
	requestEpoch     uint64
	snapshot         semanticHistorySnapshot
}

type semanticHistorySnapshot struct {
	id                    string
	lane                  SemanticHistoryLane
	payload               []byte
	payloadSHA256         string
	nextChunkIndex        int
	revision              uint64
	contentEpoch          uint64
	geometryGeneration    uint64
	cols                  int
	rows                  int
	offset                int
	totalRows             int
	screenStartOffset     int
	historyEpoch          uint64
	firstRowOrdinal       uint64
	screenStartRowOrdinal uint64
	hasPrevious           bool
	hasNext               bool
	anchor                string
	firstAvailable        string
	lastAvailable         string
	screenStart           string
}

func validateSemanticHistoryRequest(request SemanticHistoryRequest) error {
	if request.ViewID == "" || len(request.ViewID) > 256 {
		return errors.New("semantic history view id is invalid")
	}
	if request.Lane != "" && request.Lane != HistoryViewportLane && request.Lane != HistorySearchLane {
		return errors.New("semantic history lane is invalid")
	}
	if request.Priority != "" && request.Priority != HistoryDemandPriority && request.Priority != HistoryPrefetchPriority {
		return errors.New("semantic history priority is invalid")
	}
	if request.Continuation != "" {
		if len(request.Continuation) > 192 || request.Anchor != "" || request.SnapshotID != "" || request.Direction != "" || request.Offset != 0 || request.ScrollDeltaRows != 0 || request.TargetOffset != nil || request.ViewportRows != 0 {
			return errors.New("semantic history continuation request is invalid")
		}
		return nil
	}
	if request.ViewportRows <= 0 || request.ViewportRows > MaxSemanticHistoryRows {
		return fmt.Errorf("semantic history viewport rows must be between 1 and %d", MaxSemanticHistoryRows)
	}
	switch request.Direction {
	case HistoryStart, HistoryEnd:
		if request.Anchor != "" || request.SnapshotID != "" || request.Offset != 0 || request.ScrollDeltaRows != 0 {
			return errors.New("semantic history boundary request cannot include an anchor")
		}
		if request.TargetOffset != nil && *request.TargetOffset < 0 {
			return ErrSemanticHistoryAnchor
		}
	case HistoryForward, HistoryBackward:
		if request.Anchor == "" || len(request.Anchor) > 128 || request.SnapshotID == "" || len(request.SnapshotID) > 128 || request.Offset < 0 {
			return ErrSemanticHistoryAnchor
		}
		if request.TargetOffset != nil {
			if *request.TargetOffset < 0 {
				return ErrSemanticHistoryAnchor
			}
		} else if request.ScrollDeltaRows <= 0 || request.ScrollDeltaRows > MaxSemanticHistoryRows {
			return ErrSemanticHistoryAnchor
		}
	default:
		return errors.New("semantic history direction is invalid")
	}
	return nil
}

func (view *semanticHistoryView) close() {
	if view == nil {
		return
	}
	for _, anchor := range []SemanticHistoryAnchor{view.firstAvailable} {
		if anchor != nil {
			anchor.Close()
		}
	}
	view.firstAvailable = nil
	view.lastAvailable = nil
	view.screenStart = nil
	view.snapshot.payload = nil
}

func encodeSemanticHistoryFrame(frame SemanticFrame) ([]byte, string, error) {
	payload, err := json.Marshal(map[string]any{"v": 1, "frame": semanticFrameWire(frame)})
	if err != nil {
		return nil, "", err
	}
	if len(payload) == 0 || len(payload) > MaxSemanticHistorySnapshotBytes {
		return nil, "", ErrPresentationBackpressure
	}
	digest := sha256.Sum256(payload)
	return payload, hex.EncodeToString(digest[:]), nil
}

func semanticHistoryContinuation(snapshotID string, chunkIndex int) string {
	return "hc-" + snapshotID + "-" + strconv.Itoa(chunkIndex)
}

func semanticHistoryContinuationIndex(snapshotID, continuation string) (int, bool) {
	prefix := "hc-" + snapshotID + "-"
	if !strings.HasPrefix(continuation, prefix) {
		return 0, false
	}
	index, err := strconv.Atoi(strings.TrimPrefix(continuation, prefix))
	return index, err == nil && index >= 0
}

func semanticHistoryChunk(snapshot semanticHistorySnapshot, chunkIndex int) (SemanticHistoryChunk, error) {
	chunkCount := (len(snapshot.payload) + MaxSemanticHistoryChunkPayloadBytes - 1) / MaxSemanticHistoryChunkPayloadBytes
	if chunkIndex < 0 || chunkIndex >= chunkCount || chunkCount <= 0 {
		return SemanticHistoryChunk{}, ErrSemanticHistoryAnchor
	}
	start := chunkIndex * MaxSemanticHistoryChunkPayloadBytes
	end := min(len(snapshot.payload), start+MaxSemanticHistoryChunkPayloadBytes)
	continuation := ""
	if chunkIndex+1 < chunkCount {
		continuation = semanticHistoryContinuation(snapshot.id, chunkIndex+1)
	}
	return SemanticHistoryChunk{
		SnapshotID: snapshot.id, Continuation: continuation,
		Lane:       snapshot.lane,
		ChunkIndex: chunkIndex, ChunkCount: chunkCount,
		PayloadBytes: len(snapshot.payload), PayloadSHA256: snapshot.payloadSHA256,
		Payload:  append([]byte(nil), snapshot.payload[start:end]...),
		Revision: snapshot.revision, ContentEpoch: snapshot.contentEpoch,
		GeometryGeneration: snapshot.geometryGeneration, Cols: snapshot.cols, Rows: snapshot.rows,
		Anchor: snapshot.anchor, FirstAvailable: snapshot.firstAvailable,
		LastAvailable: snapshot.lastAvailable, ScreenStart: snapshot.screenStart,
		Offset: snapshot.offset, TotalRows: snapshot.totalRows,
		ScreenStartOffset: snapshot.screenStartOffset,
		HistoryEpoch:      snapshot.historyEpoch, FirstRowOrdinal: snapshot.firstRowOrdinal,
		ScreenStartRowOrdinal: snapshot.screenStartRowOrdinal,
		HasPrevious:           snapshot.hasPrevious, HasNext: snapshot.hasNext,
	}, nil
}
