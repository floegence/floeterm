import { describe, expect, it } from 'vitest';
import vectorsJson from '../../../protocol/terminal_live_v1_vectors.json?raw';

import {
  MAX_FRAME_PAYLOAD_BYTES,
  StreamKind,
  TerminalLiveDecoder,
  TerminalLiveFrameType,
  decodeInput,
  encodeAttach,
  encodeAttached,
  encodeInput,
  encodeGeometryChanged,
  encodeOutputBatch,
  encodeResize,
  encodeResizeApplied,
} from './codec.js';

const vectors = JSON.parse(vectorsJson) as { kind: string; vectors: Array<{ name: string; hex: string }> };

const hex = (data: Uint8Array): string => Array.from(data, value => value.toString(16).padStart(2, '0')).join('');

describe('terminal/live_v1 codec', () => {
  it('matches the shared protocol vectors', () => {
    expect(vectors.kind).toBe(StreamKind);
    const encoded = new Map<string, Uint8Array>([
      ['attach', encodeAttach({ attachGeneration: 1n, cols: 80, rows: 24, sessionId: 's1', connectionId: 'c1' })],
      ['input', encodeInput({ sequence: 1n, data: new TextEncoder().encode('abc') })],
      ['resize', encodeResize({ sequence: 7n, cols: 80, rows: 24 })],
      ['attached', encodeAttached({
        historyBoundarySequence: 42n,
        historyGeneration: 3n,
        historyStartSequence: 40n,
        geometryGeneration: 5n,
        cols: 80,
        rows: 24,
      })],
      ['resize_applied', encodeResizeApplied({ sequence: 7n, geometryGeneration: 5n, outputSequenceBoundary: 42n, cols: 80, rows: 24 })],
      ['output_batch', encodeOutputBatch({
        geometryGeneration: 5n,
        cols: 80,
        rows: 24,
        records: [{ sequence: 9n, timestampMs: 10n, data: new Uint8Array([0x61, 0x62]) }],
      })],
      ['geometry_changed', encodeGeometryChanged({ generation: 5n, outputSequenceBoundary: 42n, cols: 80, rows: 24 })],
    ]);
    for (const vector of vectors.vectors) {
      expect(hex(encoded.get(vector.name)!)).toBe(vector.hex);
    }
  });

  it('rejects invalid effective geometry in server frames', () => {
    expect(() => encodeAttached({
      historyBoundarySequence: 0n,
      historyGeneration: 1n,
      historyStartSequence: 1n,
      geometryGeneration: 0n,
      cols: 0,
      rows: 0,
    })).toThrow(/geometry|cols|rows/i);
    expect(() => encodeResizeApplied({ sequence: 1n, geometryGeneration: 0n, outputSequenceBoundary: 0n, cols: 0, rows: 0 })).toThrow(/geometry|cols|rows/i);
    expect(() => encodeOutputBatch({
      geometryGeneration: 0n,
      cols: 0,
      rows: 0,
      records: [{ sequence: 1n, timestampMs: 1n, data: new Uint8Array([0x78]) }],
    })).toThrow(/geometry|cols|rows/i);
  });

  it('decodes fragmented and coalesced frames', () => {
    const input = encodeInput({ sequence: 1n, data: new Uint8Array([0x61]) });
    const resize = encodeResize({ sequence: 2n, cols: 120, rows: 40 });
    const decoder = new TerminalLiveDecoder();
    expect(decoder.push(input.subarray(0, 5))).toEqual([]);
    const joined = new Uint8Array(input.byteLength - 5 + resize.byteLength);
    joined.set(input.subarray(5));
    joined.set(resize, input.byteLength - 5);
    expect(decoder.push(joined).map(frame => frame.type)).toEqual([
      TerminalLiveFrameType.Input,
      TerminalLiveFrameType.Resize,
    ]);
  });

  it('rejects reserved bits and oversized frames', () => {
    expect(() => new TerminalLiveDecoder().push(new Uint8Array([
      TerminalLiveFrameType.Input, 0, 0, 1, 0, 0, 0, 0,
    ]))).toThrow(/reserved/i);

    const size = MAX_FRAME_PAYLOAD_BYTES + 1;
    expect(() => new TerminalLiveDecoder().push(new Uint8Array([
      TerminalLiveFrameType.Input,
      0,
      0,
      0,
      (size >>> 24) & 0xff,
      (size >>> 16) & 0xff,
      (size >>> 8) & 0xff,
      size & 0xff,
    ]))).toThrow(/too large/i);
  });

  it('rejects wrong frame types and invalid payloads', () => {
    expect(() => decodeInput({ type: TerminalLiveFrameType.Resize, flags: 0, payload: new Uint8Array() })).toThrow(/type/i);
    expect(() => decodeInput({ type: TerminalLiveFrameType.Input, flags: 0, payload: new Uint8Array(7) })).toThrow(/payload/i);
  });
});
