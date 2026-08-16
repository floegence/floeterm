import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const pasteProbeSource = String.raw`
import os, select, termios, tty

expected = int(os.environ['FLOETERM_PASTE_BYTES'])
old = termios.tcgetattr(0)
tty.setraw(0)
try:
    os.write(1, b'\x1b[?2004h\r\nFLOETERM_CLIPBOARD_PASTE_READY\r\n')
    data = b''
    while len(data) < expected:
        ready, _, _ = select.select([0], [], [], 2)
        if not ready:
            break
        data += os.read(0, expected - len(data))
    os.write(1, b'\x1b[?2004l\r\nFLOETERM_CLIPBOARD_PASTE_GOT_' + data.hex().encode() + b'\r\n')
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)
`;

const waitForMarker = async (page, marker) => {
  await expect.poll(async () => page.evaluate(() => window.__floetermPerfHarness.serialize()))
    .toContain(marker);
};

test('uses macOS Cmd+C and Cmd+V for exact terminal clipboard operations', async ({ page, request, context }) => {
  test.skip(process.platform !== 'darwin', 'macOS command-key clipboard behavior requires Darwin');
  const failures = captureBrowserFailures(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const response = await request.post('/api/sessions', { data: { name: `semantic-clipboard-${Date.now()}`, workingDir: '' } });
  expect(response.ok()).toBe(true);
  const session = await response.json();

  try {
    await page.goto(`/?mode=single&session=${encodeURIComponent(session.id)}&perf_probe=1`);
    await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected && window.__floetermPerfHarness.getTerminalInfo());
    await waitForInteractiveShell(page, session.id);

    const copyNonce = String(Date.now());
    const copyMarker = `FLOETERM_COPY_${copyNonce}`;
    await page.evaluate(nonce => {
      window.__floetermPerfHarness.sendInput(`printf '\\r\\n%s%s\\r\\n' 'FLOETERM_COPY_' '${nonce}'\r`);
    }, copyNonce);
    await waitForMarker(page, copyMarker);
    const selection = await page.evaluate(marker => {
      const frame = window.__floetermPerfHarness.getPresentationDiagnostics();
      const canvas = document.querySelector('#semantic-terminal-surface');
      if (!(canvas instanceof HTMLCanvasElement) || !frame) throw new Error('semantic clipboard surface is unavailable');
      for (let row = 0; row < frame.frame.rows.length; row += 1) {
        const cells = frame.frame.rows[row].cells;
        const text = cells.map(cell => cell.text).join('');
        const match = text.indexOf(marker);
        if (match < 0) continue;
        let textOffset = 0;
        let startColumn = -1;
        let endColumn = -1;
        for (let column = 0; column < cells.length; column += 1) {
          const nextOffset = textOffset + cells[column].text.length;
          if (startColumn < 0 && match >= textOffset && match < nextOffset) startColumn = column;
          if (match + marker.length > textOffset && match + marker.length <= nextOffset) {
            endColumn = column;
            break;
          }
          textOffset = nextOffset;
        }
        const bounds = canvas.getBoundingClientRect();
        return {
          startX: bounds.left + (startColumn + 0.25) * (bounds.width / frame.frame.width),
          endX: bounds.left + (endColumn + 0.75) * (bounds.width / frame.frame.width),
          y: bounds.top + (row + 0.5) * (bounds.height / frame.frame.height),
        };
      }
      throw new Error('copy marker is not visible');
    }, copyMarker);
    await page.mouse.dblclick(selection.startX, selection.y);
    await expect.poll(async () => page.evaluate(() => window.__floetermPerfHarness.getSelectionText())).toBe(copyMarker);

    await page.mouse.click(selection.startX, selection.y, { clickCount: 3 });
    await expect.poll(async () => page.evaluate(() => window.__floetermPerfHarness.getSelectionText())).toBe(copyMarker);

    await page.mouse.move(selection.startX, selection.y);
    await page.mouse.down();
    await page.mouse.move(selection.endX, selection.y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => page.evaluate(() => window.__floetermPerfHarness.getSelectionText())).toBe(copyMarker);

    await page.locator('textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.press('Meta+C');
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(copyMarker);

    const pasteText = 'paste-one\npaste-中🙂';
    const expectedPaste = Buffer.from(`\x1b[200~${pasteText}\x1b[201~`);
    const sourceHex = Buffer.from(pasteProbeSource, 'utf8').toString('hex');
    await page.evaluate(({ expectedBytes, source }) => {
      window.__floetermPerfHarness.sendInput(
        `FLOETERM_PASTE_BYTES=${expectedBytes} python3 -c "exec(bytes.fromhex('${source}').decode())"\r`,
      );
    }, { expectedBytes: expectedPaste.length, source: sourceHex });
    await waitForMarker(page, 'FLOETERM_CLIPBOARD_PASTE_READY');
    await page.evaluate(value => navigator.clipboard.writeText(value), pasteText);
    await page.locator('textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.press('Meta+V');
    await waitForMarker(page, `FLOETERM_CLIPBOARD_PASTE_GOT_${expectedPaste.toString('hex')}`);

    await expect(page.locator('.terminalRendererError')).toHaveCount(0);
    expect(failures).toEqual([]);
  } finally {
    await page.close();
    await request.delete(`/api/sessions/${encodeURIComponent(session.id)}`, { timeout: 5_000 });
  }
});
