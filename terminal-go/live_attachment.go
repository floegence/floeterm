package terminal

import (
	"errors"
	"sync"
	"time"
)

var ErrLiveAttachmentSuperseded = errors.New("terminal live attachment superseded")

type liveAttachment struct {
	generation               uint64
	subscriber               LiveSubscriber
	lastPresentationSequence uint64
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

func (s *Session) broadcastPresentation(presentation SemanticPresentation, _ []LiveSubscriber) {
	if s == nil || presentation.Sequence == 0 {
		return
	}
	s.presentationDispatchMu.Lock()
	defer s.presentationDispatchMu.Unlock()
	s.mu.Lock()
	subscribers := make([]LiveSubscriber, 0, len(s.liveAttachments))
	for id, attachment := range s.liveAttachments {
		if presentation.Sequence <= attachment.lastPresentationSequence {
			continue
		}
		attachment.lastPresentationSequence = presentation.Sequence
		s.liveAttachments[id] = attachment
		subscribers = append(subscribers, attachment.subscriber)
	}
	s.mu.Unlock()
	for _, subscriber := range subscribers {
		if subscriber.OnPresentation != nil {
			_ = subscriber.OnPresentation(presentation)
		}
	}
}

func (s *Session) AttachSemanticLiveConnection(connectionID string, generation uint64, cols, rows int, subscriber LiveSubscriber) (LiveConnectionAttachment, error) {
	if s == nil || connectionID == "" || generation == 0 || cols <= 0 || rows <= 0 {
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
	geometry := s.effectiveGeometryLocked()
	var presentation SemanticPresentation
	if s.presentationStore != nil {
		presentation, _ = s.presentationStore.Latest()
	}
	if presentation.Sequence > 0 {
		attachment := s.liveAttachments[connectionID]
		attachment.lastPresentationSequence = presentation.Sequence
		s.liveAttachments[connectionID] = attachment
		geometry = presentation.Geometry
	}
	s.mu.Unlock()

	if exists && previous.subscriber.OnSuperseded != nil {
		previous.subscriber.OnSuperseded()
	}
	if presentation.Sequence > 0 && subscriber.OnPresentation != nil {
		_ = subscriber.OnPresentation(presentation)
	}

	var once sync.Once
	detach := func() {
		once.Do(func() {
			s.mu.Lock()
			current, ok := s.liveAttachments[connectionID]
			if ok && current.generation == generation {
				delete(s.liveAttachments, connectionID)
				delete(s.connections, connectionID)
			}
			s.mu.Unlock()
		})
	}

	return LiveConnectionAttachment{
		Presentation: presentation,
		Geometry:     geometry,
		Detach:       detach,
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
