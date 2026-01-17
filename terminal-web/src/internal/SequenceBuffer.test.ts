import { describe, expect, it } from 'vitest';
import { SequenceBuffer } from './SequenceBuffer';

describe('SequenceBuffer', () => {
  const makeChunk = (sequence: number, payload: string) => ({
    sequence,
    data: new TextEncoder().encode(payload),
    timestampMs: Date.now()
  });

  it('returns chunks in order when sequences are contiguous', () => {
    const buffer = new SequenceBuffer();
    buffer.reset(1);

    const ready1 = buffer.push(makeChunk(1, 'a'));
    const ready2 = buffer.push(makeChunk(2, 'b'));

    expect(ready1.map(chunk => chunk.sequence)).toEqual([1]);
    expect(ready2.map(chunk => chunk.sequence)).toEqual([2]);
  });

  it('buffers out-of-order chunks and releases them when the gap closes', () => {
    const buffer = new SequenceBuffer();
    buffer.reset(1);

    const pending = buffer.push(makeChunk(2, 'b'));
    expect(pending).toEqual([]);

    const ready = buffer.push(makeChunk(1, 'a'));
    expect(ready.map(chunk => chunk.sequence)).toEqual([1, 2]);
  });

  it('returns far-ahead chunks immediately and resets expectation', () => {
    const buffer = new SequenceBuffer({ maxSequenceGap: 1 });
    buffer.reset(1);

    const ready = buffer.push(makeChunk(5, 'e'));
    expect(ready.map(chunk => chunk.sequence)).toEqual([5]);

    const next = buffer.push(makeChunk(6, 'f'));
    expect(next.map(chunk => chunk.sequence)).toEqual([6]);
  });

  it('accepts non-sequenced chunks', () => {
    const buffer = new SequenceBuffer();
    const ready = buffer.push(makeChunk(0, 'x'));
    expect(ready.map(chunk => chunk.sequence)).toEqual([0]);
  });

  it('flushes stalled gaps to avoid blocking forever', () => {
    const buffer = new SequenceBuffer({ maxStallMs: 10 });
    buffer.reset(1);

    expect(buffer.push(makeChunk(2, 'b'), 0)).toEqual([]);
    expect(buffer.push(makeChunk(3, 'c'), 11).map(chunk => chunk.sequence)).toEqual([2, 3]);
  });
});
