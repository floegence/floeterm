import assert from 'node:assert/strict';
import test from 'node:test';

import {
  waitForInteractiveShell,
} from '../support/sessionReadiness.mjs';

const readyPresentation = {
  sequence: 3,
  state: { sequence: 3 },
  geometry: { cols: 80, rows: 24 },
  frame: { width: 80, height: 24 },
};

test('waits for an idle session with a connected semantic Presentation', async t => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  t.after(() => { globalThis.fetch = originalFetch; });
  t.after(() => { globalThis.window = originalWindow; });
  globalThis.window = {
    __floetermPerfHarness: {
      getSnapshot: () => ({ connection: { isConnected: true } }),
      getPresentationDiagnostics: () => readyPresentation,
    },
  };
  globalThis.fetch = async url => {
    if (url === '/api/sessions') {
      return { ok: true, json: async () => [{ id: 'session', isActive: true, foregroundCommand: { phase: 'idle' } }] };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const page = { waitForFunction: async (callback, argument) => assert.equal(await callback(argument), true) };

  await waitForInteractiveShell(page, 'session');
});

test('does not accept a connected session without a valid semantic Presentation', async t => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  t.after(() => { globalThis.fetch = originalFetch; });
  t.after(() => { globalThis.window = originalWindow; });
  globalThis.window = {
    __floetermPerfHarness: {
      getSnapshot: () => ({ connection: { isConnected: true } }),
      getPresentationDiagnostics: () => null,
    },
  };
  globalThis.fetch = async url => {
    if (url === '/api/sessions') {
      return { ok: true, json: async () => [{ id: 'session', isActive: true, foregroundCommand: { phase: 'idle' } }] };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const page = { waitForFunction: async (callback, argument) => assert.equal(await callback(argument), false) };
  await waitForInteractiveShell(page, 'session');
});
