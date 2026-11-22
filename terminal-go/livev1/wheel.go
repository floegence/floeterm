package livev1

import (
	"context"
	"encoding/binary"
	"errors"
	"math"

	terminal "github.com/floegence/floeterm/terminal-go"
)

type Wheel struct {
	Sequence, ControllerEpoch, Generation uint64
	X, Y                                  float32
	Steps                                 int
	Modifiers                             uint16
	PointerAction                         string
}

func decodeWheel(frame Frame) (Wheel, error) {
	payload := frame.Payload
	if len(payload) != 36 || payload[35] != 0 {
		return Wheel{}, ErrInvalidPayload
	}
	order := binary.BigEndian
	wheel := Wheel{Sequence: order.Uint64(payload), ControllerEpoch: order.Uint64(payload[8:]), Generation: order.Uint64(payload[16:]), X: math.Float32frombits(order.Uint32(payload[24:])), Y: math.Float32frombits(order.Uint32(payload[28:])), Steps: int(int8(payload[32])), Modifiers: order.Uint16(payload[33:])}
	if wheel.Sequence == 0 || wheel.ControllerEpoch == 0 || wheel.Generation == 0 || wheel.Steps == 0 || wheel.Steps < -32 || wheel.Steps > 32 || !(wheel.X >= 0 && wheel.X < 65536 && wheel.Y >= 0 && wheel.Y < 65536) || wheel.Modifiers&^15 != 0 {
		return Wheel{}, ErrInvalidPayload
	}
	if frame.Type == FramePointer {
		switch wheel.Steps {
		case 1:
			wheel.PointerAction = "press"
		case 2:
			wheel.PointerAction = "motion"
		case 3:
			wheel.PointerAction = "release"
		default:
			return Wheel{}, ErrInvalidPayload
		}
	}
	return wheel, nil
}

func (b *ManagerBackend) WriteWheel(_ context.Context, attachment Attach, wheel Wheel) error {
	session, ok := b.manager.GetSession(attachment.SessionID)
	if !ok {
		return nil
	}
	input := terminal.SemanticInput{Kind: "wheel", WheelGeneration: wheel.Generation, X: wheel.X, Y: wheel.Y, Steps: wheel.Steps, Modifiers: wheel.Modifiers}
	if wheel.PointerAction != "" {
		input.Kind, input.Action = "pointer", wheel.PointerAction
	}
	err := session.InteractSemantic(attachment.ConnectionID, "local", attachment.AttachGeneration, wheel.ControllerEpoch, input)
	if errors.Is(err, terminal.ErrControllerEpoch) || errors.Is(err, terminal.ErrControllerTransport) || errors.Is(err, terminal.ErrControllerPrincipal) {
		return nil
	}
	return err
}
