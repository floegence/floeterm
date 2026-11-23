import { expect, test } from '@playwright/test';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

test('paints a continuous application rail from PTY output', async ({ page }) => {
  await page.goto('/?mode=single&perf_probe=1');
  const state = page.getByTestId('demo-runtime-state');
  await expect(state).toHaveAttribute('data-single-session-id', /.+/);
  await waitForInteractiveShell(page, await state.getAttribute('data-single-session-id'));
  const canvas = page.locator('.semanticTerminalSurface');
  await canvas.click();
  await page.keyboard.insertText("printf '\\033[2J\\033[H\\033[38;2;11;202;33m│\\r\\n│\\r\\n┃\\r\\n┃\\r\\n█\\r\\n█\\033[0m\\r\\n'");
  await page.keyboard.press('Enter');
  await expect.poll(() => canvas.evaluate(element => {
    const { width, height } = element;
    const pixels = element.getContext('2d').getImageData(0, 0, width, height).data;
    const counts = [];
    for (let row = 0; row < height; row++) {
      let count = 0;
      for (let column = 0; column < Math.min(40, width); column++) {
        const offset = (row * width + column) * 4;
        if (pixels[offset] === 11 && pixels[offset + 1] === 202 && pixels[offset + 2] === 33) count++;
      }
      counts.push(count);
    }
    while (counts.length && counts.at(-1) === 0) counts.pop();
    return counts.length >= 60 && counts.every(count => count > 0) && new Set(counts).size === 3;
  })).toBe(true);
});

test('routes a browser wheel to a mouse-reporting alternate screen', async ({ page }) => {
  await page.goto('/?mode=single&perf_probe=1');
  const state = page.getByTestId('demo-runtime-state');
  await expect(state).toHaveAttribute('data-single-session-id', /.+/);
  await waitForInteractiveShell(page, await state.getAttribute('data-single-session-id'));
  const command = `python3 -c "import os,tty,termios,select; old=termios.tcgetattr(0); tty.setraw(0); os.write(1,b'\\x1b[?1049h\\x1b[?1000h\\x1b[?1006hWHEEL_READY'); data=os.read(0,256) if select.select([0],[],[],10)[0] else b''; os.write(1,b'\\x1b[?1000l\\x1b[?1049l'); termios.tcsetattr(0,termios.TCSANOW,old); print('received:'+data.hex())"\r`;
  await page.locator('.semanticTerminalSurface').click();
  await page.keyboard.insertText(command.trimEnd());
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__floetermPerfHarness.getPresentationDiagnostics()?.frame.bufferKind === 'alternate' ? 'ready' : window.__floetermPerfHarness.getVisibleLines().join('\n'))).toBe('ready');
  await page.locator('.semanticTerminalSurface').hover();
  await page.mouse.wheel(0, -80);
  await expect.poll(() => page.evaluate(() => window.__floetermPerfHarness.getVisibleLines().join('\n'))).toMatch(/received:1b5b3c36343b/);
});

test('delivers a fast stroke and a drag through the real PTY', async ({ page }) => {
  await page.goto('/?mode=single&perf_probe=1');
  const state = page.getByTestId('demo-runtime-state');
  await expect(state).toHaveAttribute('data-single-session-id', /.+/);
  await waitForInteractiveShell(page, await state.getAttribute('data-single-session-id'));
  const script = `import os,tty,termios,select,re,time
old=termios.tcgetattr(0)
tty.setraw(0)
os.write(1,b'\\x1b[?1049h\\x1b[?1002h\\x1b[?1006hREADY')
data=b''
deadline=time.monotonic()+10
while not data.endswith(b'm') and time.monotonic()<deadline:
 if select.select([0],[],[],0.1)[0]: data+=os.read(0,4096)
os.write(1,b'\\x1b[?1002l\\x1b[?1049l')
termios.tcsetattr(0,termios.TCSANOW,old)
print('STROKE',data.count(b'[<64;'),'DRAG',bool(re.search(rb'\\[<0;[0-9;]+M.*\\[<32;[0-9;]+M.*\\[<0;[0-9;]+m',data)))`;
  const command = `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(script).toString('base64')}'))"\r`;
  await page.locator('.semanticTerminalSurface').click();
  await page.keyboard.insertText(command.trimEnd());
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__floetermPerfHarness.getPresentationDiagnostics()?.frame.pointerReporting ? 'ready' : window.__floetermPerfHarness.getVisibleLines().join('\n'))).toBe('ready');
  const canvas = page.locator('.semanticTerminalSurface');
  await canvas.dispatchEvent('wheel', { deltaY: -80, deltaMode: 1, bubbles: true, cancelable: true });
  const bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + 32, bounds.y + 48);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 32, bounds.y + 96, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__floetermPerfHarness.getVisibleLines().join('\n'))).toContain('STROKE 80 DRAG True');
});
