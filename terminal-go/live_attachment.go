package terminal

import (
	"errors"
	"sync"
	"time"
)

var ErrLiveAttachmentSuperseded = errors.New("terminal live attachment superseded")

type liveAttachment struct {
	generation uint64
	subscriber LiveSubscriber
}

func (s *Session) liveSubscribersLocked() []LiveSubscriber {
	subscribers := make([]LiveSubscriber, 0, len(s.liveAttachments))
	for _, attachment := range s.liveAttachments {
		subscribers = append(subscribers, attachment.subscriber)
	}
	return subscribers
}

func (s *Session) broadcastGeometry(geometry TerminalGeometry, subscribers []LiveSubscriber) {
	for _, subscriber := range subscribers {
		if subscriber.OnGeometry != nil {
			subscriber.OnGeometry(geometry)
		}
	}
}

// AttachLiveConnection atomically registers a connection and its subscriber,
// then returns the exact sequence covered by the initial history snapshot.
func (s *Session) AttachLiveConnection(
	connectionID string,
	generation uint64,
	cols int,
	rows int,
	subscriber LiveSubscriber,
) (LiveConnectionAttachment, error) {
	if s == nil || connectionID == "" || generation == 0 || cols <= 0 || rows <= 0 || subscriber.OnOutput == nil {
		return LiveConnectionAttachment{}, errors.New("invalid terminal live attachment")
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return LiveConnectionAttachment{}, errSessionClosed
	}
	if s.liveAttachments == nil {
		s.liveAttachments = make(map[string]liveAttachment)
	}
	previous, exists := s.liveAttachments[connectionID]
	if exists && previous.generation >= generation {
		s.mu.Unlock()
		return LiveConnectionAttachment{}, ErrLiveAttachmentSuperseded
	}
	previousConnection := s.connections[connectionID]
	previousGeometryGeneration := s.geometryGeneration
	s.liveAttachments[connectionID] = liveAttachment{generation: generation, subscriber: subscriber}
	if s.connections == nil {
		s.connections = make(map[string]*ConnectionInfo)
	}
	s.connections[connectionID] = &ConnectionInfo{
		ConnID:   connectionID,
		JoinedAt: time.Now(),
		Cols:     cols,
		Rows:     rows,
	}
	if s.isActive {
		if err := s.reconcilePTYSizeLocked("live-connection-attached"); err != nil {
			if exists {
				s.liveAttachments[connectionID] = previous
			} else {
				delete(s.liveAttachments, connectionID)
			}
			if previousConnection != nil {
				s.connections[connectionID] = previousConnection
			} else {
				delete(s.connections, connectionID)
			}
			s.mu.Unlock()
			return LiveConnectionAttachment{}, err
		}
	}
	boundary := s.committedSequence
	if s.historyGeneration <= 0 {
		s.historyGeneration = 1
	}
	if s.historyStartSequence <= 0 {
		s.historyStartSequence = 1
	}
	historyGeneration := s.historyGeneration
	historyStartSequence := s.historyStartSequence
	geometry := s.effectiveGeometryLocked()
	var geometrySubscribers []LiveSubscriber
	if geometry.Generation != previousGeometryGeneration {
		geometrySubscribers = s.liveSubscribersLocked()
	}
	s.mu.Unlock()

	if exists && previous.subscriber.OnSuperseded != nil {
		previous.subscriber.OnSuperseded()
	}
	if len(geometrySubscribers) > 0 {
		s.broadcastGeometry(geometry, geometrySubscribers)
	}

	var once sync.Once
	detach := func() {
		once.Do(func() {
			s.mu.Lock()
			previousGeneration := s.geometryGeneration
			var detachedGeometry TerminalGeometry
			var detachedSubscribers []LiveSubscriber
			current, ok := s.liveAttachments[connectionID]
			if ok && current.generation == generation {
				delete(s.liveAttachments, connectionID)
				delete(s.connections, connectionID)
				if s.isActive && len(s.connections) > 0 {
					if err := s.reconcilePTYSizeLocked("live-connection-detached"); err != nil {
						s.config.logger.Warn("Failed to reconcile PTY after live detach", "sessionID", s.ID, "error", err)
					}
				}
				detachedGeometry = s.effectiveGeometryLocked()
				if detachedGeometry.Generation != previousGeneration {
					detachedSubscribers = s.liveSubscribersLocked()
				}
			}
			s.mu.Unlock()
			if len(detachedSubscribers) > 0 {
				s.broadcastGeometry(detachedGeometry, detachedSubscribers)
			}
		})
	}

	return LiveConnectionAttachment{
		HistoryBoundarySequence: boundary,
		HistoryGeneration:       historyGeneration,
		HistoryStartSequence:    historyStartSequence,
		Geometry:                geometry,
		Detach:                  detach,
	}, nil
}

func (s *Session) detachLiveSubscribersForClose() []LiveSubscriber {
	if s == nil || len(s.liveAttachments) == 0 {
		return nil
	}
	subscribers := make([]LiveSubscriber, 0, len(s.liveAttachments))
	for connectionID, attachment := range s.liveAttachments {
		subscribers = append(subscribers, attachment.subscriber)
		delete(s.liveAttachments, connectionID)
	}
	return subscribers
}
