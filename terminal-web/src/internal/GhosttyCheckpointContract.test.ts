import { describe, expect, it } from 'vitest';

describe('published Ghostty checkpoint contract', () => {
  it('exposes the versioned same-engine checkpoint API', async () => {
    const ghostty = await import('@floegence/ghostty-web') as typeof import('@floegence/ghostty-web');
    const checkpointApi = ghostty.GhosttyTerminal.prototype as typeof ghostty.GhosttyTerminal.prototype & {
      getCheckpointFormatVersion?: () => number;
      captureCheckpoint?: (...args: unknown[]) => unknown;
      validateCheckpoint?: (bytes: Uint8Array) => unknown;
      restoreCheckpoint?: (...args: unknown[]) => unknown;
    };

    expect(checkpointApi.getCheckpointFormatVersion).toEqual(expect.any(Function));
    expect(checkpointApi.captureCheckpoint).toEqual(expect.any(Function));
    expect(checkpointApi.validateCheckpoint).toEqual(expect.any(Function));
    expect(checkpointApi.restoreCheckpoint).toEqual(expect.any(Function));
  });
});
