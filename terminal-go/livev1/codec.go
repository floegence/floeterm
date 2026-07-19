package livev1

import (
	"encoding/binary"
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
	MaxOutputBatchBytes  = 64 * 1024
	MaxOutputBatchChunks = 256
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
	FrameAttach FrameType = 0x01
	FrameInput  FrameType = 0x02
	FrameResize FrameType = 0x03
	FrameDetach FrameType = 0x04

	FrameAttached        FrameType = 0x81
	FrameOutputBatch     FrameType = 0x82
	FrameResizeApplied   FrameType = 0x83
	FrameSessionClosed   FrameType = 0x84
	FrameGeometryChanged FrameType = 0x85
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

type Resize struct {
	Sequence uint64
	Cols     uint32
	Rows     uint32
}

type Attached struct {
	HistoryBoundarySequence uint64
	HistoryGeneration       uint64
	HistoryStartSequence    uint64
	GeometryGeneration      uint64
	Cols                    uint32
	Rows                    uint32
}

type ResizeApplied struct {
	Sequence               uint64
	GeometryGeneration     uint64
	OutputSequenceBoundary uint64
	Cols                   uint32
	Rows                   uint32
}

type OutputRecord struct {
	Sequence           uint64
	TimestampMs        uint64
	GeometryGeneration uint64
	Cols               uint32
	Rows               uint32
	Data               []byte
}

type OutputBatch struct {
	GeometryGeneration uint64
	Cols               uint32
	Rows               uint32
	Records            []OutputRecord
}

type EffectiveGeometry struct {
	Generation             uint64
	OutputSequenceBoundary uint64
	Cols                   uint32
	Rows                   uint32
}

type ProtocolError struct {
	Code    uint16
	Message string
}

func validFrameType(frameType FrameType) bool {
	switch frameType {
	case FrameAttach, FrameInput, FrameResize, FrameDetach,
		FrameAttached, FrameOutputBatch, FrameResizeApplied, FrameSessionClosed, FrameGeometryChanged, FrameError:
		return true
	default:
		return false
	}
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
	if value.HistoryGeneration == 0 || value.HistoryStartSequence == 0 || value.HistoryStartSequence > value.HistoryBoundarySequence+1 ||
		value.GeometryGeneration == 0 || value.Cols == 0 || value.Rows == 0 {
		return nil, ErrInvalidPayload
	}
	payload := make([]byte, 40)
	binary.BigEndian.PutUint64(payload[:8], value.HistoryBoundarySequence)
	binary.BigEndian.PutUint64(payload[8:16], value.HistoryGeneration)
	binary.BigEndian.PutUint64(payload[16:24], value.HistoryStartSequence)
	binary.BigEndian.PutUint64(payload[24:32], value.GeometryGeneration)
	binary.BigEndian.PutUint32(payload[32:36], value.Cols)
	binary.BigEndian.PutUint32(payload[36:40], value.Rows)
	return EncodeFrame(Frame{Type: FrameAttached, Payload: payload})
}

func DecodeAttached(frame Frame) (Attached, error) {
	if frame.Type != FrameAttached {
		return Attached{}, ErrUnexpectedFrameType
	}
	if len(frame.Payload) != 40 {
		return Attached{}, ErrInvalidPayload
	}
	value := Attached{
		HistoryBoundarySequence: binary.BigEndian.Uint64(frame.Payload[:8]),
		HistoryGeneration:       binary.BigEndian.Uint64(frame.Payload[8:16]),
		HistoryStartSequence:    binary.BigEndian.Uint64(frame.Payload[16:24]),
		GeometryGeneration:      binary.BigEndian.Uint64(frame.Payload[24:32]),
		Cols:                    binary.BigEndian.Uint32(frame.Payload[32:36]),
		Rows:                    binary.BigEndian.Uint32(frame.Payload[36:40]),
	}
	if value.HistoryGeneration == 0 || value.HistoryStartSequence == 0 || value.HistoryStartSequence > value.HistoryBoundarySequence+1 ||
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
	binary.BigEndian.PutUint64(payload[16:24], value.OutputSequenceBoundary)
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
		Sequence:               binary.BigEndian.Uint64(frame.Payload[:8]),
		GeometryGeneration:     binary.BigEndian.Uint64(frame.Payload[8:16]),
		OutputSequenceBoundary: binary.BigEndian.Uint64(frame.Payload[16:24]),
		Cols:                   binary.BigEndian.Uint32(frame.Payload[24:28]),
		Rows:                   binary.BigEndian.Uint32(frame.Payload[28:32]),
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
	binary.BigEndian.PutUint64(payload[8:16], value.OutputSequenceBoundary)
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
		Generation:             binary.BigEndian.Uint64(frame.Payload[:8]),
		OutputSequenceBoundary: binary.BigEndian.Uint64(frame.Payload[8:16]),
		Cols:                   binary.BigEndian.Uint32(frame.Payload[16:20]),
		Rows:                   binary.BigEndian.Uint32(frame.Payload[20:24]),
	}
	if value.Generation == 0 || value.Cols == 0 || value.Rows == 0 {
		return EffectiveGeometry{}, ErrInvalidPayload
	}
	return value, nil
}

