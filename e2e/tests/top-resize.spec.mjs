import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

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
    visibleLines: includeState ? harness.getVisibleLines() : [],
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

const setTerminalGridSize = async (page, targetCols, targetRows) => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await page.evaluate(() => {
      const host = document.querySelector('.terminalContainer');
      const snapshot = window.__floetermPerfHarness?.getSnapshot();
      if (!(host instanceof HTMLElement) || !snapshot) throw new Error('terminal host geometry is unavailable');
      const rect = host.getBoundingClientRect();
      return { width: rect.width, height: rect.height, ...snapshot.state.dimensions };
    });
    if (current.cols === targetCols && current.rows === targetRows) return;
    await setTerminalHostSize(
      page,
      Math.max(120, current.width + (targetCols - current.cols) * 7),
      Math.max(120, current.height + (targetRows - current.rows) * 14),
    );
    await page.waitForTimeout(25);
  }
  const state = await readState(page);
  throw new Error(`failed to calibrate terminal grid: got ${state.host.cols}x${state.host.rows}, want ${targetCols}x${targetRows}`);
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

const readHistoryChunks = async (request, sessionId) => {
  let startSequence = 1;
  let historyGeneration = 0;
  const chunks = [];
  for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
    const response = await request.get(
      `/api/sessions/${encodeURIComponent(sessionId)}/history?startSeq=${startSequence}&endSeq=-1&historyGeneration=${historyGeneration}&maxBytes=524288`,
    );
    expect(response.ok()).toBe(true);
    const history = await response.json();
    historyGeneration = history.historyGeneration;
    if (history.historyReset) {
      startSequence = history.firstRetainedSequence || 1;
      chunks.length = 0;
      continue;
    }
    chunks.push(...history.chunks.map(chunk => ({
      ...chunk,
      bytes: Buffer.from(chunk.data, 'base64'),
    })));
    if (!history.hasMore) break;
    startSequence = history.nextStartSequence;
  }
  return chunks;
};

const waitForAuthoritativeTopFrame = async (page, request, sessionId, geometry) => {
  let evidence = null;
  let diagnostic = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [state, chunks] = await Promise.all([
      readState(page, true),
      readHistoryChunks(request, sessionId),
    ]);
    const postBoundary = chunks.filter(chunk => (
      chunk.sequence > geometry.outputSequenceBoundary
        && chunk.geometryGeneration === geometry.generation
        && chunk.cols === geometry.cols
        && chunk.rows === geometry.rows
    ));
    const raw = Buffer.concat(postBoundary.map(chunk => chunk.bytes));
    const row0 = state.visibleLines[0] ?? '';
    const row1 = state.visibleLines[1] ?? '';
    const converged = raw.includes(Buffer.from('\x1b[H\x1b[2J'))
      && raw.includes(Buffer.from('Processes:'))
      && /\x1b\[1;\d+H\d{2}:\d{2}:\d{2}/.test(raw.toString('latin1'))
      && row0.startsWith('Processes:')
      && row1.startsWith('Load Avg:');
    diagnostic = {
      geometry,
      currentGeometry: state.geometry,
      stream: state.stream,
      visibleLines: state.visibleLines.slice(0, 8),
      postBoundary: postBoundary.map(chunk => ({
        sequence: chunk.sequence,
        generation: chunk.geometryGeneration,
        cols: chunk.cols,
        rows: chunk.rows,
        bytes: chunk.bytes.length,
      })),
      hasClearHome: raw.includes(Buffer.from('\x1b[H\x1b[2J')),
      hasProcesses: raw.includes(Buffer.from('Processes:')),
      rawTail: raw.subarray(Math.max(0, raw.length - 4096)).toString('latin1'),
    };
    if (converged) {
      evidence = { state, postBoundary, raw };
      break;
    }
    await page.waitForTimeout(100);
  }
  if (!evidence) {
    throw new Error(`authoritative top frame did not converge: ${JSON.stringify(diagnostic)}`);
  }
  return evidence;
};

