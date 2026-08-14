import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const readMirror = page => page.evaluate(() => {
  const harness = window.__floetermMirrorHarness;
  if (!harness) return null;
  return {
    state: harness.getRuntimeState(),
    views: harness.getViews().map(view => ({
      label: view.label,
      info: view.getTerminalInfo(),
      viewport: view.getSnapshot().state.dimensions,
      connected: view.getSnapshot().connection.isConnected,
      geometry: view.getGeometryDiagnostics(),
      serialized: view.serialize(),
    })),
  };
});

const readRuntime = page => page.evaluate(async () => {
  const response = await fetch('/api/performance/runtime');
  if (!response.ok) throw new Error(`runtime diagnostics returned ${response.status}`);
  return response.json();
});

const openMirror = async page => {
  await page.goto('/?mode=mirror&perf_probe=1');
  await page.waitForFunction(() => {
    const harness = window.__floetermMirrorHarness;
    return harness?.getViews().length === 2
      && harness.getViews().every(view => view.getSnapshot().connection.isConnected && view.getTerminalInfo());
  });
  const sessionId = await page.locator('[data-testid="mirror-runtime-state"]').getAttribute('data-session-id');
  if (!sessionId) throw new Error('mirror session id is unavailable');
  await waitForInteractiveShell(page, sessionId);
};

const expectUniqueMirrorCanvases = async page => {
  const ownership = await page.locator('[data-mirror-view]').evaluateAll(panes => panes.map(pane => {
    const canvases = [...pane.querySelectorAll('canvas')];
    const visible = canvases.filter(canvas => {
      const style = getComputedStyle(canvas);
      const bounds = canvas.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
    });
    return {
      canvases: canvases.length,
      visible: visible.length,
      semantic: visible.filter(canvas => canvas.classList.contains('semanticTerminalSurface')).length,
      legacy: visible.filter(canvas => !canvas.classList.contains('semanticTerminalSurface')).length,
    };
  }));
  expect(ownership).toEqual([
    { canvases: 1, visible: 1, semantic: 1, legacy: 0 },
    { canvases: 1, visible: 1, semantic: 1, legacy: 0 },
  ]);
};

const resetMirrorStreamDiagnostics = page => page.evaluate(() => {
  const views = window.__floetermMirrorHarness.getViews();
  const commonWatermark = Math.max(...views.map(view => view.getStreamDiagnostics().lastSequence));
  views.forEach(view => view.resetStreamDiagnostics(commonWatermark));
});

const resetMirrorRenderDiagnostics = page => page.evaluate(() => {
  window.__floetermMirrorHarness.getViews().forEach(view => view.resetRenderDiagnostics());
});

const expectMirrorPresentationConverged = async page => {
  await expect.poll(() => page.evaluate(() => {
    const views = window.__floetermMirrorHarness?.getViews() ?? [];
    if (views.length !== 2) return false;
    const presentations = views.map(view => view.getPresentationDiagnostics?.());
    if (presentations.some(value => !value)) return false;
    return presentations.every(value => value.sequence === presentations[0].sequence)
      && views.every(view => view.serialize() === views[0].serialize());
  })).toBe(true);
};

const expectMirrorGeometryConverged = async page => {
  await expect.poll(async () => {
    const state = await readMirror(page);
    if (!state || state.views.length !== 2) return false;
    const canonical = state.views[0].geometry;
    return canonical.generation > 0 && state.views.every(view => (
      view.info?.rows === canonical.rows
      && view.info?.cols === canonical.cols
      && view.geometry.generation > 0
      && view.geometry.rows === canonical.rows
      && view.geometry.cols === canonical.cols
    ));
  }).toBe(true);
};

const captureMirrorPixels = async (page, mirrorState) => {
  await expect.poll(() => page.evaluate(() => (
    window.__floetermMirrorHarness.getViews().every(view => view.getRenderDiagnostics().count > 0)
  ))).toBe(true);
  return Promise.all(mirrorState.views.map(async view => {
    const canvas = page.locator(`[data-mirror-view="${view.label}"] .semanticTerminalSurface`);
    await expect(canvas).toBeVisible();
    const image = PNG.sync.read(await canvas.screenshot({ animations: 'disabled' }));
    const background = await canvas.evaluate(element => {
      const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(element).backgroundColor);
      if (!match) throw new Error('terminal canvas background is not an RGB color');
      return [Number(match[1]), Number(match[2]), Number(match[3]), 255];
    });
    return {
      image,
      background,
      host: view.viewport,
      effective: view.info,
      cellWidth: Math.floor(image.width / view.viewport.cols),
      cellHeight: Math.floor(image.height / view.viewport.rows),
    };
  }));
};

