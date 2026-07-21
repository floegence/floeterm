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

  await expect.poll(async () => {
    const session = await activeSession(page);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('idle:unknown');

  // Keep the silent command alive across loaded-suite scheduling jitter so the
  // poll asserts the lifecycle transition instead of racing its completion.
  await page.evaluate(() => window.__floetermPerfHarness.sendInput('sleep 2\r'));
  await expect.poll(async () => {
    const session = await activeSession(page);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.foregroundCommand?.displayName ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('running:sleep:unknown');
  await expect.poll(async () => {
    const session = await activeSession(page);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('idle:unknown');

  await page.evaluate(() => window.__floetermPerfHarness.sendInput('top\r'));
  await expect.poll(async () => {
    const session = await activeSession(page);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.foregroundCommand?.displayName ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('running:top:streaming');
  await page.evaluate(() => window.__floetermPerfHarness.sendInput('\x03'));
  await expect.poll(async () => {
    const session = await activeSession(page);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('idle:unknown');

  expect(failures).toEqual([]);
});

test('reports output streaming and quiet boundaries while the command remains running', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));

  await page.evaluate(() => window.__floetermPerfHarness.sendInput(
    "sh -c 'printf first; sleep 5; printf second; sleep 5'\r",
  ));
  await expect.poll(async () => {
    const session = await activeSession(page);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.foregroundCommand?.displayName ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('running:sh:streaming');
  await expect.poll(async () => (await activeSession(page))?.outputActivity?.phase, { timeout: 7_000 }).toBe('settled');
  await expect.poll(async () => (await activeSession(page))?.outputActivity?.phase, { timeout: 4_000 }).toBe('streaming');
  await expect.poll(async () => (await activeSession(page))?.outputActivity?.phase, { timeout: 7_000 }).toBe('settled');
  await expect.poll(async () => {
    const session = await activeSession(page);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }, { timeout: 7_000 }).toBe('idle:unknown');

  expect(failures).toEqual([]);
});
