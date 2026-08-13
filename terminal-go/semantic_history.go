package terminal

import (
	"errors"
	"fmt"
)

const MaxSemanticHistoryRows = 200

var (
	ErrSemanticHistoryAnchor   = errors.New("semantic history anchor is invalid")
	ErrSemanticHistoryRevision = errors.New("semantic history revision is stale")
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
	ViewID           string                   `json:"-"`
	ExpectedRevision uint64                   `json:"expectedRevision,omitempty"`
	Anchor           string                   `json:"anchor,omitempty"`
	Direction        SemanticHistoryDirection `json:"direction"`
	Limit            int                      `json:"limit"`
}

// SemanticHistoryPage is a temporary, Go-owned projection. Anchor strings are
// opaque capabilities scoped to one attached view and one actor.
type SemanticHistoryPage struct {
	Revision          uint64        `json:"revision"`
	Anchor            string        `json:"anchor"`
	FirstAvailable    string        `json:"firstAvailable"`
	LastAvailable     string        `json:"lastAvailable"`
	ScreenStart       string        `json:"screenStart"`
	Offset            int           `json:"offset"`
	TotalRows         int           `json:"totalRows"`
	ScreenStartOffset int           `json:"screenStartOffset"`
	HasPrevious       bool          `json:"hasPrevious"`
	HasNext           bool          `json:"hasNext"`
	Frame             SemanticFrame `json:"frame"`
}

type semanticHistoryView struct {
	tokens map[string]SemanticHistoryAnchor
}

func validateSemanticHistoryRequest(request SemanticHistoryRequest) error {
	if request.ViewID == "" || len(request.ViewID) > 256 {
		return errors.New("semantic history view id is invalid")
	}
	if request.Limit <= 0 || request.Limit > MaxSemanticHistoryRows {
		return fmt.Errorf("semantic history limit must be between 1 and %d", MaxSemanticHistoryRows)
	}
	switch request.Direction {
	case HistoryStart, HistoryEnd:
		if request.Anchor != "" {
			return errors.New("semantic history boundary request cannot include an anchor")
		}
	case HistoryForward, HistoryBackward:
		if request.Anchor == "" || len(request.Anchor) > 128 {
			return ErrSemanticHistoryAnchor
		}
	default:
		return errors.New("semantic history direction is invalid")
	}
	return nil
}

func closeSemanticHistoryTokens(tokens map[string]SemanticHistoryAnchor) {
	for _, anchor := range tokens {
		anchor.Close()
	}
}
