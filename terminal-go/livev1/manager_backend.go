package livev1

import (
	"context"
	"errors"
	"fmt"

	terminal "github.com/floegence/floeterm/terminal-go"
)

type ManagerBackendOptions struct {
	Authorize func(context.Context, *terminal.Session, Attach) error
	Activate  func(context.Context, string, int, int) error
}

type ManagerBackend struct {
	manager   *terminal.Manager
	authorize func(context.Context, *terminal.Session, Attach) error
	activate  func(context.Context, string, int, int) error
}

func NewManagerBackend(manager *terminal.Manager, options ManagerBackendOptions) *ManagerBackend {
	backend := &ManagerBackend{
		manager:   manager,
		authorize: options.Authorize,
		activate:  options.Activate,
	}
	if backend.activate == nil && manager != nil {
		backend.activate = manager.ActivateSessionContext
	}
	return backend
}

func (b *ManagerBackend) Attach(ctx context.Context, request Attach, subscriber Subscriber) (Attached, func(), error) {
	if b == nil || b.manager == nil {
		return Attached{}, nil, errors.New("terminal manager is required")
	}
	session, ok := b.manager.GetSession(request.SessionID)
	if !ok || session == nil {
		return Attached{}, nil, ErrSessionNotFound
	}
	if b.authorize != nil {
		if err := b.authorize(ctx, session, request); err != nil {
			return Attached{}, nil, fmt.Errorf("%w: %v", ErrPermissionDenied, err)
		}
	}
	if b.activate == nil {
		return Attached{}, nil, ErrActivationFailed
	}
	if err := b.activate(ctx, request.SessionID, int(request.Cols), int(request.Rows)); err != nil {
		return Attached{}, nil, fmt.Errorf("%w: %v", ErrActivationFailed, err)
	}
	attachment, err := session.AttachLiveConnection(
		request.ConnectionID,
		request.AttachGeneration,
		int(request.Cols),
		int(request.Rows),
		terminal.LiveSubscriber{
			OnOutput: func(event terminal.TerminalOutputEvent) bool {
				if subscriber.OnOutput == nil {
					return false
				}
				return subscriber.OnOutput(OutputRecord{
					Sequence:           uint64(event.Sequence),
					TimestampMs:        uint64(event.TimestampMs),
					GeometryGeneration: event.Geometry.Generation,
					Cols:               uint32(event.Geometry.Cols),
					Rows:               uint32(event.Geometry.Rows),
					Data:               event.Data,
				})
			},
			OnGeometry: func(geometry terminal.TerminalGeometry) bool {
				if subscriber.OnGeometry == nil {
					return false
				}
				return subscriber.OnGeometry(EffectiveGeometry{
					Generation:             geometry.Generation,
					OutputSequenceBoundary: uint64(geometry.OutputSequenceBoundary),
					Cols:                   uint32(geometry.Cols),
					Rows:                   uint32(geometry.Rows),
				})
			},
			OnSessionClosed: subscriber.OnSessionClosed,
			OnSuperseded:    subscriber.OnSuperseded,
		},
	)
	if err != nil {
		if errors.Is(err, terminal.ErrLiveAttachmentSuperseded) {
			return Attached{}, nil, fmt.Errorf("%w: %v", ErrProtocolViolation, err)
		}
		return Attached{}, nil, err
	}
	return Attached{
		HistoryBoundarySequence: uint64(attachment.HistoryBoundarySequence),
		HistoryGeneration:       uint64(attachment.HistoryGeneration),
		HistoryStartSequence:    uint64(attachment.HistoryStartSequence),
		GeometryGeneration:      attachment.Geometry.Generation,
		Cols:                    uint32(attachment.Geometry.Cols),
		Rows:                    uint32(attachment.Geometry.Rows),
	}, attachment.Detach, nil
}

func (b *ManagerBackend) WriteInput(_ context.Context, attachment Attach, input Input) error {
	if b == nil || b.manager == nil {
		return errors.New("terminal manager is required")
	}
	session, ok := b.manager.GetSession(attachment.SessionID)
	if !ok || session == nil {
		return ErrSessionNotFound
	}
	return session.WriteDataWithSource(input.Data, attachment.ConnectionID)
}

func (b *ManagerBackend) Resize(_ context.Context, attachment Attach, resize Resize) (EffectiveGeometry, error) {
	if b == nil || b.manager == nil {
		return EffectiveGeometry{}, errors.New("terminal manager is required")
	}
	session, ok := b.manager.GetSession(attachment.SessionID)
	if !ok || session == nil {
		return EffectiveGeometry{}, ErrSessionNotFound
	}
	geometry, err := session.ApplyConnectionSize(attachment.ConnectionID, int(resize.Cols), int(resize.Rows))
	if err != nil {
		return EffectiveGeometry{}, err
	}
	return EffectiveGeometry{
		Generation:             geometry.Generation,
		OutputSequenceBoundary: uint64(geometry.OutputSequenceBoundary),
		Cols:                   uint32(geometry.Cols),
		Rows:                   uint32(geometry.Rows),
	}, nil
}
