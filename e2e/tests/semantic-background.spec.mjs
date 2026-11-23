import { expect, test } from '@playwright/test';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

test('paints only the erased span, including empty cells after wide text', async ({ page }) => {
  await page.goto('/?mode=single&perf_probe=1');
  const state = page.getByTestId('demo-runtime-state');
  await expect(state).toHaveAttribute('data-single-session-id', /.+/);
  await waitForInteractiveShell(page, await state.getAttribute('data-single-session-id'));
  const canvas = page.locator('.semanticTerminalSurface');
  await canvas.click();
  await page.keyboard.insertText("printf '\\033[2J\\033[H\\033[48;2;12;34;56m\\033[2K> 长沙天气\\033[0m\\033[2;8H\\033[48;2;12;34;56m\\033[K\\033[0m\\r\\n'");
  await page.keyboard.press('Enter');
  await expect.poll(() => canvas.evaluate(element => {
    const { width, height } = element;
    const pixels = element.getContext('2d').getImageData(0, 0, width, height).data;
    const spans = [];
    for (let row = 0; row < height; row++) {
      let first = -1, last = -1;
      for (let col = 0; col < width; col++) {
        const index = (row * width + col) * 4;
        if (pixels[index] !== 12 || pixels[index + 1] !== 34 || pixels[index + 2] !== 56) continue;
        if (first < 0) first = col;
        last = col;
      }
      if (last > width * 0.94) spans.push(first);
    }
    return spans.includes(0) && spans.some(first => first > 30 && first < width / 2);
  })).toBe(true);
});