const expectPixel = (image, x, y, expected) => {
  const offset = (y * image.width + x) * 4;
  expect(Array.from(image.data.subarray(offset, offset + 4))).toEqual(expected);
};

const inkRowRuns = (view, maxRows = 12) => {
  const width = Math.min(view.image.width, view.effective.cols * view.cellWidth);
  const height = Math.min(view.image.height, maxRows * view.cellHeight, view.effective.rows * view.cellHeight);
  const occupied = [];
  for (let y = 0; y < height; y += 1) {
    let inkPixels = 0;
    for (let x = 2; x < width; x += 1) {
      const offset = (y * view.image.width + x) * 4;
      const distance = Math.abs(view.image.data[offset] - view.background[0])
        + Math.abs(view.image.data[offset + 1] - view.background[1])
        + Math.abs(view.image.data[offset + 2] - view.background[2]);
      if (distance > 18) inkPixels += 1;
    }
    if (inkPixels >= 3) occupied.push(y);
  }
  const runs = [];
  for (const y of occupied) {
    const previous = runs.at(-1);
    if (!previous || y > previous.end + 1) runs.push({ start: y, end: y });
    else previous.end = y;
  }
  return runs;
};

test('keeps independent viewport sizes on one shared terminal grid and screen state', async ({ page }) => {
  const consoleErrors = captureBrowserFailures(page);
  await openMirror(page);

  const initial = await readMirror(page);
  expect(initial?.state.connectedCount).toBe(2);
  expect(initial?.state.errorCount).toBe(0);
  expect(initial?.views).toHaveLength(2);
  await expectUniqueMirrorCanvases(page);
  const [firstInfo, secondInfo] = initial.views.map(view => view.info);
  expect(firstInfo).not.toBeNull();
  expect(secondInfo).not.toBeNull();
  expect(initial.views[0].viewport).not.toEqual(initial.views[1].viewport);
  expect(firstInfo).toEqual(secondInfo);

  const initialRuntime = await readRuntime(page);
  expect(initialRuntime.connection_count).toBe(2);
  expect(initialRuntime.live_attachment_count).toBe(2);

  await resetMirrorStreamDiagnostics(page);
  await resetMirrorRenderDiagnostics(page);
  const consistencyMarkers = [
    'FLOETERM_CONSISTENCY_A',
    'FLOETERM_CONSISTENCY_B 中文 😀',
    'FLOETERM_CONSISTENCY_END',
  ];
  const consistencyPayloadHex = Buffer.from(
    `\x1b[3J\x1b[2J\x1b[H${consistencyMarkers.join('\n')}\n`,
  ).toString('hex');
  await page.evaluate(hex => {
    window.__floetermMirrorHarness.getViews()[0].sendInput(
      `PS1=''; python3 -c "import os;os.write(1,bytes.fromhex('${hex}'))"\r`,
    );
  }, consistencyPayloadHex);
  await page.waitForFunction(marker => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes(marker))
  ), consistencyMarkers[2]);
  await expectMirrorPresentationConverged(page);
  const consistency = await page.evaluate(markers => window.__floetermMirrorHarness.getViews().map(view => ({
    stream: view.getStreamDiagnostics(),
    presentationSequence: view.getPresentationDiagnostics().sequence,
    markers: markers.map(marker => view.serialize().includes(marker)),
    serialized: view.serialize(),
  })), consistencyMarkers);
  expect(consistency.every(view => view.stream.sequenceGaps === 0 && view.stream.dataEvents > 0)).toBe(true);
  expect(consistency[0].stream.lastSequence).toBe(consistency[0].presentationSequence);
  expect(consistency[1].stream.lastSequence).toBe(consistency[1].presentationSequence);
  expect(consistency[0].presentationSequence).toBe(consistency[1].presentationSequence);
  expect(consistency[0].serialized).toContain(consistencyMarkers[1]);
  expect(consistency[0].markers).toEqual([true, true, true]);
  expect(consistency[1].markers).toEqual([true, true, true]);
  expect(consistency[0].serialized).toBe(consistency[1].serialized);

  const rendered = await captureMirrorPixels(page, initial);
  expect(rendered[0].cellWidth).toBe(rendered[1].cellWidth);
  expect(rendered[0].cellHeight).toBe(rendered[1].cellHeight);
  for (const view of rendered) {
    if (view.host.cols > view.effective.cols) {
      expectPixel(view.image, view.image.width - 2, Math.floor(view.image.height / 2), view.background);
    }
    if (view.host.rows > view.effective.rows) {
      expectPixel(view.image, Math.floor(view.image.width / 2), view.image.height - 2, view.background);
    }
  }
  const firstInkRows = inkRowRuns(rendered[0]);
  const secondInkRows = inkRowRuns(rendered[1]);
  expect(firstInkRows.length).toBeGreaterThanOrEqual(consistencyMarkers.length);
  expect(secondInkRows).toEqual(firstInkRows);

  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(consoleErrors).toEqual([]);
});