func EncodeOutputBatch(value OutputBatch) ([]byte, error) {
	if value.GeometryGeneration == 0 || value.Cols == 0 || value.Rows == 0 ||
		len(value.Records) == 0 || len(value.Records) > MaxOutputBatchChunks {
		return nil, ErrInvalidPayload
	}
	payload := make([]byte, 18)
	binary.BigEndian.PutUint64(payload[:8], value.GeometryGeneration)
	binary.BigEndian.PutUint32(payload[8:12], value.Cols)
	binary.BigEndian.PutUint32(payload[12:16], value.Rows)
	binary.BigEndian.PutUint16(payload[16:18], uint16(len(value.Records)))
	totalData := 0
	for _, record := range value.Records {
		if record.Sequence == 0 || len(record.Data) == 0 ||
			record.GeometryGeneration != value.GeometryGeneration || record.Cols != value.Cols || record.Rows != value.Rows {
			return nil, ErrInvalidPayload
		}
		totalData += len(record.Data)
		if totalData > MaxOutputBatchBytes {
			return nil, ErrInvalidPayload
		}
		start := len(payload)
		payload = append(payload, make([]byte, 20+len(record.Data))...)
		binary.BigEndian.PutUint64(payload[start:start+8], record.Sequence)
		binary.BigEndian.PutUint64(payload[start+8:start+16], record.TimestampMs)
		binary.BigEndian.PutUint32(payload[start+16:start+20], uint32(len(record.Data)))
		copy(payload[start+20:], record.Data)
	}
	return EncodeFrame(Frame{Type: FrameOutputBatch, Payload: payload})
}

func DecodeOutputBatch(frame Frame) (OutputBatch, error) {
	if frame.Type != FrameOutputBatch {
		return OutputBatch{}, ErrUnexpectedFrameType
	}
	if len(frame.Payload) < 18 {
		return OutputBatch{}, ErrInvalidPayload
	}
	value := OutputBatch{
		GeometryGeneration: binary.BigEndian.Uint64(frame.Payload[:8]),
		Cols:               binary.BigEndian.Uint32(frame.Payload[8:12]),
		Rows:               binary.BigEndian.Uint32(frame.Payload[12:16]),
	}
	if value.GeometryGeneration == 0 || value.Cols == 0 || value.Rows == 0 {
		return OutputBatch{}, ErrInvalidPayload
	}
	count := int(binary.BigEndian.Uint16(frame.Payload[16:18]))
	if count == 0 || count > MaxOutputBatchChunks {
		return OutputBatch{}, ErrInvalidPayload
	}
	offset := 18
	totalData := 0
	records := make([]OutputRecord, 0, count)
	for range count {
		if len(frame.Payload)-offset < 20 {
			return OutputBatch{}, ErrInvalidPayload
		}
		dataSize := int(binary.BigEndian.Uint32(frame.Payload[offset+16 : offset+20]))
		if dataSize <= 0 || dataSize > len(frame.Payload)-(offset+20) {
			return OutputBatch{}, ErrInvalidPayload
		}
		totalData += dataSize
		if totalData > MaxOutputBatchBytes {
			return OutputBatch{}, ErrInvalidPayload
		}
		records = append(records, OutputRecord{
			Sequence:           binary.BigEndian.Uint64(frame.Payload[offset : offset+8]),
			TimestampMs:        binary.BigEndian.Uint64(frame.Payload[offset+8 : offset+16]),
			GeometryGeneration: value.GeometryGeneration,
			Cols:               value.Cols,
			Rows:               value.Rows,
			Data:               append([]byte(nil), frame.Payload[offset+20:offset+20+dataSize]...),
		})
		if records[len(records)-1].Sequence == 0 {
			return OutputBatch{}, ErrInvalidPayload
		}
		offset += 20 + dataSize
	}
	if offset != len(frame.Payload) {
		return OutputBatch{}, ErrInvalidPayload
	}
	value.Records = records
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
