import { describe, expect, it } from 'vitest';

import {
  TerminalLiveDecoder,
  TerminalLiveFrameType,
  decodeAttach,
  decodeInput,
  decodePresentation,
  decodeResize,
  encodeAttach,
  encodeInput,
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
  it('round trips client attach, input, and resize frames', () => {
    const decoder = new TerminalLiveDecoder();
    const frames = [
      encodeAttach({ attachGeneration: 2n, cols: 80, rows: 24, sessionId: 's', connectionId: 'c' }),
      encodeInput({ sequence: 1n, data: new TextEncoder().encode('中') }),
      encodeResize({ sequence: 2n, cols: 120, rows: 40 }),
    ].flatMap(encoded => decoder.push(encoded));
    expect(decodeAttach(frames[0]!)).toMatchObject({ attachGeneration: 2n, cols: 80, rows: 24 });
    expect(new TextDecoder().decode(decodeInput(frames[1]!).data)).toBe('中');
    expect(decodeResize(frames[2]!)).toEqual({ sequence: 2n, cols: 120, rows: 40 });
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
        rows: [[['中', 2, 0, '']]],
        graphics: { generation: 3, images: [{ id: 7, width: 1, height: 1, format: 0, generation: 2, pixels: 'AQID' }], placements: [] },
      },
    });
    const decodedFrame = new TerminalLiveDecoder().push(encoded)[0]!;
    const decoded = decodePresentation(decodedFrame) as any;
    expect(decoded.state.contentEpoch).toBe(4);
    expect(decoded.frame.rows[0].cells[0]).toMatchObject({ text: '中', width: 2 });
    expect(decoded.frame.graphics.images[0].pixels).toEqual(new Uint8Array([1, 2, 3]));

    const raw = new Uint8Array(8);
    raw[0] = 0x82;
    expect(() => new TerminalLiveDecoder().push(raw)).toThrow(/unknown/i);
  });
});
