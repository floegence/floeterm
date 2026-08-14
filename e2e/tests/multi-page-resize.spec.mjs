import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';
import { topContractForPlatform } from '../support/topProcess.mjs';

const topContract = topContractForPlatform(process.platform);

const createSession = async request => {
  const response = await request.post('/api/sessions', {
    data: { name: `multi-page-resize-${Date.now()}`, workingDir: '' },
  });
  expect(response.ok()).toBe(true);
  return await response.json();
};

const presentationContains = async (page, marker) => page.evaluate(expected => {
  const presentation = window.__floetermPerfHarness?.getPresentationDiagnostics?.();
  return presentation?.frame.rows
    .map(row => row.cells.map(cell => cell.text).join(''))
    .join('\n')
    .includes(expected) ?? false;
}, marker);

const openSharedSessionPage = async (page, sessionId, viewport) => {
  await page.setViewportSize(viewport);
  await page.goto(`/?mode=single&session=${encodeURIComponent(sessionId)}&perf_probe=1`);
  await page.waitForFunction(expectedSessionId => {
    const state = document.querySelector('[data-testid="demo-runtime-state"]');
    const harness = window.__floetermPerfHarness;
    return state?.getAttribute('data-single-session-id') === expectedSessionId
      && state.getAttribute('data-single-session-external') === 'true'
      && harness?.getSnapshot().connection.isConnected
      && harness.getTerminalInfo();
  }, sessionId);
  await waitForInteractiveShell(page, sessionId);
};

const forceResizeAfterCommittedLayout = async page => {
  await page.bringToFront();
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.__floetermPerfHarness.forceResize();
        resolve();
      });
    });
  }));
};

const readPageState = page => page.evaluate(() => {
  const harness = window.__floetermPerfHarness;
  const runtime = document.querySelector('[data-testid="demo-runtime-state"]');
  if (!harness || !runtime) throw new Error('single-page performance harness is unavailable');
  return {
    connectionId: runtime.getAttribute('data-connection-id'),
    host: harness.getSnapshot().state.dimensions,
    effective: harness.getTerminalInfo(),
    geometry: harness.getGeometryDiagnostics(),
    stream: harness.getStreamDiagnostics(),
    presentationSequence: harness.getPresentationDiagnostics?.()?.sequence ?? 0,
    serialized: harness.serialize(),
    visibleLines: harness.getVisibleLines(),
    probe: window.__floetermPerfProbe.snapshot(),
  };
});

const waitForTopSemanticFrame = async target => {
  await expect.poll(async () => target.evaluate(contract => {
    const lines = window.__floetermPerfHarness?.getVisibleLines() ?? [];
    return lines.some(line => line.startsWith(contract.headerPrefix))
      && lines.some(line => line.startsWith(contract.loadPrefix));
  }, topContract)).toBe(true);
};

const readGeometryState = page => page.evaluate(() => {
  const harness = window.__floetermPerfHarness;
  const runtime = document.querySelector('[data-testid="demo-runtime-state"]');
  if (!harness || !runtime) throw new Error('single-page performance harness is unavailable');
  return {
    connectionId: runtime.getAttribute('data-connection-id'),
    host: harness.getSnapshot().state.dimensions,
    effective: harness.getTerminalInfo(),
    geometry: harness.getGeometryDiagnostics(),
  };
});

const expectConverged = async (firstPage, secondPage) => {
  let convergedSnapshot = null;
  await expect.poll(async () => {
    const [first, second] = await Promise.all([readGeometryState(firstPage), readGeometryState(secondPage)]);
    const expectedCols = first.effective?.cols;
    const expectedRows = first.effective?.rows;
    const isConverged = Number.isInteger(expectedCols)
      && Number.isInteger(expectedRows)
      && second.effective?.cols === expectedCols
      && second.effective?.rows === expectedRows
      && first.geometry.cols === expectedCols
      && first.geometry.rows === expectedRows
      && second.geometry.cols === expectedCols
      && second.geometry.rows === expectedRows
      && first.geometry.generation === second.geometry.generation
      && first.geometry.generation > 0;
    if (isConverged) {
      convergedSnapshot = {
        first,
        second,
        expected: { cols: expectedCols, rows: expectedRows },
      };
    }
    return isConverged;
  }).toBe(true);

  if (!convergedSnapshot) throw new Error('converged geometry snapshot is unavailable');
  const { first, second, expected } = convergedSnapshot;
  expect(first.effective).toMatchObject(expected);
  expect(second.effective).toMatchObject(expected);
  expect(first.geometry).toMatchObject({ ...expected, generation: second.geometry.generation });
  expect(first.geometry.generation).toBeGreaterThan(0);
  return { first, second, expected };
};

