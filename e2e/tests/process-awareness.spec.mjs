import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const activeSession = async (request, sessionId) => {
  const response = await request.get('/api/sessions');
  if (!response.ok()) throw new Error(`session list failed: ${response.status()}`);
  const sessions = await response.json();
  return sessions.find(session => session.id === sessionId) ?? null;
};

test('reports silent and fullscreen foreground commands without idle false positives', async ({ page, request }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]')
    .getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);

  await expect.poll(async () => {
    const session = await activeSession(request, sessionId);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('idle:unknown');

  // Keep the silent command alive across loaded-suite scheduling jitter so the
  // poll asserts the lifecycle transition instead of racing its completion.
  await page.evaluate(() => window.__floetermPerfHarness.sendInput('sleep 2\r'));
  await expect.poll(async () => {
    const session = await activeSession(request, sessionId);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.foregroundCommand?.displayName ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('running:sleep:unknown');
  await expect.poll(async () => {
    const session = await activeSession(request, sessionId);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('idle:unknown');

  await page.evaluate(() => window.__floetermPerfHarness.sendInput('top\r'));
  await expect.poll(async () => {
    const session = await activeSession(request, sessionId);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.foregroundCommand?.displayName ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('running:top:streaming');
  await page.evaluate(() => window.__floetermPerfHarness.sendInput('q'));
  await expect.poll(async () => {
    const session = await activeSession(request, sessionId);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('idle:unknown');

  expect(failures).toEqual([]);
});

test('reports output streaming and quiet boundaries while the command remains running', async ({ page, request }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]')
    .getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);

  await expect.poll(async () => {
    const session = await activeSession(request, sessionId);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('idle:unknown');

  await page.evaluate(() => window.__floetermPerfHarness.sendInput(
    "sh -c 'printf first; sleep 5; printf second; sleep 5'\r",
  ));
  await expect.poll(async () => {
    const session = await activeSession(request, sessionId);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.foregroundCommand?.displayName ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }).toBe('running:sh:streaming');
  await expect.poll(async () => (await activeSession(request, sessionId))?.outputActivity?.phase, { timeout: 7_000 }).toBe('settled');
  await expect.poll(async () => (await activeSession(request, sessionId))?.outputActivity?.phase, { timeout: 4_000 }).toBe('streaming');
  await expect.poll(async () => (await activeSession(request, sessionId))?.outputActivity?.phase, { timeout: 7_000 }).toBe('settled');
  await expect.poll(async () => {
    const session = await activeSession(request, sessionId);
    return `${session?.foregroundCommand?.phase ?? ''}:${session?.outputActivity?.phase ?? ''}`;
  }, { timeout: 7_000 }).toBe('idle:unknown');

  expect(failures).toEqual([]);
});
