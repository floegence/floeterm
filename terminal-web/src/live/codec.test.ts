import { describe, expect, it } from 'vitest';

import {
  TerminalLiveDecoder,
  TerminalLiveFrameType,
  decodeAttach,
  decodeActivate,
  decodeActivationRejected,
  decodeInput,
  decodeInputIntent,
  decodePasteChunk,
  decodePresentation,
  decodeResize,
  encodeAttach,
  encodeActivate,
  encodeActivationRejected,
  encodeInput,
  encodeInputIntent,
  encodePasteChunk,
  encodeResize,
} from './codec.js';

const presentationFrame = (value: unknown): Uint8Array => {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const out = new Uint8Array(8 + payload.byteLength);
  out[0] = TerminalLiveFrameType.Presentation;
  new DataView(out.buffer).setUint32(4, payload.byteLength, false);
  out.set(payload, 8);
  return out;
};

describe('semantic terminal live codec', () => {
  it('round trips client attach, text input, structured key input, paste chunks, and resize frames', () => {
    const decoder = new TerminalLiveDecoder();
    const frames = [
      encodeAttach({ attachGeneration: 2n, cols: 80, rows: 24, sessionId: 's', connectionId: 'c' }),
      encodeInput({ sequence: 1n, data: new TextEncoder().encode('中') }),
      encodeInputIntent({
        sequence: 2n,
        code: 'ArrowUp',
        text: '',
        action: 'repeat',
        modifiers: 0x03,
      }),
      encodePasteChunk({ sequence: 3n, start: true, end: true, data: new TextEncoder().encode('paste') }),
      encodeResize({ sequence: 2n, cols: 120, rows: 40 }),
      encodeActivate({ sequence: 3n, controllerEpoch: 4n, cols: 140, rows: 50 }),
    ].flatMap(encoded => decoder.push(encoded));
    expect(decodeAttach(frames[0]!)).toMatchObject({ attachGeneration: 2n, cols: 80, rows: 24 });
    expect(new TextDecoder().decode(decodeInput(frames[1]!).data)).toBe('中');
    expect(decodeInputIntent(frames[2]!)).toEqual({
      sequence: 2n,
      code: 'ArrowUp',
      text: '',
      action: 'repeat',
      modifiers: 0x03,
    });
    expect(decodePasteChunk(frames[3]!)).toEqual({
      sequence: 3n, start: true, end: true, data: new TextEncoder().encode('paste'),
    });
    expect(decodeResize(frames[4]!)).toEqual({ sequence: 2n, cols: 120, rows: 40 });
    expect(decodeActivate(frames[5]!)).toEqual({ sequence: 3n, controllerEpoch: 4n, cols: 140, rows: 50 });
  });

  it('rejects malformed structured key intent payloads', () => {
    const encoded = encodeInputIntent({ sequence: 1n, code: 'Enter', text: '', action: 'press', modifiers: 0 });
    const frame = new TerminalLiveDecoder().push(encoded)[0]!;
    frame.payload[9] = 0xff;
    expect(() => decodeInputIntent(frame)).toThrow(/input intent/i);
  });

  it('round trips a recoverable stale activation settlement', () => {
    const frame = new TerminalLiveDecoder().push(encodeActivationRejected({
      sequence: 7n,
      controllerEpoch: 11n,
      isController: false,
    }))[0]!;
    expect(decodeActivationRejected(frame)).toEqual({
      sequence: 7n,
      controllerEpoch: 11n,
      isController: false,
    });
  });

  it('decodes an owned semantic presentation and rejects the removed raw frame type', () => {
    const encoded = presentationFrame({
      v: 1,
      sequence: 1,
      geometry: { generation: 1, cols: 1, rows: 1 },
      state: { sequence: 1, contentEpoch: 4 },
      frame: {
        width: 1,
        height: 1,
        bufferKind: 'normal',
        cursor: { x: 0, y: 0, visible: true, shape: 'block', blinking: false },
        history: { revision: 1, totalRows: 1, screenStartOffset: 0 },
        styles: [['default', 'default', false, false, false]],
        styleInverses: [true],
        rows: [[['中', 2, 0, '']]],
        graphics: { generation: 3, images: [{ id: 7, width: 1, height: 1, format: 0, generation: 2, pixels: 'AQID' }], placements: [] },
      },
    });
    const decodedFrame = new TerminalLiveDecoder().push(encoded)[0]!;
    const decoded = decodePresentation(decodedFrame) as any;
    expect(decoded.state.contentEpoch).toBe(4);
    expect(decoded.frame.rows[0].cells[0]).toMatchObject({ text: '中', width: 2, style: { inverse: true } });
    expect(decoded.frame.graphics.images[0].pixels).toEqual(new Uint8Array([1, 2, 3]));

    const raw = new Uint8Array(8);
    raw[0] = 0x82;
    expect(() => new TerminalLiveDecoder().push(raw)).toThrow(/unknown/i);
  });
});
