import { expect, test } from '@playwright/test';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

test('routes a browser wheel to a mouse-reporting alternate screen', async ({ page }) => {
  await page.goto('/?mode=single&perf_probe=1');
  const state = page.getByTestId('demo-runtime-state');
  await expect(state).toHaveAttribute('data-single-session-id', /.+/);
  await waitForInteractiveShell(page, await state.getAttribute('data-single-session-id'));
  const command = `python3 -c "import os,tty,termios,select; old=termios.tcgetattr(0); tty.setraw(0); os.write(1,b'\\x1b[?1049h\\x1b[?1000h\\x1b[?1006hWHEEL_READY'); data=os.read(0,256) if select.select([0],[],[],10)[0] else b''; os.write(1,b'\\x1b[?1000l\\x1b[?1049l'); termios.tcsetattr(0,termios.TCSANOW,old); print('received:'+data.hex())"\r`;
  await page.evaluate(text => window.__floetermPerfHarness.sendInput(text), command);
  await page.waitForFunction(() => window.__floetermPerfHarness.getPresentationDiagnostics()?.frame.bufferKind === 'alternate');
  await page.locator('.semanticTerminalSurface').hover();
  await page.mouse.wheel(0, -80);
  await expect.poll(() => page.evaluate(() => window.__floetermPerfHarness.getVisibleLines().join('\n'))).toMatch(/received:1b5b3c36343b/);
});
