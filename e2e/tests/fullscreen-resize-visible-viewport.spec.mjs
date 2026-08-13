import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const readState = page => page.evaluate(() => {
  const harness = window.__floetermPerfHarness;
  const canvas = document.querySelector('.semanticTerminalSurface');
  const surface = document.querySelector('.semanticTerminalSurface');
  if (!harness || !(canvas instanceof HTMLCanvasElement) || !(surface instanceof HTMLElement)) {
    throw new Error('terminal viewport diagnostics are unavailable');
  }
  const canvasRect = canvas.getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  return {
    connected: harness.getSnapshot().connection.isConnected,
    hasError: harness.getSnapshot().state.hasError,
    host: harness.getSnapshot().state.dimensions,
    effective: harness.getTerminalInfo(),
    geometry: harness.getGeometryDiagnostics(),
    stream: harness.getStreamDiagnostics(),
    serialized: harness.serialize(),
    canvasTop: canvasRect.top,
    canvasLeft: canvasRect.left,
    surfaceTop: surfaceRect.top,
    surfaceLeft: surfaceRect.left,
    backingHeight: canvas.height / devicePixelRatio,
    logicalHeight: surface.clientHeight,
  };
});

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

const readHistory = async (request, sessionId) => {
  const response = await request.get(
    `/api/sessions/${encodeURIComponent(sessionId)}/history?startSeq=1&endSeq=-1&historyGeneration=0&maxBytes=524288`,
  );
  expect(response.ok()).toBe(true);
  const history = await response.json();
  expect(history.historyReset).toBe(false);
  expect(history.hasMore).toBe(false);
  return history.chunks.map(chunk => ({
    ...chunk,
    bytes: Buffer.from(chunk.data, 'base64'),
  }));
};

const assertVisibleTopBand = imageBuffer => {
  const image = PNG.sync.read(imageBuffer);
  const bandHeight = Math.max(2, Math.floor(image.height / 40));
  const countBand = (startY, endY, predicate) => {
    let count = 0;
    for (let y = startY; y < endY; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const offset = (y * image.width + x) * 4;
        if (predicate(image.data[offset], image.data[offset + 1], image.data[offset + 2])) count += 1;
      }
    }
    return count;
  };
  expect(countBand(0, bandHeight, (r, g, b) => r > g * 1.4 && r > b * 1.4)).toBeGreaterThan(image.width);
};

const helperSource = String.raw`
import os, signal
frame = 0
def render(*_):
    global frame
    frame += 1
    cols, rows = os.get_terminal_size(0)
    row0 = f'FRAME_{frame}_ROW0_{rows}x{cols}'
    last = f'FRAME_{frame}_LAST_{rows}x{cols}'
    data = ('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b[41m' + row0 + '\x1b[K\x1b[0m'
            + f'\x1b[{rows};1H' + last + '\x1b[K')
    os.write(1, data.encode())
signal.signal(signal.SIGWINCH, render)
render()
while True:
    signal.pause()
`;

