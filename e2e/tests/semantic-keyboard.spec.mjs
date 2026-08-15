import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const rawProbeSource = String.raw`
import os, select, termios, tty

normal_count = int(os.environ['FLOETERM_NORMAL_KEY_COUNT'])
kitty_count = int(os.environ['FLOETERM_KITTY_KEY_COUNT'])
old = termios.tcgetattr(0)
tty.setraw(0)

def sample(label, index):
    os.write(1, f'\r\n{label}_READY_{index}\r\n'.encode())
    ready, _, _ = select.select([0], [], [], 1.5)
    data = os.read(0, 4096) if ready else b''
    while select.select([0], [], [], 0.05)[0]:
        data += os.read(0, 4096)
    os.write(1, f'{label}_GOT_{index}_{data.hex()}\r\n'.encode())

try:
    for index in range(normal_count):
        sample('NORMAL', index)
    os.write(1, b'\x1b[>3u')
    for index in range(kitty_count):
        sample('KITTY', index)
    os.write(1, b'\x1b[<u')
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)
    os.write(1, b'\r\nPROBE_DONE\r\n')
`;

const waitForMarker = async (page, marker) => {
  await expect.poll(async () => page.evaluate(() => window.__floetermPerfHarness.serialize()))
    .toContain(marker);
};

test('delivers common terminal shortcuts exactly once through legacy and Kitty keyboard modes', async ({ page, request }) => {
  test.skip(process.platform === 'win32', 'raw PTY keyboard coverage requires termios');
  const failures = captureBrowserFailures(page);
  const response = await request.post('/api/sessions', { data: { name: `semantic-keyboard-${Date.now()}`, workingDir: '' } });
  expect(response.ok()).toBe(true);
  const session = await response.json();
  await page.goto(`/?mode=single&session=${encodeURIComponent(session.id)}&perf_probe=1`);
  await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected && window.__floetermPerfHarness.getTerminalInfo());
  await waitForInteractiveShell(page, session.id);
  const shellReadyNonce = Date.now();
  const shellReady = `FLOETERM_KEYBOARD_SHELL_READY_${shellReadyNonce}`;
  await page.evaluate(nonce => {
    window.__floetermPerfHarness.sendInput(`printf 'FLOETERM_KEYBOARD_SHELL_%s\\n' 'READY_${nonce}'\r`);
  }, shellReadyNonce);
  await waitForMarker(page, shellReady);

  const controlLetters = Array.from({ length: 26 }, (_, index) => {
    const letter = String.fromCharCode('A'.charCodeAt(0) + index);
    const codepoint = 'a'.charCodeAt(0) + index;
    const expectedHex = letter === 'I' || letter === 'M'
      ? Buffer.from(`\x1b[${codepoint};5u`, 'binary').toString('hex')
      : (index + 1).toString(16).padStart(2, '0');
    return [`Control+${letter}`, expectedHex];
  });
  const normal = [
    ...controlLetters,
    ['Alt+b', '1b62'],
    ['Control+ArrowLeft', '1b5b313b3544'],
    ['Control+ArrowRight', '1b5b313b3543'],
    ['Home', '1b5b48'],
    ['End', '1b5b46'],
    ['Delete', '1b5b337e'],
    ['Shift+Tab', '1b5b5a'],
  ];
  if (process.platform === 'darwin') normal.push(['Meta+C', '']);
  const kitty = [
    ['Control+A', '1b5b39373b35751b5b39373b353a3375'],
    ['Control+C', '1b5b39393b35751b5b39393b353a3375'],
    ['Control+E', '1b5b3130313b35751b5b3130313b353a3375'],
  ];
  const sourceHex = Buffer.from(rawProbeSource, 'utf8').toString('hex');
  await page.evaluate(({ sourceHex: hex, normalCount, kittyCount }) => {
    const command = `FLOETERM_NORMAL_KEY_COUNT=${normalCount} FLOETERM_KITTY_KEY_COUNT=${kittyCount} python3 -c "exec(bytes.fromhex('${hex}').decode())"\r`;
    window.__floetermPerfHarness.sendInput(command);
  }, { sourceHex, normalCount: normal.length, kittyCount: kitty.length });

  const input = page.locator('textarea[aria-label="Terminal input"]');
  await input.focus();
  for (const [index, [key, expectedHex]] of normal.entries()) {
    await waitForMarker(page, `NORMAL_READY_${index}`);
    await page.keyboard.press(key);
    await waitForMarker(page, `NORMAL_GOT_${index}_${expectedHex}`);
  }
  for (const [index, [key, expectedHex]] of kitty.entries()) {
    await waitForMarker(page, `KITTY_READY_${index}`);
    await page.keyboard.press(key);
    await waitForMarker(page, `KITTY_GOT_${index}_${expectedHex}`);
  }

  await waitForMarker(page, 'PROBE_DONE');
  await expect(page.locator('.terminalRendererError')).toHaveCount(0);
  expect(failures).toEqual([]);
});
