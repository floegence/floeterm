import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';

const activeSession = async page => await page.evaluate(async () => {
  const response = await fetch('/api/sessions');
  if (!response.ok) throw new Error(`session list failed: ${response.status}`);
  const sessions = await response.json();
  const sessionId = sessionStorage.getItem('floeterm_session_id');
  return sessions.find(session => session.id === sessionId) ?? null;
});

test('reports silent and fullscreen foreground commands without idle false positives', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));

  await expect.poll(async () => (await activeSession(page))?.foregroundCommand?.phase).toBe('idle');

  // Keep the silent command alive across loaded-suite scheduling jitter so the
  // poll asserts the lifecycle transition instead of racing its completion.
  await page.evaluate(() => window.__floetermPerfHarness.sendInput('sleep 2\r'));
  await expect.poll(async () => {
    const command = (await activeSession(page))?.foregroundCommand;
    return `${command?.phase ?? ''}:${command?.displayName ?? ''}`;
  }).toBe('running:sleep');
  await expect.poll(async () => (await activeSession(page))?.foregroundCommand?.phase).toBe('idle');

  await page.evaluate(() => window.__floetermPerfHarness.sendInput('top\r'));
  await expect.poll(async () => {
    const command = (await activeSession(page))?.foregroundCommand;
    return `${command?.phase ?? ''}:${command?.displayName ?? ''}`;
  }).toBe('running:top');
  await page.evaluate(() => window.__floetermPerfHarness.sendInput('q'));
  await expect.poll(async () => (await activeSession(page))?.foregroundCommand?.phase).toBe('idle');

  expect(failures).toEqual([]);
});
