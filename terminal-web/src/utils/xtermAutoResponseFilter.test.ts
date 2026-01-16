import { describe, expect, it } from 'vitest';
import { filterXtermAutoResponses } from './xtermAutoResponseFilter';

describe('filterXtermAutoResponses', () => {
  it('removes CSI device attribute responses', () => {
    const input = 'hello\x1b[?1;2cworld';
    expect(filterXtermAutoResponses(input)).toBe('helloworld');
  });

  it('removes cursor position reports', () => {
    const input = 'start\x1b[12;34Rend';
    expect(filterXtermAutoResponses(input)).toBe('startend');
  });

  it('removes OSC color query responses', () => {
    const input = 'a\x1b]10;rgb:1/2/3\x07b';
    expect(filterXtermAutoResponses(input)).toBe('ab');
  });

  it('removes DCS sequences', () => {
    const input = 'x\x1bPqabc\x1b\\y';
    expect(filterXtermAutoResponses(input)).toBe('xy');
  });
});
