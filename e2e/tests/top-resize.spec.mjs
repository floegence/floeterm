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
    alternate: includeState ? harness.getPresentationDiagnostics?.()?.frame.bufferKind ?? null : null,
  };
}, includeTerminalState);

const setTerminalHostSize = async (page, width, height) => {
  return await page.evaluate(({ width: nextWidth, height: nextHeight }) => {
    const host = document.querySelector('.terminalContainer');
    if (!(host instanceof HTMLElement)) throw new Error('terminal host is unavailable');
    host.style.flex = 'none';
    host.style.width = `${nextWidth}px`;
    host.style.height = `${nextHeight}px`;
    const startedAt = performance.now();
    window.__floetermPerfHarness.forceResize();
    return performance.now() - startedAt;
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
  try {
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
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      presentation: window.__floetermPerfHarness?.getPresentationDiagnostics?.() ?? null,
      resize: window.__floetermPerfHarness?.getResizeDiagnostics?.() ?? [],
    }));
    throw new Error(`terminal resize did not converge: ${JSON.stringify({
      previousGeneration,
      state: await readState(page, true),
      diagnostic,
    })}`, { cause: error });
  }
  return converged;
};

const semanticHistoryContains = async (page, marker) => page.evaluate(async expected => {
  try {
    const history = await window.__floetermPerfHarness?.readSemanticHistory('end');
    return history?.frame.rows
      .map(row => row.cells.map(cell => cell.text).join(''))
      .join('\n')
      .includes(expected) ?? false;
  } catch (error) {
    if (/semantic history revision is stale/.test(String(error))) return false;
    throw error;
  }
}, marker);

const waitForAuthoritativeTopFrame = async (page, geometry) => {
  let evidence = null;
  let diagnostic = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await readState(page, true);
    const presentation = await page.evaluate(() => window.__floetermPerfHarness?.getPresentationDiagnostics?.() ?? null);
    const row0 = state.visibleLines[0] ?? '';
    const row1 = state.visibleLines[1] ?? '';
    const converged = presentation?.sequence > geometry.presentationSequence
      && presentation.geometry.generation === geometry.generation
      && presentation.geometry.cols === geometry.cols
      && presentation.geometry.rows === geometry.rows
      && presentation.frame.width === geometry.cols
      && presentation.frame.height === geometry.rows
      && row0.startsWith('Processes:')
      && row1.startsWith('Load Avg:');
    diagnostic = {
      geometry,
      currentGeometry: state.geometry,
      stream: state.stream,
      visibleLines: state.visibleLines.slice(0, 8),
      presentation: presentation && {
        sequence: presentation.sequence,
        geometry: presentation.geometry,
        frame: { width: presentation.frame.width, height: presentation.frame.height },
      },
    };
    if (converged) {
      evidence = {
        state,
        presentation,
        postBoundary: [{
          sequence: presentation.sequence,
          geometryGeneration: presentation.geometry.generation,
          cols: presentation.geometry.cols,
          rows: presentation.geometry.rows,
        }],
      };
      break;
    }
    await page.waitForTimeout(100);
  }
  if (!evidence) {
    throw new Error(`authoritative top frame did not converge: ${JSON.stringify(diagnostic)}`);
  }
  return evidence;
};

const waitForSemanticTopPresentation = async (page, geometry) => {
  let evidence = null;
  await expect.poll(async () => {
    const state = await readState(page, true);
    const presentation = await page.evaluate(() => window.__floetermPerfHarness?.getPresentationDiagnostics?.() ?? null);
    const converged = presentation?.geometry.generation === geometry.generation
      && presentation.geometry.cols === geometry.cols
      && presentation.geometry.rows === geometry.rows
      && presentation.frame.width === geometry.cols
      && presentation.frame.height === geometry.rows
      && presentation.sequence === presentation.state.sequence
      && (state.visibleLines[0] ?? '').startsWith('Processes:')
      && (state.visibleLines[1] ?? '').startsWith('Load Avg:');
    if (converged) evidence = { state, presentation };
    return converged;
  }).toBe(true);
  return evidence;
};