test('keeps one session correct while two independent pages resize and stream output', async ({ context, page, request }) => {
  test.slow();
  const session = await createSession(request);
  const secondPage = await context.newPage();
  const firstErrors = captureBrowserFailures(page);
  const secondErrors = captureBrowserFailures(secondPage);

  try {
    await Promise.all([
      openSharedSessionPage(page, session.id, { width: 1500, height: 650 }),
      openSharedSessionPage(secondPage, session.id, { width: 900, height: 1000 }),
    ]);
    await forceResizeAfterCommittedLayout(page);
    await forceResizeAfterCommittedLayout(secondPage);

    expect(await page.getByRole('button', { name: 'restart', exact: true }).isDisabled()).toBe(true);
    expect(await secondPage.getByRole('button', { name: 'restart', exact: true }).isDisabled()).toBe(true);

    let converged = await expectConverged(page, secondPage);
    expect(converged.first.connectionId).toBeTruthy();
    expect(converged.second.connectionId).toBeTruthy();
    expect(converged.first.connectionId).not.toBe(converged.second.connectionId);
    expect(converged.first.host.cols).toBeGreaterThan(converged.second.host.cols);
    expect(converged.first.host.rows).toBeLessThan(converged.second.host.rows);
    const resizePairs = [
      [{ width: 1320, height: 720 }, { width: 980, height: 920 }],
    ];
    let previousGeneration = converged.first.geometry.generation;
    let previousExpected = converged.expected;
    for (const [firstViewport, secondViewport] of resizePairs) {
      const previousHosts = [converged.first.host, converged.second.host];
      await Promise.all([
        page.setViewportSize(firstViewport),
        secondPage.setViewportSize(secondViewport),
      ]);
      await forceResizeAfterCommittedLayout(page);
      await forceResizeAfterCommittedLayout(secondPage);
      await expect.poll(async () => {
        const [first, second] = await Promise.all([readGeometryState(page), readGeometryState(secondPage)]);
        return {
          firstChanged: first.host.cols !== previousHosts[0].cols || first.host.rows !== previousHosts[0].rows,
          secondChanged: second.host.cols !== previousHosts[1].cols || second.host.rows !== previousHosts[1].rows,
          firstHost: first.host,
          secondHost: second.host,
        };
      }).toMatchObject({ firstChanged: true, secondChanged: true });
      converged = await expectConverged(page, secondPage);
    if (converged.expected.cols !== previousExpected.cols || converged.expected.rows !== previousExpected.rows) {
        expect(converged.first.geometry.generation).toBeGreaterThan(previousGeneration);
      }
      previousGeneration = converged.first.geometry.generation;
      previousExpected = converged.expected;
    }
    await Promise.all([page, secondPage].map(target => target.evaluate(() => {
      window.__floetermPerfHarness.resetStreamDiagnostics();
      window.__floetermPerfProbe.reset();
    })));

    const outputMarker = 'MULTI_PAGE_RESIZE_OUTPUT_DONE';
    const sizeMarker = 'MULTI_PAGE_STREAM_SIZE';
    const patternHex = Buffer.from('\x1b[31mresize\x1b[0m 中文 😀 0123456789\n').toString('hex');
    const sizeMarkerHex = Buffer.from(sizeMarker).toString('hex');
    const outputMarkerHex = Buffer.from(`${outputMarker}\n`).toString('hex');
    const command = `python3 -c "import os; p=bytes.fromhex('${patternHex}'); s=os.get_terminal_size(0); os.write(1,p*8+bytes.fromhex('${sizeMarkerHex}')+f' {s.lines} {s.columns}\\n'.encode()+bytes.fromhex('${outputMarkerHex}'))"`;
    await page.bringToFront();
    await page.evaluate(value => window.__floetermPerfHarness.sendInput(`${value}\r`), command);
    await expect.poll(() => presentationContains(page, outputMarker)).toBe(true);
    await page.bringToFront();
    await page.waitForFunction(marker => window.__floetermPerfHarness.getStreamDiagnostics().tail.includes(marker), outputMarker);
    await secondPage.bringToFront();
    await secondPage.waitForFunction(marker => window.__floetermPerfHarness.getStreamDiagnostics().tail.includes(marker), outputMarker);
    await Promise.all([page, secondPage].map(target => target.waitForFunction(
      marker => window.__floetermPerfHarness.serialize().includes(marker),
      outputMarker,
    )));
    await expect.poll(async () => {
      const states = await Promise.all([readPageState(page), readPageState(secondPage)]);
      return states[0].presentationSequence > 0
        && states[0].presentationSequence === states[1].presentationSequence
        && states[0].serialized === states[1].serialized;
    }).toBe(true);
    const streamed = await Promise.all([readPageState(page), readPageState(secondPage)]);
    expect(streamed.every(state => state.stream.sequenceGaps === 0 && state.stream.dataEvents > 0)).toBe(true);
    expect(streamed[0].stream.lastSequence).toBe(streamed[0].presentationSequence);
    expect(streamed[1].stream.lastSequence).toBe(streamed[1].presentationSequence);
    expect(streamed[0].serialized).toBe(streamed[1].serialized);
    expect(streamed.every(state => state.probe.historyRequests === 0)).toBe(true);
    expect(streamed.every(state => state.serialized.includes(outputMarker))).toBe(true);
    const sizeMatch = streamed[0].serialized.match(new RegExp(`${sizeMarker} (\\d+) (\\d+)`));
    expect(sizeMatch).not.toBeNull();
    expect(Number(sizeMatch[1])).toBe(streamed[0].effective.rows);
    expect(Number(sizeMatch[2])).toBe(streamed[0].effective.cols);

    await page.evaluate(command => window.__floetermPerfHarness.sendInput(`${command}\r`), topContract.command);
    await Promise.all([
      waitForTopSemanticFrame(page),
      waitForTopSemanticFrame(secondPage),
    ]);
    await Promise.all([page, secondPage].map(target => target.evaluate(() => (
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    ))));
    const topStates = await Promise.all([readPageState(page), readPageState(secondPage)]);
    expect(topStates.every(state => state.visibleLines.some(line => line.startsWith(topContract.headerPrefix)))).toBe(true);
    expect(topStates.every(state => state.visibleLines.some(line => line.startsWith(topContract.loadPrefix)))).toBe(true);
    expect(topStates.every(state => state.stream.sequenceGaps === 0)).toBe(true);
    await page.evaluate(() => window.__floetermPerfHarness.sendInput('\x03'));

    const firstHost = converged.first.host;
    const generationBeforeDetach = converged.first.geometry.generation;
    await secondPage.close();
    await expect.poll(async () => {
      const state = await readGeometryState(page);
      return state.effective?.cols === converged.expected.cols
        && state.effective?.rows === converged.expected.rows
        && state.geometry.cols === converged.expected.cols
        && state.geometry.rows === converged.expected.rows
        && state.geometry.generation >= generationBeforeDetach;
    }).toBe(true);
    const afterDetach = await readGeometryState(page);
    expect(afterDetach.geometry).toMatchObject({
      cols: converged.expected.cols,
      rows: converged.expected.rows,
    });
    expect(afterDetach.geometry.generation).toBeGreaterThanOrEqual(generationBeforeDetach);
    expect(await page.locator('.terminalRendererError').count()).toBe(0);
    expect(firstErrors).toEqual([]);
    expect(secondErrors).toEqual([]);

    await page.close();
    const sessionsResponse = await request.get('/api/sessions');
    expect(sessionsResponse.ok()).toBe(true);
    const sessions = await sessionsResponse.json();
    expect(sessions.some(item => item.id === session.id)).toBe(true);
  } finally {
    await request.delete(`/api/sessions/${encodeURIComponent(session.id)}`).catch(() => undefined);
    if (!secondPage.isClosed()) await secondPage.close();
    if (!page.isClosed()) await page.close();
  }
});