test('keeps observer viewport changes from resizing the controller-owned PTY', async ({ page }) => {
  const consoleErrors = captureBrowserFailures(page);
  await openMirror(page);

  await expectMirrorGeometryConverged(page);
  const beforeObserverResize = await readMirror(page);
  const observerIndex = beforeObserverResize.views.findIndex(view => (
    view.viewport.cols !== beforeObserverResize.views[0].geometry.cols
      || view.viewport.rows !== beforeObserverResize.views[0].geometry.rows
  ));
  expect(observerIndex, JSON.stringify(beforeObserverResize, null, 2)).toBeGreaterThanOrEqual(0);
  await page.evaluate(async index => {
    await window.__floetermMirrorHarness.getViews()[index].synchronizeSize();
  }, observerIndex);
  await expect.poll(async () => {
    const state = await readMirror(page);
    return state.views.every(view => (
      view.geometry.generation === beforeObserverResize.views[0].geometry.generation
      && view.geometry.rows === beforeObserverResize.views[0].geometry.rows
      && view.geometry.cols === beforeObserverResize.views[0].geometry.cols
    ));
  }).toBe(true);
  await page.evaluate(async () => {
    await window.__floetermMirrorHarness.getViews()[0].synchronizeSize();
  });
  await expectMirrorGeometryConverged(page);

  const sizeMarker = 'MIRROR_E2E_STTY';
  const sizeMarkerHex = Buffer.from(sizeMarker).toString('hex');
  await page.evaluate(({ markerHex }) => {
    const command = `python3 -c "import os;s=os.get_terminal_size(0);os.write(1,bytes.fromhex('${markerHex}')+f' {s.lines} {s.columns}\\n'.encode())"`;
    window.__floetermMirrorHarness.getViews()[1].sendInput(`${command}\r`);
  }, { markerHex: sizeMarkerHex });
  await page.waitForFunction(marker => (
    window.__floetermMirrorHarness.getViews().every(view => new RegExp(`${marker} \\d+ \\d+`).test(view.serialize()))
  ), sizeMarker);
  const sizeState = await readMirror(page);
  const match = sizeState.views[0].serialized.match(new RegExp(`${sizeMarker} (\\d+) (\\d+)`));
  expect(match).not.toBeNull();
  const expectedRows = sizeState.views[0].geometry.rows;
  const expectedCols = sizeState.views[0].geometry.cols;
  const diagnostics = JSON.stringify({ expectedRows, expectedCols, sizeState }, null, 2);
  expect(Number(match[1]), diagnostics).toBe(expectedRows);
  expect(Number(match[2]), diagnostics).toBe(expectedCols);
  expect(consoleErrors).toEqual([]);
});

