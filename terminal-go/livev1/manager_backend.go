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
	principalID := "local"
	if err := session.AttachSemanticView(request.ConnectionID, principalID, request.AttachGeneration); err != nil {
		return Attached{}, nil, err
	}
	session.EnsureSemanticController(request.ConnectionID, principalID, request.AttachGeneration)
	attachment, err := session.AttachSemanticLiveConnection(
		request.ConnectionID,
		request.AttachGeneration,
		int(request.Cols),
		int(request.Rows),
		terminal.LiveSubscriber{
			OnGeometry: func(geometry terminal.TerminalGeometry) bool {
				if subscriber.OnGeometry == nil {
					return false
				}
				return subscriber.OnGeometry(EffectiveGeometry{
					Generation:           geometry.Generation,
					PresentationSequence: uint64(geometry.PresentationSequence),
					Cols:                 uint32(geometry.Cols),
					Rows:                 uint32(geometry.Rows),
				})
			},
			OnPresentation: func(p terminal.SemanticPresentation) bool {
				if subscriber.OnPresentation == nil {
					return true
				}
				encoded, err := terminal.EncodeSemanticPresentation(p)
				return err == nil && subscriber.OnPresentation(encoded)
			},
			OnController: func(state terminal.ControllerState) bool {
				if subscriber.OnController == nil {
					return false
				}
				return subscriber.OnController(EffectiveController{
					Epoch: state.Epoch,
					IsController: state.AttachmentID == request.ConnectionID &&
						state.TransportGeneration == request.AttachGeneration,
				})
			},
			OnSessionClosed: subscriber.OnSessionClosed,
			OnSuperseded:    subscriber.OnSuperseded,
		},
	)
	if err != nil {
		session.LogicalDetachSemanticView(request.ConnectionID, request.AttachGeneration)
		if errors.Is(err, terminal.ErrLiveAttachmentSuperseded) {
			return Attached{}, nil, fmt.Errorf("%w: %v", ErrProtocolViolation, err)
		}
		return Attached{}, nil, err
	}
	if err := b.activate(ctx, request.SessionID, int(request.Cols), int(request.Rows)); err != nil {
		attachment.Detach()
		session.LogicalDetachSemanticView(request.ConnectionID, request.AttachGeneration)
		return Attached{}, nil, fmt.Errorf("%w: %v", ErrActivationFailed, err)
	}
	controller := session.Controller()
	if controller.AttachmentID == request.ConnectionID && controller.TransportGeneration == request.AttachGeneration {
		geometry, resizeErr := session.ApplySemanticControllerSize(request.ConnectionID, int(request.Cols), int(request.Rows), true)
		if resizeErr != nil {
			attachment.Detach()
			return Attached{}, nil, resizeErr
		}
		attachment.Geometry = geometry
	} else {
		attachment.Geometry = session.CanonicalGeometry()
	}
	controller = session.Controller()
	return Attached{
			PresentationSequence: attachment.Geometry.PresentationSequence,
			GeometryGeneration:   attachment.Geometry.Generation,
			ControllerEpoch:      controller.Epoch,
			Cols:                 uint32(attachment.Geometry.Cols),
			Rows:                 uint32(attachment.Geometry.Rows),
			IsController:         controller.AttachmentID == request.ConnectionID && controller.TransportGeneration == request.AttachGeneration,
		}, func() {
			attachment.Detach()
			session.LogicalDetachSemanticView(request.ConnectionID, request.AttachGeneration)
		}, nil
}

