import { expect, test } from '@playwright/test';
import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

test('reads and displays verified terminal history over HTTP', async ({ page, baseURL }) => {
  const failures = captureBrowserFailures(page);
  const url = new URL('/?mode=single&perf_probe=1', baseURL);
  await page.goto(url.href);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  expect(await page.evaluate(() => ({
    secure: window.isSecureContext,
    subtle: typeof window.crypto.subtle,
  }))).toEqual({ secure: loopback, subtle: loopback ? 'object' : 'undefined' });

  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));
  const sessionId = await page.getByTestId('demo-runtime-state').getAttribute('data-single-session-id');
  expect(sessionId).toBeTruthy();
  await waitForInteractiveShell(page, sessionId);
  await page.evaluate(() => window.__floetermPerfHarness.sendInput(
    `python3 -c "for i in range(320): print(f'HTTP_HISTORY_{i:04d}')"\r`,
  ));
  await page.waitForFunction(() => window.__floetermPerfHarness.serialize().includes('HTTP_HISTORY_0319'));

  const history = await page.evaluate(async () => {
    const viewport = await window.__floetermPerfHarness.readSemanticHistory({ direction: 'start' });
    return viewport.frame.rows.map(row => row.cells.map(cell => cell.text).join('')).join('\n');
  });
  expect(history).toContain('HTTP_HISTORY_0000');
  expect(history).not.toContain('HTTP_HISTORY_0319');
  const scrollbar = page.getByRole('scrollbar', { name: 'Terminal scrollback' });
  await scrollbar.focus();
  await page.keyboard.press('Home');
  await expect(scrollbar).toHaveAttribute('aria-valuenow', '0');
  await expect.poll(() => page.evaluate(() => window.__floetermPerfHarness.getVisibleLines().join('\n')))
    .toContain('HTTP_HISTORY_0000');
  expect(failures).toEqual([]);
});
