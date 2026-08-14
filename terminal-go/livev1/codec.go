package livev1

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

const (
	StreamKind           = "terminal/live_v1"
	HeaderSize           = 8
	MaxFramePayloadBytes = 256 * 1024
	MaxInputBytes        = 64 * 1024
	MaxIdentifierBytes   = 256
)

var (
	ErrReservedBits        = errors.New("terminal live frame reserved bits are non-zero")
	ErrFrameTooLarge       = errors.New("terminal live frame payload is too large")
	ErrUnknownFrameType    = errors.New("unknown terminal live frame type")
	ErrUnexpectedFrameType = errors.New("unexpected terminal live frame type")
	ErrInvalidPayload      = errors.New("invalid terminal live frame payload")
)

type FrameType uint8

const (
	FrameAttach      FrameType = 0x01
	FrameInput       FrameType = 0x02
	FrameResize      FrameType = 0x03
	FrameDetach      FrameType = 0x04
	FrameInputIntent FrameType = 0x05

	FrameAttached        FrameType = 0x81
	FrameResizeApplied   FrameType = 0x83
	FrameSessionClosed   FrameType = 0x84
	FrameGeometryChanged FrameType = 0x85
	FramePresentation    FrameType = 0x86
	FrameError           FrameType = 0xff
)

type Frame struct {
	Type    FrameType
	Flags   uint8
	Payload []byte
}

type Attach struct {
	AttachGeneration uint64
	Cols             uint32
	Rows             uint32
	SessionID        string
	ConnectionID     string
}

type Input struct {
	Sequence uint64
	Data     []byte
}

type KeyAction uint8

const (
	KeyActionPress KeyAction = iota + 1
	KeyActionRepeat
	KeyActionRelease
)

type KeyModifiers uint16

const (
	KeyModifierShift KeyModifiers = 1 << iota
	KeyModifierControl
	KeyModifierAlt
	KeyModifierSuper
	KeyModifierCapsLock
	KeyModifierNumLock
)

const allKeyModifiers = KeyModifierShift | KeyModifierControl | KeyModifierAlt | KeyModifierSuper | KeyModifierCapsLock | KeyModifierNumLock

type InputIntent struct {
	Sequence  uint64
	Code      string
	Text      string
	Action    KeyAction
	Modifiers KeyModifiers
}

type Resize struct {
	Sequence uint64
	Cols     uint32
	Rows     uint32
}

type Attached struct {
	PresentationSequence uint64
	GeometryGeneration   uint64
	Cols                 uint32
	Rows                 uint32
}

type ResizeApplied struct {
	Sequence             uint64
	GeometryGeneration   uint64
	PresentationSequence uint64
	Cols                 uint32
	Rows                 uint32
}

type EffectiveGeometry struct {
	Generation           uint64
	PresentationSequence uint64
	Cols                 uint32
	Rows                 uint32
}

type ProtocolError struct {
	Code    uint16
	Message string
}

func validFrameType(frameType FrameType) bool {
	switch frameType {
	case FrameAttach, FrameInput, FrameResize, FrameDetach, FrameInputIntent,
		FrameAttached, FrameResizeApplied, FrameSessionClosed, FrameGeometryChanged, FramePresentation, FrameError:
		return true
	default:
		return false
	}
}

func EncodePresentation(value any) ([]byte, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(payload) == 0 || len(payload) > MaxFramePayloadBytes {
		return nil, ErrFrameTooLarge
	}
	return EncodeFrame(Frame{Type: FramePresentation, Payload: payload})
}

func DecodePresentation(frame Frame, value any) error {
	if frame.Type != FramePresentation {
		return ErrUnexpectedFrameType
	}
	if len(frame.Payload) == 0 || len(frame.Payload) > MaxFramePayloadBytes {
		return ErrInvalidPayload
	}
	return json.Unmarshal(frame.Payload, value)
}