test('repaints the complete shared screen after one view is hidden, restored, and resized', async ({ page }, testInfo) => {
  const consoleErrors = captureBrowserFailures(page);
  await openMirror(page);

  const markers = [
    'MIRROR_RESTORE_MMMMMMMMMM',
    'MIRROR_RESTORE_WWWWWWWWWW',
    'MIRROR_RESTORE_iiiiiiiiii',
    'MIRROR_RESTORE_0123456789',
    'MIRROR_RESTORE_中文😀END',
  ];
  const payloadHex = Buffer.from(`\x1b[3J\x1b[2J\x1b[H${markers.join('\n')}\n`).toString('hex');
  await page.evaluate(hex => {
    window.__floetermMirrorHarness.getViews()[0].sendInput(
      `python3 -c "import os;os.write(1,bytes.fromhex('${hex}'))"\r`,
    );
  }, payloadHex);
  await page.waitForFunction(marker => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes(marker))
  ), markers.at(-1));

  const hiddenLabel = (await readMirror(page)).views[0].label;
  await page.locator(`[data-mirror-view="${hiddenLabel}"]`).evaluate(element => {
    element.style.visibility = 'hidden';
  });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.evaluate(() => window.__floetermMirrorHarness.getViews()[0].forceResize());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator(`[data-mirror-view="${hiddenLabel}"]`).evaluate(element => {
    element.style.visibility = '';
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.__floetermMirrorHarness.getViews()[0].forceResize());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const restored = await readMirror(page);
  expect(restored.views[0].serialized).toBe(restored.views[1].serialized);
  expect(restored.views.every(view => view.serialized.includes(markers.at(-1)))).toBe(true);
  const rendered = await captureMirrorPixels(page, restored);
  await Promise.all(restored.views.map((view, index) => page
    .locator(`[data-mirror-view="${view.label}"] .semanticTerminalSurface`)
    .screenshot({ animations: 'disabled', path: testInfo.outputPath(`restored-view-${index + 1}.png`) })));
  const firstInkRows = inkRowRuns(rendered[0]);
  const secondInkRows = inkRowRuns(rendered[1]);
  expect(firstInkRows.length, JSON.stringify({ firstInkRows, secondInkRows, restored }, null, 2))
    .toBeGreaterThanOrEqual(markers.length);
  expect(secondInkRows).toEqual(firstInkRows);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(consoleErrors).toEqual([]);
});

test('restores the latest semantic screen at its canonical geometry after reconnect', async ({ page }) => {
  const consoleErrors = captureBrowserFailures(page);
  await openMirror(page);

  await page.evaluate(() => {
    window.__floetermMirrorHarness.getViews()[0].sendInput(
      "printf '\\033[2J\\033[HGEOMETRY_HISTORY_BASE\\033[2B\\033[8CBASE_DELTA\\n'\r",
    );
  });
  await page.waitForFunction(() => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes('BASE_DELTA'))
  ));

  const beforeResize = await readMirror(page);
  const previousGeneration = beforeResize.views[0].geometry.generation;
  await page.setViewportSize({ width: 760, height: 640 });
  await page.evaluate(() => window.__floetermMirrorHarness.getViews().forEach(view => view.forceResize()));
  await expect.poll(async () => {
    const state = await readMirror(page);
    return state.views.every(view => view.geometry.generation > previousGeneration);
  }).toBe(true);

  await page.evaluate(() => {
    window.__floetermMirrorHarness.getViews()[1].sendInput(
      "printf '\\033[3A\\033[12CGEOMETRY_HISTORY_RESIZED\\n'\r",
    );
  });
  await page.waitForFunction(() => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes('GEOMETRY_HISTORY_RESIZED'))
  ));
  const beforeReconnect = await readMirror(page);

  await page.evaluate(() => window.__floetermMirrorHarness.getViews()[0].reconnect());
  await page.waitForFunction(() => (
    window.__floetermMirrorHarness.getViews().length === 2
      && window.__floetermMirrorHarness.getViews().every(view => view.getSnapshot().connection.isConnected)
  ));
  await page.waitForFunction(() => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes('GEOMETRY_HISTORY_RESIZED'))
  ));
  const afterReconnect = await readMirror(page);
  expect(afterReconnect.views.map(view => view.serialized)).toEqual(
    beforeReconnect.views.map(view => view.serialized),
  );

  await page.locator('[data-mirror-view] [aria-label="Terminal input"]').first().focus();
  await page.waitForFunction(() => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes('GEOMETRY_HISTORY_RESIZED'))
  ));
  const afterFocus = await readMirror(page);
  expect(afterFocus.views.map(view => view.serialized)).toEqual(
    beforeReconnect.views.map(view => view.serialized),
  );
  expect(consoleErrors).toEqual([]);
});