test('keeps every SIGWINCH frame edge visible through retained-backing grow and shrink', async ({ page, request }) => {
  test.skip(process.platform !== 'darwin' && process.platform !== 'linux', 'real PTY resize coverage requires SIGWINCH');
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await expect.poll(() => page.locator('.terminalPane canvas').count()).toBe(1);
  await expect(page.locator('.terminalPane canvas.semanticTerminalSurface')).toBeVisible();
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]')
    .getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);

  const sourceHex = Buffer.from(helperSource).toString('hex');
  await page.evaluate(hex => {
    window.__floetermPerfHarness.resetStreamDiagnostics();
    window.__floetermPerfHarness.sendInput(`python3 -c "exec(bytes.fromhex('${hex}').decode())"\r`);
  }, sourceHex);

  let previousFrame = 0;
  let previousGeneration = 0;
  const vector = [[1280, 720], [760, 460], [1180, 680], [820, 440]];
  for (const [width, height] of vector) {
    await setTerminalHostSize(page, width, height);
    let resizeState;
    let resizeTrace;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      resizeState = await readState(page);
      resizeTrace = await page.evaluate(() => (
        window.__floetermPerfHarness?.getResizeDiagnostics?.() ?? []
      ));
      const state = resizeState;
      const match = state.serialized.match(/FRAME_(\d+)_ROW0_(\d+)x(\d+)/);
      const converged = Boolean(
        match
        && Number(match[1]) > previousFrame
        && Number(match[2]) === state.host.rows
        && Number(match[3]) === state.host.cols
        && state.geometry.generation > previousGeneration
        && state.geometry.cols === state.host.cols
        && state.geometry.rows === state.host.rows
      );
      if (converged) break;
      await page.waitForTimeout(100);
    }
    const match = resizeState?.serialized.match(/FRAME_(\d+)_ROW0_(\d+)x(\d+)/);
    const converged = Boolean(
      match
      && Number(match[1]) > previousFrame
      && Number(match[2]) === resizeState.host.rows
      && Number(match[3]) === resizeState.host.cols
      && resizeState.geometry.generation > previousGeneration
      && resizeState.geometry.cols === resizeState.host.cols
      && resizeState.geometry.rows === resizeState.host.rows
    );
    expect(converged, JSON.stringify({ width, height, resizeState, resizeTrace })).toBe(true);

    const state = await readState(page);
    const frame = Number(state.serialized.match(/FRAME_(\d+)_ROW0_/)?.[1] ?? 0);
    const marker = Buffer.from(`FRAME_${frame}_ROW0_${state.host.rows}x${state.host.cols}`);
    const chunks = await readHistory(request, sessionId);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index].sequence).toBe(chunks[index - 1].sequence + 1);
    }
    const frameChunk = chunks.find(chunk => chunk.bytes.includes(marker));
    expect(frameChunk).toBeDefined();
    expect(frameChunk).toMatchObject({
      geometryGeneration: state.geometry.generation,
      cols: state.host.cols,
      rows: state.host.rows,
    });
    const presentation = await page.evaluate(() => (
      window.__floetermPerfHarness?.getPresentationDiagnostics?.() ?? null
    ));
    expect(frameChunk.sequence, JSON.stringify({
      frame,
      frameChunk: {
        sequence: frameChunk.sequence,
        geometryGeneration: frameChunk.geometryGeneration,
        cols: frameChunk.cols,
        rows: frameChunk.rows,
      },
      geometry: state.geometry,
      presentation: presentation && {
        sequence: presentation.sequence,
        geometry: presentation.geometry,
        frame: { width: presentation.frame.width, height: presentation.frame.height },
      },
      resize: await page.evaluate(() => (
        window.__floetermPerfHarness?.getResizeDiagnostics?.() ?? []
      )),
      chunks: chunks.slice(-12).map(chunk => ({
        sequence: chunk.sequence,
        geometryGeneration: chunk.geometryGeneration,
        cols: chunk.cols,
        rows: chunk.rows,
      })),
    })).toBeGreaterThan(state.geometry.outputSequenceBoundary);
    expect(state.serialized).toContain(`FRAME_${frame}_LAST_${state.host.rows}x${state.host.cols}`);
    expect(state.canvasTop).toBeCloseTo(state.surfaceTop, 5);
    expect(state.canvasLeft).toBeCloseTo(state.surfaceLeft, 5);
    expect(state.stream.sequenceGaps).toBe(0);
    expect(state.effective).toMatchObject({ cols: state.host.cols, rows: state.host.rows });

    const surface = page.locator('.semanticTerminalSurface');
    const box = await surface.boundingBox();
    if (!box) throw new Error('terminal surface has no visible bounds');
    const clippedScreenshot = await page.screenshot({ animations: 'disabled', clip: box });
    assertVisibleTopBand(clippedScreenshot);
    const image = PNG.sync.read(clippedScreenshot);
    const bottomBandHeight = Math.max(2, Math.floor(image.height / 40));
    let bottomInk = 0;
    for (let y = image.height - bottomBandHeight; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const offset = (y * image.width + x) * 4;
        if (image.data[offset] + image.data[offset + 1] + image.data[offset + 2] > 90) bottomInk += 1;
      }
    }
    expect(bottomInk).toBeGreaterThan(10);
    previousFrame = frame;
    previousGeneration = state.geometry.generation;
  }

  const finalState = await readState(page);
  expect(finalState.backingHeight).toBeCloseTo(finalState.logicalHeight, 5);
  expect(failures).toEqual([]);
});
