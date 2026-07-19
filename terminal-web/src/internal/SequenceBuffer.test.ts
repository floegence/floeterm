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

  it('retains far-ahead chunks until every preceding sequence arrives', () => {
    const buffer = new SequenceBuffer();
    buffer.reset(1);

    expect(buffer.push(makeChunk(5, 'e'))).toEqual([]);
    expect(buffer.push(makeChunk(1, 'a')).map(chunk => chunk.sequence)).toEqual([1]);
    expect(buffer.push(makeChunk(2, 'b')).map(chunk => chunk.sequence)).toEqual([2]);
    expect(buffer.push(makeChunk(3, 'c')).map(chunk => chunk.sequence)).toEqual([3]);
    expect(buffer.push(makeChunk(4, 'd')).map(chunk => chunk.sequence)).toEqual([4, 5]);
  });

  it('accepts non-sequenced chunks', () => {
    const buffer = new SequenceBuffer();
    const ready = buffer.push(makeChunk(0, 'x'));
    expect(ready.map(chunk => chunk.sequence)).toEqual([0]);
  });

  it('does not use elapsed time to infer a missing sequence', () => {
    const buffer = new SequenceBuffer();
    buffer.reset(1);

    expect(buffer.push(makeChunk(2, 'b'), 0)).toEqual([]);
    expect(buffer.push(makeChunk(3, 'c'), 60_000)).toEqual([]);
    expect(buffer.push(makeChunk(1, 'a'), 60_001).map(chunk => chunk.sequence)).toEqual([1, 2, 3]);
  });

  it('reports a replay boundary gap instead of skipping it', () => {
    const buffer = new SequenceBuffer({ maxPendingChunks: 4, maxPendingBytes: 1024 });
    buffer.reset(1);

    expect(buffer.push(makeChunk(2, 'b'))).toEqual([]);
    expect(buffer.push(makeChunk(4, 'd'))).toEqual([]);

    expect(() => buffer.assertCoveredThrough(4)).toThrow(/missing terminal output sequence 1/i);
    expect(buffer.flushPending()).toEqual([]);
  });

  it('accepts explicit history coverage and releases buffered live output', () => {
    const buffer = new SequenceBuffer();
    buffer.reset(1);

    expect(buffer.push(makeChunk(5, 'live'))).toEqual([]);
    expect(buffer.coverThrough(4).map(chunk => chunk.sequence)).toEqual([5]);
    expect(() => buffer.assertCoveredThrough(5)).not.toThrow();
  });

  it('rejects pending output that exceeds the explicit memory bound', () => {
    const buffer = new SequenceBuffer({ maxPendingChunks: 2, maxPendingBytes: 2 });
    buffer.reset(1);

    expect(buffer.push(makeChunk(2, 'b'))).toEqual([]);
    expect(buffer.push(makeChunk(3, 'c'))).toEqual([]);
    expect(() => buffer.push(makeChunk(4, 'd'))).toThrow(/queue limit/i);
  });
});