test('keeps long wrapped output and terminal state identical across different viewport widths', async ({ page }) => {
  const consoleErrors = captureBrowserFailures(page);
  await openMirror(page);

  const initial = await readMirror(page);
  expect(initial.views[0].viewport.cols).not.toBe(initial.views[1].viewport.cols);
  expect(initial.views[0].info).toEqual(initial.views[1].info);
  await resetMirrorStreamDiagnostics(page);
  const wrapTarget = `FLOETERM_WRAP_${'X'.repeat(180)}_END`;
  await page.evaluate(() => {
    window.__floetermMirrorHarness.getViews()[0].sendInput(
      "printf '\\033[3J\\033[2J\\033[H'; printf 'FLOETERM_WRAP_'; printf '%180s' '' | tr ' ' X; printf '_END\\n'\r",
    );
  });
  await page.waitForFunction(target => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().replace(/\s/g, '').includes(target))
  ), wrapTarget);
  await expectMirrorPresentationConverged(page);
  const wrapped = await page.evaluate(() => window.__floetermMirrorHarness.getViews().map(view => ({
    stream: view.getStreamDiagnostics(),
    presentationSequence: view.getPresentationDiagnostics().sequence,
    serialized: view.serialize(),
  })));
  expect(wrapped.every(view => view.stream.sequenceGaps === 0 && view.stream.dataEvents > 0)).toBe(true);
  expect(wrapped[0].stream.lastSequence).toBe(wrapped[0].presentationSequence);
  expect(wrapped[1].stream.lastSequence).toBe(wrapped[1].presentationSequence);
  expect(wrapped[0].presentationSequence).toBe(wrapped[1].presentationSequence);
  expect(wrapped[0].serialized).toEqual(wrapped[1].serialized);
  expect(wrapped.every(view => view.serialized.replace(/\s/g, '').includes(wrapTarget))).toBe(true);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(consoleErrors).toEqual([]);
});

test('keeps both views usable through input, reconnect, resize, and session restart', async ({ page }) => {
  const consoleErrors = captureBrowserFailures(page);
  await openMirror(page);

  const firstMarker = 'MIRROR_E2E_FIRST_INPUT';
  await page.evaluate(marker => {
    window.__floetermMirrorHarness.getViews()[0].sendInput(`printf '${marker}\\n'\r`);
  }, firstMarker);
  await page.waitForFunction(marker => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes(marker))
  ), firstMarker);

  await page.evaluate(() => window.__floetermMirrorHarness.getViews()[0].reconnect());
  await page.waitForFunction(() => {
    const harness = window.__floetermMirrorHarness;
    return harness?.getViews().length === 2
      && harness.getViews().every(view => view.getSnapshot().connection.isConnected);
  });
  const reconnectedRuntime = await readRuntime(page);
  expect(reconnectedRuntime.connection_count).toBe(2);
  expect(reconnectedRuntime.live_attachment_count).toBe(2);

  const secondMarker = 'MIRROR_E2E_SECOND_INPUT';
  await page.evaluate(marker => {
    window.__floetermMirrorHarness.getViews()[1].sendInput(`printf '${marker}\\n'\r`);
  }, secondMarker);
  await page.waitForFunction(marker => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes(marker))
  ), secondMarker);

  await page.setViewportSize({ width: 1080, height: 720 });
  await page.evaluate(() => window.__floetermMirrorHarness.getViews().forEach(view => view.forceResize()));
  await page.waitForFunction(() => {
    const harness = window.__floetermMirrorHarness;
    return harness?.getViews().length === 2
      && harness.getViews().every(view => view.getSnapshot().connection.isConnected && view.getTerminalInfo());
  });
  const resized = await readMirror(page);
  expect(resized.state.connectedCount).toBe(2);
  expect(resized.state.errorCount).toBe(0);
  expect(resized.views[0].viewport).not.toEqual(resized.views[1].viewport);
  expect(resized.views[0].info).toEqual(resized.views[1].info);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);

  const runtimeStateNode = page.getByTestId('demo-runtime-state');
  const previousSessionId = await runtimeStateNode.getAttribute('data-single-session-id');
  await page.getByRole('button', { name: 'restart session', exact: true }).click();
  await page.waitForFunction(previous => {
    const state = document.querySelector('[data-testid="demo-runtime-state"]');
    const harness = window.__floetermMirrorHarness;
    return state?.getAttribute('data-single-session-id') !== previous
      && harness?.getViews().length === 2
      && harness.getViews().every(view => view.getSnapshot().connection.isConnected);
  }, previousSessionId);
  const restartedRuntime = await readRuntime(page);
  expect(restartedRuntime.connection_count).toBe(2);
  expect(restartedRuntime.live_attachment_count).toBe(2);
  const restartMarker = 'FLOETERM_E2E_AFTER_RESTART';
  await page.evaluate(marker => {
    window.__floetermMirrorHarness.getViews()[0].sendInput(`printf '${marker}\\n'\r`);
  }, restartMarker);
  await page.waitForFunction(marker => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes(marker))
  ), restartMarker);
  expect(consoleErrors).toEqual([]);
});