func EncodeFrame(frame Frame) ([]byte, error) {
	if !validFrameType(frame.Type) {
		return nil, ErrUnknownFrameType
	}
	if frame.Flags != 0 {
		return nil, ErrReservedBits
	}
	if len(frame.Payload) > MaxFramePayloadBytes {
		return nil, ErrFrameTooLarge
	}
	out := make([]byte, HeaderSize+len(frame.Payload))
	out[0] = byte(frame.Type)
	out[1] = frame.Flags
	binary.BigEndian.PutUint32(out[4:8], uint32(len(frame.Payload)))
	copy(out[HeaderSize:], frame.Payload)
	return out, nil
}

func ReadFrame(reader io.Reader) (Frame, error) {
	if reader == nil {
		return Frame{}, errors.New("nil terminal live reader")
	}
	header := make([]byte, HeaderSize)
	if _, err := io.ReadFull(reader, header); err != nil {
		return Frame{}, err
	}
	frameType := FrameType(header[0])
	if !validFrameType(frameType) {
		return Frame{}, ErrUnknownFrameType
	}
	if header[1] != 0 || header[2] != 0 || header[3] != 0 {
		return Frame{}, ErrReservedBits
	}
	payloadSize := int(binary.BigEndian.Uint32(header[4:8]))
	if payloadSize > MaxFramePayloadBytes {
		return Frame{}, ErrFrameTooLarge
	}
	payload := make([]byte, payloadSize)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return Frame{}, err
	}
	return Frame{Type: frameType, Payload: payload}, nil
}

