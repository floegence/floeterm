import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const readState = (page, includeTerminalState = false) => page.evaluate(includeState => {
  const harness = window.__floetermPerfHarness;
  if (!harness) throw new Error('single-page performance harness is unavailable');
  return {
    host: harness.getSnapshot().state.dimensions,
    effective: includeState ? harness.getTerminalInfo() : null,
    geometry: harness.getGeometryDiagnostics(),
    stream: harness.getStreamDiagnostics(),
    serialized: includeState ? harness.serialize() : '',
    connected: harness.getSnapshot().connection.isConnected,
    hasError: harness.getSnapshot().state.hasError,
    alternate: includeState ? harness.getFabricDiagnostics().sourceGrid : null,
  };
}, includeTerminalState);

const setTerminalHostSize = async (page, width, height) => {
  await page.evaluate(({ width: nextWidth, height: nextHeight }) => {
    const host = document.querySelector('.terminalContainer');
    if (!(host instanceof HTMLElement)) throw new Error('terminal host is unavailable');
    host.style.flex = 'none';
    host.style.width = `${nextWidth}px`;
    host.style.height = `${nextHeight}px`;
    window.__floetermPerfHarness.forceResize();
  }, { width, height });
};

const waitForConvergence = async (page, previousGeneration) => {
  let converged = null;
  await expect.poll(async () => {
    const state = await readState(page);
    const ok = state.connected
      && !state.hasError
      && state.geometry.cols === state.host.cols
      && state.geometry.rows === state.host.rows
      && state.geometry.generation > previousGeneration;
    if (ok) converged = state;
    return ok;
  }).toBe(true);
  return converged;
};

const historyContains = async (request, sessionId, marker) => {
  let startSequence = 1;
  let historyGeneration = 0;
  const chunks = [];
  for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
    const response = await request.get(
      `/api/sessions/${encodeURIComponent(sessionId)}/history?startSeq=${startSequence}&endSeq=-1&historyGeneration=${historyGeneration}&maxBytes=524288`,
    );
    if (!response.ok()) return false;
    const page = await response.json();
    historyGeneration = page.historyGeneration;
    if (page.historyReset) {
      startSequence = page.firstRetainedSequence || 1;
      chunks.length = 0;
      continue;
    }
    chunks.push(...page.chunks.map(chunk => Buffer.from(chunk.data, 'base64')));
    if (!page.hasMore) break;
    startSequence = page.nextStartSequence;
  }
  return Buffer.concat(chunks).includes(Buffer.from(marker));
};

test('keeps real macOS top correct across repeated terminal resizes', async ({ page, request }, testInfo) => {
  test.skip(process.platform !== 'darwin', 'real top resize coverage requires macOS top');
  test.slow();
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]')
    .getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);

  await page.evaluate(() => {
    window.__floetermPerfHarness.resetStreamDiagnostics();
    window.__floetermPerfHarness.sendInput('top -s 1\r');
  });
  await expect.poll(async () => {
    const response = await request.get('/api/sessions');
    const sessions = await response.json();
    const session = sessions.find(item => item.id === sessionId);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.foregroundCommand?.displayName ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('running:top:streaming');

  const vector = [
    [1100, 620], [760, 460], [1280, 720], [640, 420], [980, 560],
    [700, 500], [1180, 680], [820, 440], [1040, 600], [900, 520],
  ];
  const performanceVector = [...vector, ...vector.slice().reverse().slice(1), vector[1]];
  const resizeSamples = [];
  let state = await readState(page);
  let generation = state.geometry.generation;
  for (const [width, height] of performanceVector) {
    const startedAt = performance.now();
    await setTerminalHostSize(page, width, height);
    state = await waitForConvergence(page, generation);
    resizeSamples.push(performance.now() - startedAt);
    generation = state.geometry.generation;
  }
  expect(resizeSamples).toHaveLength(20);
  for (const sample of resizeSamples) {
    expect(sample).toBeLessThan(150);
  }
  await testInfo.attach('top-resize-performance.json', {
    body: Buffer.from(JSON.stringify({ thresholdMs: 150, samplesMs: resizeSamples }, null, 2)),
    contentType: 'application/json',
  });
  for (const [width, height] of vector.slice().reverse()) {
    await setTerminalHostSize(page, width, height);
  }
  state = await waitForConvergence(page, generation);
  await expect.poll(async () => {
    const sessions = await request.get('/api/sessions').then(response => response.json());
    const session = sessions.find(item => item.id === sessionId);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.foregroundCommand?.displayName ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('running:top:streaming');
  expect(state.stream.sequenceGaps).toBe(0);
  await expect.poll(() => historyContains(request, sessionId, 'Processes:')).toBe(true);
  state = await readState(page, true);
  expect(state.serialized.length).toBeGreaterThan(0);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);

  const exitMarker = `FLOETERM_TOP_EXIT_${Date.now()}`;
  const exitMarkerHex = Buffer.from(exitMarker).toString('hex');
  await page.evaluate(markerHex => {
    const command = [
      'python3 -c "import os;',
      `s=os.get_terminal_size(0);os.write(1,bytes.fromhex('${markerHex}')+f' {s.lines} {s.columns}\\n'.encode())"`,
    ].join('');
    window.__floetermPerfHarness.sendInput(`\x03${command}\r`);
  }, exitMarkerHex);
  await page.waitForFunction(marker => window.__floetermPerfHarness.serialize().includes(marker), exitMarker);
  await expect.poll(() => historyContains(request, sessionId, exitMarker)).toBe(true);
  const finalState = await readState(page, true);
  expect(finalState.stream.sequenceGaps).toBe(0);
  expect(finalState.serialized).toContain(exitMarker);
  expect(finalState.serialized).toContain(`${finalState.effective.rows} ${finalState.effective.cols}`);
  expect(finalState.connected).toBe(true);
  expect(finalState.hasError).toBe(false);
  expect(failures).toEqual([]);
});
