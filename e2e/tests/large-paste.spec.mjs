import { createHash } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';

const PASTE_BYTES = 2 * 1024 * 1024;
const PASTE_PATTERN = 'A中文😀\n';
const PASTE_PATTERN_BYTES = Buffer.byteLength(PASTE_PATTERN);

const buildExpectedPaste = () => {
  const repetitions = Math.floor(PASTE_BYTES / PASTE_PATTERN_BYTES);
  const remainder = PASTE_BYTES - repetitions * PASTE_PATTERN_BYTES;
  return PASTE_PATTERN.repeat(repetitions) + 'X'.repeat(remainder);
};

test('preserves a 2 MiB Unicode native paste through the live protocol and real PTY', async ({ page, request }) => {
  const consoleErrors = captureBrowserFailures(page);
  const createResponse = await request.post('/api/sessions', {
    data: { name: `large-paste-${Date.now()}`, workingDir: '' },
  });
  expect(createResponse.ok()).toBe(true);
  const session = await createResponse.json();

  try {
    await page.goto(`/?mode=single&session=${encodeURIComponent(session.id)}&perf_probe=1`);
    await page.waitForFunction(expectedSessionId => {
      const runtime = document.querySelector('[data-testid="demo-runtime-state"]');
      const harness = window.__floetermPerfHarness;
      return runtime?.getAttribute('data-single-session-id') === expectedSessionId
        && harness?.getSnapshot().connection.isConnected
        && harness.getTerminalInfo();
    }, session.id);

    const readyMarker = 'FLOETERM_LARGE_PASTE_READY';
    const resultMarker = 'FLOETERM_LARGE_PASTE_RESULT';
    const readyHex = Buffer.from(`\x1b[?2004l${readyMarker}\r\n`).toString('hex');
    const resultHex = Buffer.from(`\r\n${resultMarker} `).toString('hex');
    const command = [
      'python3 -c "import hashlib,os,sys,termios,tty;',
      `n=${PASTE_BYTES};old=termios.tcgetattr(0);tty.setraw(0);`,
      `os.write(1,bytes.fromhex('${readyHex}'));`,
      'd=sys.stdin.buffer.read(n);',
      'termios.tcsetattr(0,termios.TCSANOW,old);',
      `os.write(1,bytes.fromhex('${resultHex}')+str(len(d)).encode()+b' '+hashlib.sha256(d).hexdigest().encode()+b'\\r\\n')"`,
    ].join('');
    await page.evaluate(value => window.__floetermPerfHarness.sendInput(`${value}\r`), command);
    await page.waitForFunction(marker => window.__floetermPerfHarness.serialize().includes(marker), readyMarker);

    const expectedPaste = buildExpectedPaste();
    expect(Buffer.byteLength(expectedPaste)).toBe(PASTE_BYTES);
    const expectedHash = createHash('sha256').update(expectedPaste).digest('hex');
    const dispatch = await page.evaluate(({ bytes, pattern, patternBytes }) => {
      const textarea = document.querySelector('textarea[aria-label="Terminal input"]');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('terminal input textarea is unavailable');
      const repetitions = Math.floor(bytes / patternBytes);
      const payload = pattern.repeat(repetitions) + 'X'.repeat(bytes - repetitions * patternBytes);
      if (new TextEncoder().encode(payload).byteLength !== bytes) throw new Error('paste payload byte length mismatch');
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', payload);
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
      const startedAt = performance.now();
      textarea.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented, dispatchMs: performance.now() - startedAt };
    }, { bytes: PASTE_BYTES, pattern: PASTE_PATTERN, patternBytes: PASTE_PATTERN_BYTES });

    expect(dispatch.defaultPrevented).toBe(true);
    await page.waitForFunction(
      expected => window.__floetermPerfHarness.serialize().includes(expected),
      `${resultMarker} ${PASTE_BYTES} ${expectedHash}`,
      { timeout: 30_000 },
    );
    const finalState = await page.evaluate(() => ({
      snapshot: window.__floetermPerfHarness.getSnapshot(),
      stream: window.__floetermPerfHarness.getStreamDiagnostics(),
      serialized: window.__floetermPerfHarness.serialize(),
    }));
    expect(finalState.serialized).toContain(`${resultMarker} ${PASTE_BYTES} ${expectedHash}`);
    expect(finalState.snapshot.connection.isConnected).toBe(true);
    expect(finalState.snapshot.state.hasError).toBe(false);
    expect(finalState.stream.sequenceGaps).toBe(0);
    expect(consoleErrors).toEqual([]);
  } finally {
    await request.delete(`/api/sessions/${encodeURIComponent(session.id)}`);
  }
});