func WriteFrame(writer io.Writer, frame Frame) error {
	if writer == nil {
		return errors.New("nil terminal live writer")
	}
	data, err := EncodeFrame(frame)
	if err != nil {
		return err
	}
	for len(data) > 0 {
		n, writeErr := writer.Write(data)
		if writeErr != nil {
			return writeErr
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

type Decoder struct {
	buffer []byte
}

func NewDecoder() *Decoder { return &Decoder{} }

func (d *Decoder) Push(chunk []byte) ([]Frame, error) {
	if d == nil {
		return nil, errors.New("nil terminal live decoder")
	}
	if len(chunk) > 0 {
		d.buffer = append(d.buffer, chunk...)
	}
	frames := make([]Frame, 0, 1)
	for len(d.buffer) >= HeaderSize {
		frameType := FrameType(d.buffer[0])
		if !validFrameType(frameType) {
			return nil, ErrUnknownFrameType
		}
		if d.buffer[1] != 0 || d.buffer[2] != 0 || d.buffer[3] != 0 {
			return nil, ErrReservedBits
		}
		payloadSize := int(binary.BigEndian.Uint32(d.buffer[4:8]))
		if payloadSize > MaxFramePayloadBytes {
			return nil, ErrFrameTooLarge
		}
		frameSize := HeaderSize + payloadSize
		if len(d.buffer) < frameSize {
			break
		}
		payload := make([]byte, payloadSize)
		copy(payload, d.buffer[HeaderSize:frameSize])
		frames = append(frames, Frame{Type: frameType, Payload: payload})
		d.buffer = d.buffer[frameSize:]
	}
	if len(d.buffer) == 0 {
		d.buffer = nil
	}
	return frames, nil
}

func EncodeAttach(value Attach) ([]byte, error) {
	if value.AttachGeneration == 0 || value.Cols == 0 || value.Rows == 0 {
		return nil, ErrInvalidPayload
	}
	payload := make([]byte, 16)
	binary.BigEndian.PutUint64(payload[0:8], value.AttachGeneration)
	binary.BigEndian.PutUint32(payload[8:12], value.Cols)
	binary.BigEndian.PutUint32(payload[12:16], value.Rows)
	var err error
	payload, err = appendString(payload, value.SessionID)
	if err != nil {
		return nil, fmt.Errorf("session id: %w", err)
	}
	payload, err = appendString(payload, value.ConnectionID)
	if err != nil {
		return nil, fmt.Errorf("connection id: %w", err)
	}
	return EncodeFrame(Frame{Type: FrameAttach, Payload: payload})
}

func DecodeAttach(frame Frame) (Attach, error) {
	if frame.Type != FrameAttach {
		return Attach{}, ErrUnexpectedFrameType
	}
	if len(frame.Payload) < 20 {
		return Attach{}, ErrInvalidPayload
	}
	value := Attach{
		AttachGeneration: binary.BigEndian.Uint64(frame.Payload[0:8]),
		Cols:             binary.BigEndian.Uint32(frame.Payload[8:12]),
		Rows:             binary.BigEndian.Uint32(frame.Payload[12:16]),
	}
	offset := 16
	var err error
	value.SessionID, offset, err = readString(frame.Payload, offset)
	if err != nil {
		return Attach{}, err
	}
	value.ConnectionID, offset, err = readString(frame.Payload, offset)
	if err != nil || offset != len(frame.Payload) {
		return Attach{}, ErrInvalidPayload
	}
	if value.AttachGeneration == 0 || value.Cols == 0 || value.Rows == 0 {
		return Attach{}, ErrInvalidPayload
	}
	return value, nil
}

func EncodeInput(value Input) ([]byte, error) {
	if value.Sequence == 0 || len(value.Data) == 0 || len(value.Data) > MaxInputBytes {
		return nil, ErrInvalidPayload
	}
	payload := make([]byte, 8+len(value.Data))
	binary.BigEndian.PutUint64(payload[:8], value.Sequence)
	copy(payload[8:], value.Data)
	return EncodeFrame(Frame{Type: FrameInput, Payload: payload})
}

func DecodeInput(frame Frame) (Input, error) {
	if frame.Type != FrameInput {
		return Input{}, ErrUnexpectedFrameType
	}
	if len(frame.Payload) <= 8 || len(frame.Payload)-8 > MaxInputBytes {
		return Input{}, ErrInvalidPayload
	}
	value := Input{Sequence: binary.BigEndian.Uint64(frame.Payload[:8]), Data: append([]byte(nil), frame.Payload[8:]...)}
	if value.Sequence == 0 {
		return Input{}, ErrInvalidPayload
	}
	return value, nil
}

func EncodeInputIntent(value InputIntent) ([]byte, error) {
	code := []byte(value.Code)
	text := []byte(value.Text)
	if value.Sequence == 0 || len(code) == 0 || len(code) > MaxIdentifierBytes || !utf8.Valid(code) ||
		len(text) > MaxInputBytes || !utf8.Valid(text) || !validKeyAction(value.Action) || value.Modifiers&^allKeyModifiers != 0 ||
		16+len(code)+len(text) > MaxInputBytes {
		return nil, ErrInvalidPayload
	}
	payload := make([]byte, 16+len(code)+len(text))
	binary.BigEndian.PutUint64(payload[:8], value.Sequence)
	payload[8] = byte(value.Action)
	binary.BigEndian.PutUint16(payload[10:12], uint16(value.Modifiers))
	binary.BigEndian.PutUint16(payload[12:14], uint16(len(code)))
	binary.BigEndian.PutUint16(payload[14:16], uint16(len(text)))
	copy(payload[16:], code)
	copy(payload[16+len(code):], text)
	return EncodeFrame(Frame{Type: FrameInputIntent, Payload: payload})
}

func DecodeInputIntent(frame Frame) (InputIntent, error) {
	if frame.Type != FrameInputIntent {
		return InputIntent{}, ErrUnexpectedFrameType
	}
	if len(frame.Payload) < 17 || len(frame.Payload) > MaxInputBytes || frame.Payload[9] != 0 {
		return InputIntent{}, ErrInvalidPayload
	}
	codeLength := int(binary.BigEndian.Uint16(frame.Payload[12:14]))
	textLength := int(binary.BigEndian.Uint16(frame.Payload[14:16]))
	if codeLength == 0 || codeLength > MaxIdentifierBytes || 16+codeLength+textLength != len(frame.Payload) {
		return InputIntent{}, ErrInvalidPayload
	}
	value := InputIntent{
		Sequence:  binary.BigEndian.Uint64(frame.Payload[:8]),
		Action:    KeyAction(frame.Payload[8]),
		Modifiers: KeyModifiers(binary.BigEndian.Uint16(frame.Payload[10:12])),
		Code:      string(frame.Payload[16 : 16+codeLength]),
		Text:      string(frame.Payload[16+codeLength:]),
	}
	if value.Sequence == 0 || !validKeyAction(value.Action) || value.Modifiers&^allKeyModifiers != 0 ||
		!utf8.ValidString(value.Code) || !utf8.ValidString(value.Text) {
		return InputIntent{}, ErrInvalidPayload
	}
	return value, nil
}

func validKeyAction(action KeyAction) bool {
	return action == KeyActionPress || action == KeyActionRepeat || action == KeyActionRelease
}

func EncodeResize(value Resize) ([]byte, error) {
	if value.Sequence == 0 || value.Cols == 0 || value.Rows == 0 {
		return nil, ErrInvalidPayload
	}
	payload := make([]byte, 16)
	binary.BigEndian.PutUint64(payload[:8], value.Sequence)
	binary.BigEndian.PutUint32(payload[8:12], value.Cols)
	binary.BigEndian.PutUint32(payload[12:16], value.Rows)
	return EncodeFrame(Frame{Type: FrameResize, Payload: payload})
}

func DecodeResize(frame Frame) (Resize, error) {
	if frame.Type != FrameResize {
		return Resize{}, ErrUnexpectedFrameType
	}
	if len(frame.Payload) != 16 {
		return Resize{}, ErrInvalidPayload
	}
	value := Resize{
		Sequence: binary.BigEndian.Uint64(frame.Payload[:8]),
		Cols:     binary.BigEndian.Uint32(frame.Payload[8:12]),
		Rows:     binary.BigEndian.Uint32(frame.Payload[12:16]),
	}
	if value.Sequence == 0 || value.Cols == 0 || value.Rows == 0 {
		return Resize{}, ErrInvalidPayload
	}
	return value, nil
}

func EncodeAttached(value Attached) ([]byte, error) {
	if value.PresentationSequence == 0 || value.GeometryGeneration == 0 || value.Cols == 0 || value.Rows == 0 {
		return nil, ErrInvalidPayload
	}
	payload := make([]byte, 24)
	binary.BigEndian.PutUint64(payload[:8], value.PresentationSequence)
	binary.BigEndian.PutUint64(payload[8:16], value.GeometryGeneration)
	binary.BigEndian.PutUint32(payload[16:20], value.Cols)
	binary.BigEndian.PutUint32(payload[20:24], value.Rows)
	return EncodeFrame(Frame{Type: FrameAttached, Payload: payload})
}

func DecodeAttached(frame Frame) (Attached, error) {
	if frame.Type != FrameAttached {
		return Attached{}, ErrUnexpectedFrameType
	}
	if len(frame.Payload) != 24 {
		return Attached{}, ErrInvalidPayload
	}
	value := Attached{
		PresentationSequence: binary.BigEndian.Uint64(frame.Payload[:8]),
		GeometryGeneration:   binary.BigEndian.Uint64(frame.Payload[8:16]),
		Cols:                 binary.BigEndian.Uint32(frame.Payload[16:20]),
		Rows:                 binary.BigEndian.Uint32(frame.Payload[20:24]),
	}
	if value.PresentationSequence == 0 ||
		value.GeometryGeneration == 0 || value.Cols == 0 || value.Rows == 0 {
		return Attached{}, ErrInvalidPayload
	}
	return value, nil
}

func EncodeResizeApplied(value ResizeApplied) ([]byte, error) {
	if value.Sequence == 0 || value.GeometryGeneration == 0 || value.Cols == 0 || value.Rows == 0 {
		return nil, ErrInvalidPayload
	}
	payload := make([]byte, 32)
	binary.BigEndian.PutUint64(payload[:8], value.Sequence)
	binary.BigEndian.PutUint64(payload[8:16], value.GeometryGeneration)
	binary.BigEndian.PutUint64(payload[16:24], value.PresentationSequence)
	binary.BigEndian.PutUint32(payload[24:28], value.Cols)
	binary.BigEndian.PutUint32(payload[28:32], value.Rows)
	return EncodeFrame(Frame{Type: FrameResizeApplied, Payload: payload})
}

func DecodeResizeApplied(frame Frame) (ResizeApplied, error) {
	if frame.Type != FrameResizeApplied {
		return ResizeApplied{}, ErrUnexpectedFrameType
	}
	if len(frame.Payload) != 32 {
		return ResizeApplied{}, ErrInvalidPayload
	}
	value := ResizeApplied{
		Sequence:             binary.BigEndian.Uint64(frame.Payload[:8]),
		GeometryGeneration:   binary.BigEndian.Uint64(frame.Payload[8:16]),
		PresentationSequence: binary.BigEndian.Uint64(frame.Payload[16:24]),
		Cols:                 binary.BigEndian.Uint32(frame.Payload[24:28]),
		Rows:                 binary.BigEndian.Uint32(frame.Payload[28:32]),
	}
	if value.Sequence == 0 || value.GeometryGeneration == 0 || value.Cols == 0 || value.Rows == 0 {
		return ResizeApplied{}, ErrInvalidPayload
	}
	return value, nil
}

func EncodeGeometryChanged(value EffectiveGeometry) ([]byte, error) {
	if value.Generation == 0 || value.Cols == 0 || value.Rows == 0 {
		return nil, ErrInvalidPayload
	}
	payload := make([]byte, 24)
	binary.BigEndian.PutUint64(payload[:8], value.Generation)
	binary.BigEndian.PutUint64(payload[8:16], value.PresentationSequence)
	binary.BigEndian.PutUint32(payload[16:20], value.Cols)
	binary.BigEndian.PutUint32(payload[20:24], value.Rows)
	return EncodeFrame(Frame{Type: FrameGeometryChanged, Payload: payload})
}

func DecodeGeometryChanged(frame Frame) (EffectiveGeometry, error) {
	if frame.Type != FrameGeometryChanged {
		return EffectiveGeometry{}, ErrUnexpectedFrameType
	}
	if len(frame.Payload) != 24 {
		return EffectiveGeometry{}, ErrInvalidPayload
	}
	value := EffectiveGeometry{
		Generation:           binary.BigEndian.Uint64(frame.Payload[:8]),
		PresentationSequence: binary.BigEndian.Uint64(frame.Payload[8:16]),
		Cols:                 binary.BigEndian.Uint32(frame.Payload[16:20]),
		Rows:                 binary.BigEndian.Uint32(frame.Payload[20:24]),
	}
	if value.Generation == 0 || value.Cols == 0 || value.Rows == 0 {
		return EffectiveGeometry{}, ErrInvalidPayload
	}
	return value, nil
}

func EncodeProtocolError(value ProtocolError) ([]byte, error) {
	if value.Code == 0 {
		return nil, ErrInvalidPayload
	}
	payload := make([]byte, 2)
	binary.BigEndian.PutUint16(payload, value.Code)
	var err error
	payload, err = appendString(payload, value.Message)
	if err != nil {
		return nil, err
	}
	return EncodeFrame(Frame{Type: FrameError, Payload: payload})
}

func appendString(dst []byte, value string) ([]byte, error) {
	if value == "" || !utf8.ValidString(value) || len(value) > MaxIdentifierBytes {
		return nil, ErrInvalidPayload
	}
	start := len(dst)
	dst = append(dst, make([]byte, 2+len(value))...)
	binary.BigEndian.PutUint16(dst[start:start+2], uint16(len(value)))
	copy(dst[start+2:], value)
	return dst, nil
}

func readString(data []byte, offset int) (string, int, error) {
	if offset < 0 || len(data)-offset < 2 {
		return "", offset, ErrInvalidPayload
	}
	size := int(binary.BigEndian.Uint16(data[offset : offset+2]))
	offset += 2
	if size == 0 || size > MaxIdentifierBytes || size > len(data)-offset {
		return "", offset, ErrInvalidPayload
	}
	value := data[offset : offset+size]
	if !utf8.Valid(value) {
		return "", offset, ErrInvalidPayload
	}
	return string(value), offset + size, nil
}