const expectTopClockPixelsAtRightEdge = async (page, geometry) => {
  const surface = page.locator('.terminalSurface');
  const box = await surface.boundingBox();
  if (!box) throw new Error('terminal surface has no visible bounds');
  const screenshot = await page.screenshot({ animations: 'disabled', clip: box });
  const image = PNG.sync.read(screenshot);
  const colorCounts = new Map();
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const key = `${image.data[offset] >> 2}:${image.data[offset + 1] >> 2}:${image.data[offset + 2] >> 2}`;
    colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
  }
  const backgroundKey = [...colorCounts.entries()].sort((left, right) => right[1] - left[1])[0][0];
  const background = backgroundKey.split(':').map(value => Number(value) * 4 + 2);
  const cellWidth = (image.width - 15) / geometry.cols;
  const startX = Math.max(0, Math.floor((geometry.cols - 9) * cellWidth));
  const endY = Math.min(image.height, 20);
  let ink = 0;
  for (let y = 0; y < endY; y += 1) {
    for (let x = startX; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const distance = Math.abs(image.data[offset] - background[0])
        + Math.abs(image.data[offset + 1] - background[1])
        + Math.abs(image.data[offset + 2] - background[2]);
      if (distance > 18) ink += 1;
    }
  }
  expect(ink, JSON.stringify({ geometry, image: { width: image.width, height: image.height }, startX }))
    .toBeGreaterThan(8);
};

