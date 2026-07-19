// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { TerminalState } from '../types';
import { TerminalCore } from './TerminalCore';

type fake_line = { translateToString: (trimRight?: boolean) => string };

const makeFakeTerminal = (lines: string[]) => {
  return {
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        length: lines.length,
        getLine: (y: number): fake_line | undefined => {
          const value = lines[y];
          if (typeof value !== 'string') return undefined;
          return {
            translateToString: () => value,
          };
        },
      },
    },
  };
};

describe('TerminalCore search scanning', () => {
  it('splits fuzzy search tokens by whitespace and matches in-order spans', () => {
    const core = new TerminalCore(document.createElement('div'));
    (core as any).terminal = makeFakeTerminal(['foo   bar']);

    const matches = (core as any).scanTerminalMatches('foo bar');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ row: 0, col: 0, len: 9 });
  });

  it('reads buffer lines through a public safe API', () => {
    const core = new TerminalCore(document.createElement('div'));
    (core as any).terminal = makeFakeTerminal(['alpha', 'beta']);

    expect(core.readBufferLine(1)).toBe('beta');
    expect(core.readBufferLine(-1)).toBe('');
    expect(core.readBufferLines(0, 1)).toEqual([
      { row: 0, text: 'alpha' },
      { row: 1, text: 'beta' },
    ]);
  });

  it('returns safe empty values when buffer access fails during remount races', () => {
    const core = new TerminalCore(document.createElement('div'));
    (core as any).terminal = {
      buffer: {
        active: {
          getLine: () => {
            throw new Error('disposed');
          },
        },
      },
    };

    expect(core.readBufferLine(0)).toBe('');
    expect(core.readBufferLines(0, 0)).toEqual([]);
  });

  it('exposes touch scroll operations without requiring consumers to access internals', () => {
    const core = new TerminalCore(document.createElement('div'));
    const scrollLines = vi.fn();
    const input = vi.fn();
    (core as any).terminal = {
      scrollLines,
      getScrollbackLength: () => 42,
      isAlternateScreen: () => true,
      input,
    };

    const runtime = core.getTouchScrollRuntime();

    expect(runtime?.getScrollbackLength()).toBe(42);
    expect(runtime?.isAlternateScreen()).toBe(true);
    expect(runtime?.scrollLines(3)).toBe(true);
    runtime?.sendAlternateScreenInput('\x1B[A');
    expect(scrollLines).toHaveBeenCalledWith(3);
    expect(input).toHaveBeenCalledWith('\x1B[A', true);
  });

  it('captures bounded in-memory snapshots with sequence coverage and resource estimates', () => {
    const core = new TerminalCore(document.createElement('div'));
    (core as any).terminal = makeFakeTerminal(['alpha', 'beta', 'gamma']);
    (core as any).state = TerminalState.READY;

    const snapshot = core.captureRestorableSnapshot({
      coveredThroughSequence: 42,
      maxBytes: 16,
      now: () => 100,
    });
    const estimate = core.getResourceEstimate();

    expect(snapshot).toEqual(expect.objectContaining({
      version: 1,
      partial: true,
      coveredThroughSequence: 42,
      createdAtMs: 100,
    }));
    expect(snapshot?.byteLength).toBeLessThanOrEqual(16);
    expect(estimate.bufferBytes).toBeGreaterThan(0);
    expect(estimate.cellCount).toBe(240);
    expect(estimate.estimatedBytes).toBeGreaterThan(estimate.bufferBytes);
  });

  it('restores compatible snapshots with an explicit full repaint and rejects incompatible versions', async () => {
    const core = new TerminalCore(document.createElement('div'));
    (core as any).terminal = makeFakeTerminal(['alpha']);
    (core as any).state = TerminalState.READY;
    let fullRepaintRequiredAtWrite = false;
    const write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
      fullRepaintRequiredAtWrite = (core as any).needsFullRenderOnNextWrite;
      callback?.();
    });
    (core as any).write = write;
    const snapshot = core.captureRestorableSnapshot({ coveredThroughSequence: 2 });

    expect(snapshot).not.toBeNull();
    await expect(core.restoreSnapshot(snapshot!)).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith(snapshot?.data, expect.any(Function));
    expect(fullRepaintRequiredAtWrite).toBe(true);
    await expect(core.restoreSnapshot({ ...snapshot!, version: 2 as 1 })).resolves.toBe(false);
  });
});
