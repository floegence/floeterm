package terminal

import "regexp"

var colorReplyPattern = regexp.MustCompile(`^\x1b\]1[01];rgb:[[:xdigit:]]{4}/[[:xdigit:]]{4}/[[:xdigit:]]{4}(\x07|\x1b\\)$`)

type DefaultColors struct {
	Foreground uint32
	Background uint32
}

func (s *Session) SetControllerDefaultColors(attachmentID string, generation, epoch uint64, colors DefaultColors) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state := s.controllerState
	attachment, ok := s.semanticAttachments[attachmentID]
	if !ok || generation == 0 || attachment.TransportGeneration != generation || state.AttachmentID != attachmentID || state.TransportGeneration != generation || state.Epoch != epoch {
		return false
	}
	return s.setDefaultColorsLocked(colors.Foreground, colors.Background)
}

func (s *Session) SetDefaultColors(foreground, background uint32) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	s.setDefaultColorsLocked(foreground, background)
}

func (s *Session) setDefaultColorsLocked(foreground, background uint32) bool {
	actor := s.semanticActor
	if actor == nil || foreground > 0xffffff || background > 0xffffff {
		return false
	}
	actor.mu.Lock()
	defer actor.mu.Unlock()
	if engine, ok := actor.engine.(interface{ setDefaultColors(uint32, uint32) }); ok {
		engine.setDefaultColors(foreground, background)
		return true
	}
	return false
}

func (s *Session) enqueueColorReplies(replies string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.PTY == nil || s.outputClosed || s.ctx == nil {
		return
	}
	if s.colorReplyQueue == nil {
		queue := make(chan string, 4)
		s.colorReplyQueue = queue
		file, done := s.PTY, s.ctx.Done()
		go func() {
			for {
				select {
				case <-done:
					return
				case reply := <-queue:
					if _, err := file.Write([]byte(reply)); err != nil {
						return
					}
				}
			}
		}()
	}
	select {
	case s.colorReplyQueue <- replies:
	default:
	}
}
