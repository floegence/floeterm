import { describe, expect, it, vi } from 'vitest';
import { resolveGhosttyRuntime } from './TerminalResourceLoader';

const runtimeModule = () => ({
  Terminal: class {},
  FitAddon: class {},
  LinkDetector: class {},
  OSC8LinkProvider: class {},
  UrlRegexProvider: class {},
  init: vi.fn().mockResolvedValue(undefined),
});

describe('resolveGhosttyRuntime', () => {
  it('returns a complete runtime export set', () => {
    const runtime = runtimeModule();

    expect(resolveGhosttyRuntime(runtime as never)).toEqual(runtime);
  });

  it.each(['Terminal', 'FitAddon', 'LinkDetector', 'OSC8LinkProvider', 'UrlRegexProvider', 'init'] as const)(
    'rejects a module without the %s export before it is cached',
    (missingExport) => {
      const runtime = runtimeModule();
      Reflect.deleteProperty(runtime, missingExport);

      expect(() => resolveGhosttyRuntime(runtime as never))
        .toThrow(`ghostty-web is missing the required ${missingExport} export`);
    },
  );
});
