import assert from 'node:assert/strict';
import test from 'node:test';

import {
  containsInteractivePromptMarker,
  waitForInteractiveShell,
} from '../support/sessionReadiness.mjs';

test('recognizes an interactive prompt marker split across history chunks', () => {
  const chunks = [
    Buffer.from('before\x1b]633;'),
    Buffer.from('A\x07after'),
  ].map(data => ({ data: data.toString('base64') }));

  assert.equal(containsInteractivePromptMarker(chunks), true);
});

test('rejects idle startup output without an interactive prompt marker', () => {
  const chunks = [Buffer.from('/usr/local/bin/codex\r\n').toString('base64')]
    .map(data => ({ data }));

  assert.equal(containsInteractivePromptMarker(chunks), false);
});

test('recognizes the compatible OSC 133 prompt marker', () => {
  const chunks = [Buffer.from('\x1b]133;A\x1b\\').toString('base64')]
    .map(data => ({ data }));

  assert.equal(containsInteractivePromptMarker(chunks), true);
});

test('waits through a history reset and follows pagination to the prompt marker', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const historyResponses = [
    {
      historyGeneration: 2,
      historyReset: true,
      firstRetainedSequence: 7,
      snapshotEndSequence: 8,
      chunks: [],
      hasMore: true,
      nextStartSequence: 7,
    },
    {
      historyGeneration: 2,
      historyReset: false,
      snapshotEndSequence: 8,
      chunks: [{ data: Buffer.from('before\x1b]633;').toString('base64') }],
      hasMore: true,
      nextStartSequence: 8,
    },
    {
      historyGeneration: 2,
      historyReset: false,
      snapshotEndSequence: 8,
      chunks: [{ data: Buffer.from('A\x07after').toString('base64') }],
      hasMore: false,
      nextStartSequence: 9,
    },
  ];
  const requestedHistoryURLs = [];
  globalThis.fetch = async url => {
    if (url === '/api/sessions') {
      return { ok: true, json: async () => [{ id: 'session', isActive: true, foregroundCommand: { phase: 'idle' } }] };
    }
    requestedHistoryURLs.push(String(url));
    const body = historyResponses.shift();
    return { ok: true, json: async () => body };
  };
  const page = {
    exposeFunction: async (name, callback) => { globalThis[name] = callback; },
    waitForFunction: async (callback, argument) => {
      assert.equal(await callback(argument), true);
    },
  };

  await waitForInteractiveShell(page, 'session');

  assert.equal(historyResponses.length, 0);
  assert.match(requestedHistoryURLs[1], /startSeq=7/);
  assert.match(requestedHistoryURLs[2], /startSeq=8/);
});

test('follows more than sixteen advancing history pages without a page-count cutoff', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let pageIndex = 0;
  globalThis.fetch = async url => {
    if (url === '/api/sessions') {
      return { ok: true, json: async () => [{ id: 'session', isActive: true, foregroundCommand: { phase: 'idle' } }] };
    }
    pageIndex += 1;
    const isLast = pageIndex === 18;
    return {
      ok: true,
      json: async () => ({
        historyGeneration: 1,
        historyReset: false,
        snapshotEndSequence: 18,
        chunks: [{ data: Buffer.from(isLast ? '\x1b]633;A\x07' : `page-${pageIndex}`).toString('base64') }],
        hasMore: !isLast,
        nextStartSequence: pageIndex + 1,
      }),
    };
  };
  const page = {
    exposeFunction: async (name, callback) => { globalThis[name] = callback; },
    waitForFunction: async (callback, argument) => assert.equal(await callback(argument), true),
  };

  await waitForInteractiveShell(page, 'session');

  assert.equal(pageIndex, 18);
});

test('fails closed when the history cursor does not advance', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async url => {
    if (url === '/api/sessions') {
      return { ok: true, json: async () => [{ id: 'session', isActive: true, foregroundCommand: { phase: 'idle' } }] };
    }
    return {
      ok: true,
      json: async () => ({
        historyGeneration: 1,
        historyReset: false,
        snapshotEndSequence: 2,
        chunks: [],
        hasMore: true,
        nextStartSequence: 1,
      }),
    };
  };
  const page = {
    exposeFunction: async (name, callback) => { globalThis[name] = callback; },
    waitForFunction: async (callback, argument) => callback(argument),
  };

  await assert.rejects(
    waitForInteractiveShell(page, 'session'),
    /history cursor did not advance/,
  );
});
