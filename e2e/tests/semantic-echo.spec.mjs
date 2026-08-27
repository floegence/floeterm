import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

test('keeps echo-off input authoritative to the real PTY without local prediction', async ({ page, request }) => {
  const failures = captureBrowserFailures(page);
  const response = await request.post('/api/sessions', {
    data: { name: `semantic-echo-${Date.now()}`, workingDir: '' },
  });
  expect(response.ok()).toBe(true);
  const session = await response.json();

  try {
    await page.goto(`/?mode=single&session=${encodeURIComponent(session.id)}&perf_probe=1`);
    await page.waitForFunction(() => (
      window.__floetermPerfHarness?.getSnapshot().connection.isConnected
        && window.__floetermPerfHarness.getTerminalInfo()
    ));
    await waitForInteractiveShell(page, session.id);

    const readyMarker = 'FLOETERM_ECHO_OFF_READY';
    const probeSource = `
import os, sys, termios
old = termios.tcgetattr(0)
value = b''
try:
    no_echo = termios.tcgetattr(0)
    no_echo[3] &= ~termios.ECHO
    termios.tcsetattr(0, termios.TCSANOW, no_echo)
    os.write(1, b'\\r\\n${readyMarker}\\r\\n')
    value = sys.stdin.buffer.readline().rstrip(b'\\r\\n')
finally:
    termios.tcsetattr(0, termios.TCSANOW, old)
os.write(1, f'\\r\\nFLOETERM_ECHO_OFF_LENGTH_{len(value)}\\r\\n'.encode())
`;
    const sourceHex = Buffer.from(probeSource, 'utf8').toString('hex');
    await page.evaluate(hex => window.__floetermPerfHarness.sendInput(
      `python3 -c "exec(bytes.fromhex('${hex}').decode())"\r`,
    ), sourceHex);
    await expect.poll(async () => page.evaluate(() => window.__floetermPerfHarness.serialize()))
      .toContain(readyMarker);

    const secret = `never-render-${Date.now()}`;
    const input = page.locator('textarea[aria-label="Terminal input"]');
    await input.focus();
    await page.keyboard.type(secret);
    await page.keyboard.press('Enter');

    await expect.poll(async () => page.evaluate(() => window.__floetermPerfHarness.serialize()))
      .toContain(`FLOETERM_ECHO_OFF_LENGTH_${secret.length}`);
    const serialized = await page.evaluate(() => window.__floetermPerfHarness.serialize());
    expect(serialized).not.toContain(secret);
    await expect(page.locator('.terminalRendererError')).toHaveCount(0);
    expect(failures).toEqual([]);
  } finally {
    await request.delete(`/api/sessions/${encodeURIComponent(session.id)}`);
  }
});