const expectTopClockPixelsAtRightEdge = async (page, geometry) => {
  const surface = page.locator('.terminalPane');
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

const assertTopKeepsAdvancingAndVisible = async (page, cycles = 3) => {
  let state = await readState(page, true);
  let browserSequence = state.stream.lastSequence;
  let presentationSequence = (await page.evaluate(() => window.__floetermPerfHarness?.getPresentationDiagnostics?.()?.sequence ?? 0));
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const deadline = Date.now() + 3000;
    let advanced = false;
    while (Date.now() < deadline) {
      state = await readState(page, true);
      const nextPresentationSequence = await page.evaluate(() => window.__floetermPerfHarness?.getPresentationDiagnostics?.()?.sequence ?? 0);
      expect(state.visibleLines[0], `top header disappeared during refresh cycle ${cycle + 1}`).toMatch(/^Processes:/);
      expect(state.visibleLines[1], `top load row disappeared during refresh cycle ${cycle + 1}`).toMatch(/^Load Avg:/);
      expect(state.stream.sequenceGaps).toBe(0);
      if (nextPresentationSequence > presentationSequence && state.stream.lastSequence > browserSequence) {
        presentationSequence = nextPresentationSequence;
        browserSequence = state.stream.lastSequence;
        advanced = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    expect(advanced, `top output stalled for 3 seconds during refresh cycle ${cycle + 1}`).toBe(true);

    const authoritative = await waitForSemanticTopPresentation(page, state.geometry);
    expect(authoritative.state.visibleLines[0]).toMatch(/^Processes:/);
    await expectTopClockPixelsAtRightEdge(page, state.geometry);
  }
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
    const evidence = await waitForAuthoritativeTopFrame(page, state.geometry);
    expect(evidence.postBoundary.length).toBeGreaterThan(0);
    for (let index = 1; index < evidence.postBoundary.length; index += 1) {
      expect(evidence.postBoundary[index].sequence).toBe(evidence.postBoundary[index - 1].sequence + 1);
    }
    expect(evidence.state.stream.sequenceGaps).toBe(0);
    expect(evidence.state.visibleLines[0]).toMatch(/^Processes:/);
    expect(evidence.state.visibleLines[1]).toMatch(/^Load Avg:/);
    expect(evidence.state.visibleLines).toHaveLength(rows);
    await assertTopKeepsAdvancingAndVisible(page);
  }

  const beforeRapidGeneration = state.geometry.generation;
  for (let index = 0; index < 60; index += 1) {
    await page.setViewportSize({
      width: 760 + (index % 7) * 131,
      height: 480 + (index % 5) * 97,
    });
    const surfaceFits = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
      const pane = document.querySelector('.terminalPane');
      const canvas = document.querySelector('.semanticTerminalSurface');
      if (!(pane instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
        resolve(false);
        return;
      }
      const canvasRect = canvas.getBoundingClientRect();
      resolve(document.querySelectorAll('.terminalPane canvas').length === 1
        && document.querySelectorAll('.terminalRendererError').length === 0
        && Math.abs(canvasRect.width - pane.clientWidth) < 1
        && Math.abs(canvasRect.height - pane.clientHeight) < 1);
    })));
    expect(surfaceFits, `top surface did not follow browser resize ${index + 1}`).toBe(true);
  }
  await setTerminalGridSize(page, 102, 27);
  state = await waitForConvergence(page, beforeRapidGeneration);
  const rapidEvidence = await waitForAuthoritativeTopFrame(page, state.geometry);
  expect(state.host).toEqual({ cols: 102, rows: 27 });
  expect(rapidEvidence.state.visibleLines[0]).toMatch(/^Processes:/);
  expect(rapidEvidence.state.visibleLines[1]).toMatch(/^Load Avg:/);
  expect(rapidEvidence.state.stream.sequenceGaps).toBe(0);
  await assertTopKeepsAdvancingAndVisible(page);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(failures).toEqual([]);
});

