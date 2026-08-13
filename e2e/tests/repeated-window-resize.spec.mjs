import { expect, test } from '@playwright/test';

test('keeps the semantic live session attached through repeated window resizes', async ({ page, request }) => {
  const response = await request.post('/api/sessions', { data: { name: `resize-stress-${Date.now()}`, workingDir: '' } });
  expect(response.ok()).toBe(true);
  const session = await response.json();
  await page.goto(`/?mode=single&session=${encodeURIComponent(session.id)}&perf_probe=1`);
  await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected && window.__floetermPerfHarness.getTerminalInfo());
  for (let i = 0; i < 60; i += 1) {
    await page.setViewportSize({ width: 800 + (i % 5) * 137, height: 500 + (i % 4) * 113 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  const finalState = await page.evaluate(() => ({
    connected: window.__floetermPerfHarness?.getSnapshot().connection.isConnected,
    info: window.__floetermPerfHarness?.getTerminalInfo(),
    errors: document.querySelectorAll('.terminalRendererError').length,
    canvases: document.querySelectorAll('.terminalPane canvas').length,
    message: document.querySelector('.terminalRendererError')?.textContent ?? '',
  }));
  expect(finalState, JSON.stringify(finalState)).toMatchObject({ connected: true, errors: 0, canvases: 1 });
});
