import { describe, expect, it } from 'vitest';
import { concatChunks } from './history';

describe('concatChunks', () => {
  it('concatenates byte arrays in order', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3]);
    const c = new Uint8Array([4, 5]);

    const merged = concatChunks([a, b, c]);
    expect(Array.from(merged)).toEqual([1, 2, 3, 4, 5]);
  });
});