const assertTopKeepsAdvancingAndVisible = async (page, request, sessionId, cycles = 3) => {
  let state = await readState(page, true);
  let browserSequence = state.stream.lastSequence;
  let history = await readHistoryChunks(request, sessionId);
  let historySequence = history.at(-1)?.sequence ?? 0;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const deadline = Date.now() + 3000;
    let advanced = false;
    while (Date.now() < deadline) {
      [state, history] = await Promise.all([
        readState(page, true),
        readHistoryChunks(request, sessionId),
      ]);
      const nextHistorySequence = history.at(-1)?.sequence ?? 0;
      expect(state.visibleLines[0], `top header disappeared during refresh cycle ${cycle + 1}`).toMatch(/^Processes:/);
      expect(state.visibleLines[1], `top load row disappeared during refresh cycle ${cycle + 1}`).toMatch(/^Load Avg:/);
      expect(state.stream.sequenceGaps).toBe(0);
      if (nextHistorySequence > historySequence && state.stream.lastSequence > browserSequence) {
        historySequence = nextHistorySequence;
        browserSequence = state.stream.lastSequence;
        advanced = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    expect(advanced, `top output stalled for 3 seconds during refresh cycle ${cycle + 1}`).toBe(true);

    const authoritative = await waitForAuthoritativeTopFrame(page, request, sessionId, state.geometry);
    expect(authoritative.state.visibleLines[0]).toMatch(/^Processes:/);
    await expectTopClockPixelsAtRightEdge(page, state.geometry);
  }
};

const installPresentationTrace = async page => {
  await page.addInitScript(() => {
    const trace = [];
    const lastVisibility = new WeakMap();
    const record = node => {
      if (!(node instanceof HTMLElement) || !node.hasAttribute('data-floeterm-terminal-render-host')) return;
      const visibility = node.style.visibility;
      if (lastVisibility.get(node) === visibility) return;
      lastVisibility.set(node, visibility);
      const harness = window.__floetermPerfHarness;
      trace.push({
        visibility,
        dimensions: harness?.getSnapshot().state.dimensions ?? null,
        geometry: harness?.getGeometryDiagnostics() ?? null,
      });
    };
    const observer = new MutationObserver(records => {
      for (const mutation of records) {
        if (mutation.type === 'attributes') record(mutation.target);
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            record(node);
            node.querySelectorAll?.('[data-floeterm-terminal-render-host]').forEach(record);
          }
        }
      }
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    Object.defineProperty(window, '__floetermPresentationTrace', { value: trace, configurable: true });
  });
};

test('converges the visible real macOS top grid across exact grow shrink and rapid resizes', async ({ page, request }) => {
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

  await setTerminalGridSize(page, 199, 48);
  let state = await readState(page);
  await waitForConvergence(page, state.geometry.generation - 1);
  await page.evaluate(() => {
    window.__floetermPerfHarness.sendInput('top -s 1\r');
  });
  await expect.poll(async () => {
    const current = await readState(page, true);
    return (current.visibleLines[0] ?? '').startsWith('Processes:')
      && (current.visibleLines[1] ?? '').startsWith('Load Avg:');
  }).toBe(true);

  for (const [cols, rows] of [[102, 27], [160, 42], [88, 24], [140, 36]]) {
    const previousGeneration = (await readState(page)).geometry.generation;
    await setTerminalGridSize(page, cols, rows);
    state = await waitForConvergence(page, previousGeneration);
    expect(state.host).toEqual({ cols, rows });
    const evidence = await waitForAuthoritativeTopFrame(page, request, sessionId, state.geometry);
    expect(evidence.postBoundary.length).toBeGreaterThan(0);
    for (let index = 1; index < evidence.postBoundary.length; index += 1) {
      expect(evidence.postBoundary[index].sequence).toBe(evidence.postBoundary[index - 1].sequence + 1);
    }
    expect(evidence.state.stream.sequenceGaps).toBe(0);
    expect(evidence.state.visibleLines[0]).toMatch(/^Processes:/);
    expect(evidence.state.visibleLines[1]).toMatch(/^Load Avg:/);
    expect(evidence.state.visibleLines).toHaveLength(rows);
    await assertTopKeepsAdvancingAndVisible(page, request, sessionId);
  }

  const beforeRapidGeneration = state.geometry.generation;
  await setTerminalHostSize(page, 710, 430);
  await setTerminalHostSize(page, 1180, 680);
  await setTerminalGridSize(page, 102, 27);
  state = await waitForConvergence(page, beforeRapidGeneration);
  const rapidEvidence = await waitForAuthoritativeTopFrame(page, request, sessionId, state.geometry);
  expect(state.host).toEqual({ cols: 102, rows: 27 });
  expect(rapidEvidence.state.visibleLines[0]).toMatch(/^Processes:/);
  expect(rapidEvidence.state.visibleLines[1]).toMatch(/^Load Avg:/);
  expect(rapidEvidence.state.stream.sequenceGaps).toBe(0);
  await assertTopKeepsAdvancingAndVisible(page, request, sessionId);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(failures).toEqual([]);
});

test('keeps replay geometry hidden after top advances while the page is detached', async ({ page, request }) => {
  test.skip(process.platform !== 'darwin', 'real top refresh coverage requires macOS top');
  test.slow();
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected);
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]')
    .getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);
  await setTerminalGridSize(page, 199, 48);
  await page.evaluate(() => window.__floetermPerfHarness.sendInput('top -s 1\r'));
  await expect.poll(async () => {
    const current = await readState(page, true);
    return (current.visibleLines[0] ?? '').startsWith('Processes:')
      && (current.visibleLines[1] ?? '').startsWith('Load Avg:');
  }).toBe(true);
  await setTerminalGridSize(page, 102, 27);
  const beforeRefresh = await readState(page);
  await waitForAuthoritativeTopFrame(page, request, sessionId, beforeRefresh.geometry);

  const beforeDetachChunks = await readHistoryChunks(request, sessionId);
  const beforeDetachSequence = beforeDetachChunks.at(-1)?.sequence ?? 0;
  await page.goto('about:blank');
  await expect.poll(async () => {
    const chunks = await readHistoryChunks(request, sessionId);
    return (chunks.at(-1)?.sequence ?? 0) - beforeDetachSequence;
  }, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

  await installPresentationTrace(page);
  await page.goto(`/?mode=single&session=${encodeURIComponent(sessionId)}&perf_probe=1`);
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getSnapshot().loadingState === 'ready'
  ));
  const refreshed = await readState(page, true);
  const trace = await page.evaluate(() => window.__floetermPresentationTrace ?? []);
  const visibleTransitions = trace.filter(event => event.visibility !== 'hidden');

  expect(trace.length).toBeGreaterThanOrEqual(2);
  expect(trace[0]?.visibility).toBe('hidden');
  expect(visibleTransitions).toHaveLength(1);
  expect(visibleTransitions[0]?.dimensions).toEqual(refreshed.host);
  expect(visibleTransitions[0]?.geometry?.cols).toBe(refreshed.host.cols);
  expect(visibleTransitions[0]?.geometry?.rows).toBe(refreshed.host.rows);
  expect(refreshed.visibleLines[0]).toMatch(/^Processes:/);
  expect(refreshed.visibleLines[1]).toMatch(/^Load Avg:/);
  await waitForAuthoritativeTopFrame(page, request, sessionId, refreshed.geometry);
  await expectTopClockPixelsAtRightEdge(page, refreshed.geometry);
  await assertTopKeepsAdvancingAndVisible(page, request, sessionId);

  const beforePostRefreshResize = refreshed.geometry.generation;
  await setTerminalGridSize(page, 140, 36);
  const resized = await waitForConvergence(page, beforePostRefreshResize);
  const resizedEvidence = await waitForAuthoritativeTopFrame(page, request, sessionId, resized.geometry);
  expect(resizedEvidence.state.visibleLines[0]).toMatch(/^Processes:/);
  expect(resizedEvidence.state.visibleLines[1]).toMatch(/^Load Avg:/);
  await expectTopClockPixelsAtRightEdge(page, resized.geometry);
  expect(resizedEvidence.state.stream.sequenceGaps).toBe(0);
  await assertTopKeepsAdvancingAndVisible(page, request, sessionId);
  expect(failures).toEqual([]);
});

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
