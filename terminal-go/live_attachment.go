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

func (s *Session) broadcastPresentation(presentation SemanticPresentation, subscribers []LiveSubscriber) {
	for _, subscriber := range subscribers {
		if subscriber.OnPresentation != nil {
			subscriber.OnPresentation(presentation)
		}
	}
}

func (s *Session) broadcastPendingPresentations(subscribers []LiveSubscriber) {
	if s == nil {
		return
	}
	s.mu.RLock()
	store := s.presentationStore
	s.mu.RUnlock()
	if store == nil {
		return
	}
	presentation, ok := store.TakeLatest()
	if ok && len(subscribers) > 0 {
		s.broadcastPresentation(presentation, subscribers)
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
	return s.attachLiveConnection(connectionID, generation, cols, rows, subscriber, true)
}

func (s *Session) AttachSemanticLiveConnection(connectionID string, generation uint64, cols, rows int, subscriber LiveSubscriber) (LiveConnectionAttachment, error) {
	return s.attachLiveConnection(connectionID, generation, cols, rows, subscriber, false)
}

func (s *Session) attachLiveConnection(
	connectionID string, generation uint64, cols, rows int, subscriber LiveSubscriber, reconcile bool,
) (LiveConnectionAttachment, error) {
	if s == nil || connectionID == "" || generation == 0 || cols <= 0 || rows <= 0 || subscriber.OnOutput == nil {
		return LiveConnectionAttachment{}, errors.New("invalid terminal live attachment")
	}
	if reconcile {
		if err := s.beginPTYResize(); err != nil {
			return LiveConnectionAttachment{}, err
		}
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		if reconcile {
			s.endPTYResize()
		}
		return LiveConnectionAttachment{}, errSessionClosed
	}
	if s.liveAttachments == nil {
		s.liveAttachments = make(map[string]liveAttachment)
	}
	previous, exists := s.liveAttachments[connectionID]
	if exists && previous.generation >= generation {
		s.mu.Unlock()
		s.endPTYResize()
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
	var resizePresentation SemanticPresentation
	var hasResizePresentation bool
	if reconcile && s.isActive {
		var resizeErr error
		resizePresentation, hasResizePresentation, resizeErr = s.reconcilePTYSizeLocked("live-connection-attached", false)
		if resizeErr != nil {
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
			if reconcile {
				s.endPTYResize()
			}
			return LiveConnectionAttachment{}, resizeErr
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
	if reconcile {
		s.endPTYResize()
	}

	if exists && previous.subscriber.OnSuperseded != nil {
		previous.subscriber.OnSuperseded()
	}
	if len(geometrySubscribers) > 0 {
		s.broadcastGeometry(geometry, geometrySubscribers)
		if hasResizePresentation {
			s.broadcastPresentation(resizePresentation, geometrySubscribers)
		}
	}

	var once sync.Once
	detach := func() {
		once.Do(func() {
			if reconcile {
				if err := s.beginPTYResize(); err != nil {
					s.config.logger.Warn("Failed to order PTY resize after live detach", "sessionID", s.ID, "error", err)
					return
				}
			}
			s.mu.Lock()
			previousGeneration := s.geometryGeneration
			var detachedGeometry TerminalGeometry
			var detachedSubscribers []LiveSubscriber
			var detachPresentation SemanticPresentation
			var hasDetachPresentation bool
			current, ok := s.liveAttachments[connectionID]
			if ok && current.generation == generation {
				delete(s.liveAttachments, connectionID)
				delete(s.connections, connectionID)
				if reconcile && s.isActive && len(s.connections) > 0 {
					var resizeErr error
					detachPresentation, hasDetachPresentation, resizeErr = s.reconcilePTYSizeLocked("live-connection-detached", false)
					if resizeErr != nil {
						s.config.logger.Warn("Failed to reconcile PTY after live detach", "sessionID", s.ID, "error", resizeErr)
					}
				}
				detachedGeometry = s.effectiveGeometryLocked()
				if detachedGeometry.Generation != previousGeneration {
					detachedSubscribers = s.liveSubscribersLocked()
				}
			}
			s.mu.Unlock()
			if reconcile {
				s.endPTYResize()
			}
			if len(detachedSubscribers) > 0 {
				s.broadcastGeometry(detachedGeometry, detachedSubscribers)
				if hasDetachPresentation {
					s.broadcastPresentation(detachPresentation, detachedSubscribers)
				}
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