test('reconnects top from the latest semantic presentation after detached output advances', async ({ page, request }) => {
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
  const beforeRefreshEvidence = await waitForAuthoritativeTopFrame(page, beforeRefresh.geometry);
  const beforeDetachSequence = beforeRefreshEvidence.presentation.sequence;
  await page.goto('about:blank');
  await page.waitForTimeout(3500);

  await page.goto(`/?mode=single&session=${encodeURIComponent(sessionId)}&perf_probe=1`);
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));
  const refreshed = await readState(page, true);
  const semanticSurface = await page.evaluate(() => {
    const pane = document.querySelector('.terminalPane');
    const canvas = document.querySelector('.semanticTerminalSurface');
    if (!(pane instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return null;
    return {
      canvases: document.querySelectorAll('.terminalPane canvas').length,
      errors: document.querySelectorAll('.terminalRendererError').length,
      pane: { width: pane.clientWidth, height: pane.clientHeight },
      canvas: { width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height },
    };
  });
  expect(semanticSurface).toMatchObject({ canvases: 1, errors: 0 });
  expect(semanticSurface.canvas).toEqual(semanticSurface.pane);
  expect(refreshed.geometry.cols).toBe(refreshed.host.cols);
  expect(refreshed.geometry.rows).toBe(refreshed.host.rows);
  const reconnected = await waitForSemanticTopPresentation(page, refreshed.geometry);
  expect(reconnected.state.visibleLines[0]).toMatch(/^Processes:/);
  expect(reconnected.state.visibleLines[1]).toMatch(/^Load Avg:/);
  await expectTopClockPixelsAtRightEdge(page, reconnected.state.geometry);
  expect(reconnected.presentation.sequence).toBeGreaterThan(beforeDetachSequence);
  await assertTopKeepsAdvancingAndVisible(page);

  const beforePostRefreshResize = refreshed.geometry.generation;
  await setTerminalGridSize(page, 140, 36);
  const resized = await waitForConvergence(page, beforePostRefreshResize);
  const resizedEvidence = await waitForAuthoritativeTopFrame(page, resized.geometry);
  expect(resizedEvidence.state.visibleLines[0]).toMatch(/^Processes:/);
  expect(resizedEvidence.state.visibleLines[1]).toMatch(/^Load Avg:/);
  await expectTopClockPixelsAtRightEdge(page, resized.geometry);
  expect(resizedEvidence.state.stream.sequenceGaps).toBe(0);
  await assertTopKeepsAdvancingAndVisible(page);
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
  const dispatchSamples = [];
  let state = await readState(page);
  let generation = state.geometry.generation;
  for (const [width, height] of performanceVector) {
    const startedAt = performance.now();
    dispatchSamples.push(await setTerminalHostSize(page, width, height));
    state = await waitForConvergence(page, generation);
    resizeSamples.push(performance.now() - startedAt);
    generation = state.geometry.generation;
  }
  expect(resizeSamples).toHaveLength(20);
  await testInfo.attach('top-resize-performance.json', {
    body: Buffer.from(JSON.stringify({ thresholdMs: 150, samplesMs: resizeSamples, dispatchMs: dispatchSamples }, null, 2)),
    contentType: 'application/json',
  });
  for (const [index, sample] of resizeSamples.entries()) {
    expect(sample, `resize sample ${index + 1}: ${JSON.stringify({ resizeSamples, dispatchSamples })}`).toBeLessThan(150);
  }
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
  await expect.poll(() => semanticHistoryContains(page, 'Processes:')).toBe(true);
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
  await expect.poll(() => semanticHistoryContains(page, exitMarker)).toBe(true);
  const finalState = await readState(page, true);
  expect(finalState.stream.sequenceGaps).toBe(0);
  expect(finalState.serialized).toContain(exitMarker);
  expect(finalState.serialized).toContain(`${finalState.effective.rows} ${finalState.effective.cols}`);
  expect(finalState.connected).toBe(true);
  expect(finalState.hasError).toBe(false);
  expect(failures).toEqual([]);
});