func (b *ManagerBackend) Activate(_ context.Context, attachment Attach, activate Activate) (Activated, error) {
	if b == nil || b.manager == nil {
		return Activated{}, errors.New("terminal manager is required")
	}
	session, ok := b.manager.GetSession(attachment.SessionID)
	if !ok || session == nil {
		return Activated{}, ErrSessionNotFound
	}
	presentation, controller, err := session.ActivateSemanticView(
		attachment.ConnectionID, "local", attachment.AttachGeneration,
		activate.ControllerEpoch, int(activate.Cols), int(activate.Rows),
	)
	if err != nil {
		switch {
		case errors.Is(err, terminal.ErrControllerEpoch):
			var mismatch *terminal.ControllerEpochMismatchError
			if errors.As(err, &mismatch) {
				current := mismatch.Current
				return Activated{}, &ControllerEpochMismatchError{Controller: EffectiveController{
					Epoch: current.Epoch,
					IsController: current.AttachmentID == attachment.ConnectionID &&
						current.TransportGeneration == attachment.AttachGeneration,
				}}
			}
			return Activated{}, fmt.Errorf("%w: %v", ErrControllerEpoch, err)
		case errors.Is(err, terminal.ErrControllerTransport):
			return Activated{}, fmt.Errorf("%w: %v", ErrControllerTransport, err)
		case errors.Is(err, terminal.ErrControllerPrincipal):
			return Activated{}, fmt.Errorf("%w: %v", ErrControllerPrincipal, err)
		default:
			return Activated{}, err
		}
	}
	return Activated{
		Sequence: activate.Sequence, ControllerEpoch: controller.Epoch,
		GeometryGeneration:   presentation.Geometry.Generation,
		PresentationSequence: presentation.Sequence,
		Cols:                 uint32(presentation.Geometry.Cols), Rows: uint32(presentation.Geometry.Rows),
	}, nil
}

func (b *ManagerBackend) WriteInput(_ context.Context, attachment Attach, input Input) error {
	return b.writeSemanticInput(attachment, terminal.SemanticInput{Kind: "bytes", Data: input.Data})
}

func (b *ManagerBackend) WriteInputIntent(_ context.Context, attachment Attach, input InputIntent) error {
	action := ""
	switch input.Action {
	case KeyActionPress:
		action = "press"
	case KeyActionRepeat:
		action = "repeat"
	case KeyActionRelease:
		action = "release"
	}
	return b.writeSemanticInput(attachment, terminal.SemanticInput{
		Kind: "key", Code: input.Code, Text: input.Text, Action: action, Modifiers: uint16(input.Modifiers),
	})
}

func (b *ManagerBackend) WritePaste(_ context.Context, attachment Attach, input PasteInput) error {
	return b.writeSemanticInput(attachment, terminal.SemanticInput{Kind: "paste", Data: input.Data})
}

func (b *ManagerBackend) writeSemanticInput(attachment Attach, input terminal.SemanticInput) error {
	if b == nil || b.manager == nil {
		return errors.New("terminal manager is required")
	}
	session, ok := b.manager.GetSession(attachment.SessionID)
	if !ok || session == nil {
		return ErrSessionNotFound
	}
	generation, ok := session.SemanticAttachmentGeneration(attachment.ConnectionID)
	if !ok || generation != attachment.AttachGeneration {
		return terminal.ErrControllerTransport
	}
	return session.InteractSemanticView(attachment.ConnectionID, "local", attachment.AttachGeneration, input)
}

func (b *ManagerBackend) Resize(_ context.Context, attachment Attach, resize Resize) (EffectiveGeometry, error) {
	if b == nil || b.manager == nil {
		return EffectiveGeometry{}, errors.New("terminal manager is required")
	}
	session, ok := b.manager.GetSession(attachment.SessionID)
	if !ok || session == nil {
		return EffectiveGeometry{}, ErrSessionNotFound
	}
	state := session.Controller()
	generation, attached := session.SemanticAttachmentGeneration(attachment.ConnectionID)
	if !attached || generation != attachment.AttachGeneration {
		return EffectiveGeometry{}, terminal.ErrControllerTransport
	}
	if state.AttachmentID != attachment.ConnectionID || state.TransportGeneration != attachment.AttachGeneration {
		if err := session.RecordSemanticViewSize(
			attachment.ConnectionID, attachment.AttachGeneration, int(resize.Cols), int(resize.Rows),
		); err != nil {
			return EffectiveGeometry{}, err
		}
		canonical := session.CanonicalGeometry()
		return EffectiveGeometry{Generation: canonical.Generation, PresentationSequence: canonical.PresentationSequence, Cols: uint32(canonical.Cols), Rows: uint32(canonical.Rows)}, nil
	}
	geometry, err := session.ApplySemanticControllerSize(attachment.ConnectionID, int(resize.Cols), int(resize.Rows), false)
	if err != nil {
		return EffectiveGeometry{}, err
	}
	return EffectiveGeometry{
		Generation:           geometry.Generation,
		PresentationSequence: uint64(geometry.PresentationSequence),
		Cols:                 uint32(geometry.Cols),
		Rows:                 uint32(geometry.Rows),
	}, nil
}
