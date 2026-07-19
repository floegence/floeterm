import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import {
  evaluateStandalonePerformanceReport,
  nearestRankPercentile,
} from './standalonePerformanceReport.mjs';

const args = new Map(process.argv.slice(2).map(value => {
  const index = value.indexOf('=');
  return index === -1 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)];
}));
const baseURL = args.get('--url') || 'http://localhost:8280';
const reportPath = path.resolve(args.get('--report') || '/tmp/floeterm-standalone-performance.json');
const evidenceDir = path.resolve(
  args.get('--evidence-dir') || path.join(path.dirname(reportPath), 'floeterm-performance-evidence'),
);
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pasteBytes = 5 * 1024 * 1024;
const pastePattern = 'A中文😀\n';
const pastePatternBytes = Buffer.byteLength(pastePattern);
const plainBytes = 10 * 1024 * 1024;
const ansiBytes = 5 * 1024 * 1024;

const round = (value, digits = 3) => Number(Number(value || 0).toFixed(digits));
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();

const waitForReady = async (page, label = 'initial load') => {
  try {
    await page.waitForFunction(() => {
      const harness = window.__floetermPerfHarness;
      const probe = window.__floetermPerfProbe;
      return Boolean(harness && probe && harness.getSnapshot().connection?.isConnected);
    });
    await page.waitForFunction(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      return canvases.some(canvas => getComputedStyle(canvas).opacity !== '0' && canvas.width > 0 && canvas.height > 0);
    });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      href: window.location.href,
      hasHarness: Boolean(window.__floetermPerfHarness),
      hasProbe: Boolean(window.__floetermPerfProbe),
      snapshot: window.__floetermPerfHarness?.getSnapshot?.() ?? null,
      bodyText: document.body.innerText.slice(0, 2000),
      canvases: Array.from(document.querySelectorAll('canvas')).map(canvas => ({
        className: canvas.className,
        width: canvas.width,
        height: canvas.height,
        opacity: getComputedStyle(canvas).opacity,
      })),
    })).catch(value => ({ diagnosticsError: String(value) }));
    throw new Error(`${label} did not become ready: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
};

const waitForMirrorReady = async (page, label = 'mirror load') => {
  try {
    await page.waitForFunction(() => {
      const harness = window.__floetermMirrorHarness;
      return Boolean(
        harness
        && harness.getViews().length === 2
        && harness.getViews().every(view => view.getSnapshot().connection?.isConnected && view.getTerminalInfo()),
      );
    });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      href: window.location.href,
      hasHarness: Boolean(window.__floetermMirrorHarness),
      runtimeState: window.__floetermMirrorHarness?.getRuntimeState?.() ?? null,
      views: window.__floetermMirrorHarness?.getViews?.().map(view => ({
        label: view.label,
        info: view.getTerminalInfo(),
        snapshot: view.getSnapshot(),
      })) ?? [],
      bodyText: document.body.innerText.slice(0, 2000),
    })).catch(value => ({ diagnosticsError: String(value) }));
    throw new Error(`${label} did not become ready: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
};

const collectMirrorState = async page => await page.evaluate(() => {
  const harness = window.__floetermMirrorHarness;
  if (!harness) throw new Error('mirror performance harness is unavailable');
  return {
    runtime: harness.getRuntimeState(),
    views: harness.getViews().map(view => ({
      label: view.label,
      info: view.getTerminalInfo(),
      viewport: view.getSnapshot().state.dimensions,
      connected: view.getSnapshot().connection.isConnected,
      serialized: view.serialize(),
    })),
  };
});

const collectSinglePageResizeState = async (page, includeTerminalState = false) => await page.evaluate(includeState => {
  const harness = window.__floetermPerfHarness;
  const runtime = document.querySelector('[data-testid="demo-runtime-state"]');
  if (!harness || !runtime) throw new Error('single-page performance harness is unavailable');
  return {
    connection_id: runtime.getAttribute('data-connection-id'),
    host: harness.getSnapshot().state.dimensions,
    effective: harness.getTerminalInfo(),
    geometry: harness.getGeometryDiagnostics(),
    stream: harness.getStreamDiagnostics(),
    probe: window.__floetermPerfProbe.snapshot(),
    serialized: includeState ? harness.serialize() : '',
  };
}, includeTerminalState);

const collectStableSerializedState = async page => await page.evaluate(() => new Promise(resolve => {
  let previous = '';
  let stableFrames = 0;
  const observe = () => {
    const current = window.__floetermPerfHarness.serialize();
    stableFrames = current === previous ? stableFrames + 1 : 0;
    previous = current;
    if (stableFrames >= 2) {
      resolve(current);
      return;
    }
    requestAnimationFrame(observe);
  };
  requestAnimationFrame(observe);
}));

const applyTerminalHostSize = async (page, width, height) => {
  await page.evaluate(({ nextWidth, nextHeight }) => {
    const container = document.querySelector('.terminalContainer');
    if (!(container instanceof HTMLElement)) throw new Error('terminal host container is unavailable');
    container.style.flex = 'none';
    container.style.width = `${nextWidth}px`;
    container.style.height = `${nextHeight}px`;
    window.__floetermPerfHarness.forceResize();
  }, { nextWidth: width, nextHeight: height });
};

const waitForMultiPageResizeConvergence = async (firstPage, secondPage, minimumGeneration = 0) => {
  const deadline = performance.now() + 5000;
  let last = null;
  while (performance.now() < deadline) {
    const [first, second] = await Promise.all([
      collectSinglePageResizeState(firstPage),
      collectSinglePageResizeState(secondPage),
    ]);
    const expected = {
      cols: Math.min(first.host.cols, second.host.cols),
      rows: Math.min(first.host.rows, second.host.rows),
    };
    last = { first, second, expected };
    if (
      first.effective?.cols === expected.cols
      && first.effective?.rows === expected.rows
      && second.effective?.cols === expected.cols
      && second.effective?.rows === expected.rows
      && first.geometry.cols === expected.cols
      && first.geometry.rows === expected.rows
      && second.geometry.cols === expected.cols
      && second.geometry.rows === expected.rows
      && first.geometry.generation === second.geometry.generation
      && first.geometry.generation > minimumGeneration
    ) return last;
    await new Promise(resolve => setTimeout(resolve, 4));
  }
  throw new Error(`multi-page resize did not converge: ${JSON.stringify(last)}`);
};

const createPerformanceSession = async name => {
  const response = await fetch(`${baseURL}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, workingDir: '' }),
  });
  if (!response.ok) throw new Error(`create performance session returned ${response.status}`);
  return await response.json();
};

const deletePerformanceSession = async sessionId => {
  const response = await fetch(`${baseURL}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete performance session returned ${response.status}`);
  }
};

const collectRuntime = async page => await page.evaluate(async () => {
  const response = await fetch('/api/performance/runtime');
  if (!response.ok) throw new Error(`performance diagnostics returned ${response.status}`);
  return await response.json();
});

const collectRuntimeFromNode = async () => {
  const response = await fetch(`${baseURL}/api/performance/runtime`);
  if (!response.ok) throw new Error(`performance diagnostics returned ${response.status}`);
  return await response.json();
};

const collectStableRuntime = async page => {
  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    samples.push(await collectRuntime(page));
    await page.waitForTimeout(150);
  }
  return {
    goroutines: Math.min(...samples.map(sample => Number(sample.goroutines))),
    heap_bytes: Math.min(...samples.map(sample => Number(sample.heap_bytes))),
    session_count: samples.at(-1).session_count,
    active_session_count: samples.at(-1).active_session_count,
    connection_count: samples.at(-1).connection_count,
    live_attachment_count: samples.at(-1).live_attachment_count,
  };
};

const collectStableRuntimeFromNode = async () => {
  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    samples.push(await collectRuntimeFromNode());
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return {
    goroutines: Math.min(...samples.map(sample => Number(sample.goroutines))),
    heap_bytes: Math.min(...samples.map(sample => Number(sample.heap_bytes))),
    session_count: samples.at(-1).session_count,
    active_session_count: samples.at(-1).active_session_count,
    connection_count: samples.at(-1).connection_count,
    live_attachment_count: samples.at(-1).live_attachment_count,
  };
};

const collectHeapMiB = async (page, cdp) => {
  await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(100);
  const snapshot = await page.evaluate(() => window.__floetermPerfProbe.snapshot());
  return Number(snapshot.heapMB ?? 0);
};

const resetProbe = async page => {
  await page.evaluate(() => window.__floetermPerfProbe.reset());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

const startSentinel = async page => {
  await page.evaluate(() => {
    const state = { active: true, samples: [] };
    window.__floetermSentinel = state;
    const tick = () => {
      if (!state.active) return;
      const startedAt = performance.now();
      setTimeout(() => {
        state.samples.push(Math.max(0, performance.now() - startedAt));
        requestAnimationFrame(tick);
      }, 0);
    };
    requestAnimationFrame(tick);
  });
};

const stopSentinel = async page => await page.evaluate(() => {
  const state = window.__floetermSentinel;
  if (!state) return [];
  state.active = false;
  return [...state.samples];
});

const visibleCanvas = async page => {
  const index = await page.locator('canvas').evaluateAll(canvases => canvases.findIndex(canvas => (
    getComputedStyle(canvas).opacity !== '0' && canvas.width > 0 && canvas.height > 0
  )));
  if (index < 0) throw new Error('visible Beamterm canvas was not found');
  return page.locator('canvas').nth(index);
};

const captureVisibleCanvas = async page => {
  const previousVisibility = await page.evaluate(() => {
    const overlay = document.querySelector('.perfProbe');
    if (!(overlay instanceof HTMLElement)) return null;
    const previous = overlay.style.visibility;
    overlay.style.visibility = 'hidden';
    return previous;
  });
  try {
    await settleVisibleCanvas(page);
    return await (await visibleCanvas(page)).screenshot();
  } finally {
    await page.evaluate(previous => {
      const overlay = document.querySelector('.perfProbe');
      if (overlay instanceof HTMLElement) overlay.style.visibility = previous ?? '';
    }, previousVisibility);
  }
};

const collectGoroutineProfile = async page => await page.evaluate(async () => {
  const response = await fetch('/api/performance/goroutines');
  if (!response.ok) throw new Error(`goroutine diagnostics returned ${response.status}`);
  return await response.text();
});

const clearTerminal = async page => {
  await page.evaluate(() => window.__floetermPerfHarness.clear());
  await page.waitForTimeout(250);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

const resetTerminalState = async page => {
  const marker = 'FLOETERM_RESET_READY';
  const resetHex = Buffer.from(`\x1bc\x1b[?25l${marker}\n`).toString('hex');
  const command = `python3 -c "import os; os.write(1,bytes.fromhex('${resetHex}'))"`;
  await page.evaluate(value => window.__floetermPerfHarness.sendInput(`${value}\r`), command);
  await page.waitForFunction(value => window.__floetermPerfHarness.serialize().includes(value), marker);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

const settleVisibleCanvas = async page => {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll('canvas')).find(candidate => (
      getComputedStyle(candidate).opacity !== '0' && candidate.width > 0 && candidate.height > 0
    ));
    canvas?.getContext('webgl2')?.finish();
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
};

const runOutputCase = async ({ page, command, marker, expectedBytes }) => {
  await resetProbe(page);
  await startSentinel(page);
  const startedAt = await page.evaluate(() => performance.now());
  await page.evaluate(value => window.__floetermPerfHarness.sendInput(`${value}\r`), command);
  try {
    await page.waitForFunction(minimumBytes => {
      const probe = window.__floetermPerfProbe.snapshot();
      return probe.terminalWriteBytes >= minimumBytes;
    }, expectedBytes, { timeout: 30_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(outputMarker => ({
      probe: window.__floetermPerfProbe.snapshot(),
      markerVisible: window.__floetermPerfHarness.serialize().includes(outputMarker),
      connection: window.__floetermPerfHarness.getSnapshot().connection,
      state: window.__floetermPerfHarness.getSnapshot().state.state,
    }), marker);
    throw new Error(`output completion timed out: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  const durationMs = await page.evaluate(start => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
  }), startedAt);
  const snapshot = await page.evaluate(() => window.__floetermPerfProbe.snapshot());
  const markerVisible = await page.evaluate(outputMarker => (
    window.__floetermPerfHarness.serialize().includes(outputMarker)
  ), marker);
  if (!markerVisible) {
    throw new Error(`output marker was not visible after ${snapshot.terminalWriteBytes} terminal bytes`);
  }
  const sentinelSamples = await stopSentinel(page);
  return { durationMs, snapshot, sentinelSamples };
};

const report = {
  suite: 'floeterm_standalone_live_v1_performance',
  generated_at: new Date().toISOString(),
  source: {
    commit: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    dirty_hash: hash(`${git('status', '--porcelain=v1', '-z')}\n${git('diff', '--binary', 'HEAD')}`),
  },
  runner: {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model || 'unknown',
    logical_cpu_count: os.cpus().length,
    total_memory_bytes: os.totalmem(),
    url: baseURL,
    browser_mode: 'headed_hardware_webgl2',
  },
  metrics: {},
  functional: {},
  errors: [],
  runner_warnings: [],
};

const browser = await chromium.launch({
  headless: false,
  args: ['--js-flags=--expose-gc', '--disable-background-timer-throttling'],
});
report.runner.chromium = browser.version();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
page.on('pageerror', error => report.errors.push(`pageerror:${error.message}`));
page.on('response', response => {
  if (response.status() >= 400) {
    report.errors.push(`response:${response.status()}:${response.url()}`);
  }
});
page.on('console', message => {
  if (message.type() !== 'error' && message.type() !== 'warning') return;
  const text = message.text();
  report.errors.push(`console:${message.type()}:${text}`);
});

try {
  await page.goto(`${baseURL}/?mode=single&perf_probe=1`, { waitUntil: 'networkidle' });
  await waitForReady(page);
  report.runner.gpu_renderer = await page.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll('canvas')).find(candidate => (
      getComputedStyle(candidate).opacity !== '0' && candidate.width > 0 && candidate.height > 0
    ));
    if (!canvas) throw new Error('visible Beamterm canvas was not found');
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('Beamterm WebGL2 context was not available');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return String(debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER));
  });

  await resetProbe(page);
  await page.waitForTimeout(1200);
  const refreshSnapshot = await page.evaluate(() => window.__floetermPerfProbe.snapshot());
  const steadyRaf = refreshSnapshot.rafDurationsMs.filter(value => value > 4 && value < 40);
  report.runner.refresh_period_ms = round(nearestRankPercentile(steadyRaf, 0.5));

  const input = page.locator('textarea[aria-label="Terminal input"]');
  const terminalSurfaceBox = await page.locator('.terminalSurface').boundingBox();
  if (!terminalSurfaceBox) throw new Error('terminal surface has no interactive geometry');
  await page.mouse.click(terminalSurfaceBox.x + 24, terminalSurfaceBox.y + 24);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Terminal input');
  if (await input.count() !== 1) throw new Error('terminal input surface is not unique');
  await page.keyboard.press('Control+U');
  await resetProbe(page);
  for (let index = 0; index < 100; index += 1) {
    const before = await page.evaluate(() => window.__floetermPerfProbe.snapshot().keyToPaintMs.length);
    await page.keyboard.type('x');
    await page.waitForFunction(count => window.__floetermPerfProbe.snapshot().keyToPaintMs.length > count, before);
  }
  const keySnapshot = await page.evaluate(() => window.__floetermPerfProbe.snapshot());
  const keySamples = keySnapshot.keyToPaintMs.slice(0, 100);
  const repeatedState = await page.evaluate(() => window.__floetermPerfHarness.serialize());
  report.metrics.key_to_paint = {
    sample_count: keySamples.length,
    samples_ms: keySamples.map(value => round(value)),
    p95_ms: round(nearestRankPercentile(keySamples, 0.95)),
    p99_ms: round(nearestRankPercentile(keySamples, 0.99)),
  };
  report.functional.rapid_repeat_preserved = repeatedState.includes('x'.repeat(100));
  await page.keyboard.press('Control+U');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);

  const initialInfo = await page.evaluate(() => window.__floetermPerfHarness.getTerminalInfo());
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(300);
  const resizedInfo = await page.evaluate(() => window.__floetermPerfHarness.getTerminalInfo());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  report.functional.resize_applied = Boolean(
    initialInfo && resizedInfo && (initialInfo.cols !== resizedInfo.cols || initialInfo.rows !== resizedInfo.rows),
  );

  await clearTerminal(page);
  const pasteReadyMarker = 'FLOETERM_PERF_PASTE_READY';
  const pasteResultMarker = 'FLOETERM_PERF_PASTE_RESULT';
  const pasteReadyHex = Buffer.from(`\x1b[?2004l${pasteReadyMarker}\r\n`).toString('hex');
  const pasteResultHex = Buffer.from(`\r\n${pasteResultMarker} `).toString('hex');
  const pasteCommand = [
    'python3 -c "import hashlib,os,sys,termios,tty;',
    `n=${pasteBytes};old=termios.tcgetattr(0);tty.setraw(0);`,
    `os.write(1,bytes.fromhex('${pasteReadyHex}'));`,
    'd=sys.stdin.buffer.read(n);',
    'termios.tcsetattr(0,termios.TCSANOW,old);',
    `os.write(1,bytes.fromhex('${pasteResultHex}')+str(len(d)).encode()+b' '+hashlib.sha256(d).hexdigest().encode()+b'\\r\\n')"`,
  ].join('');
  await page.evaluate(value => window.__floetermPerfHarness.sendInput(`${value}\r`), pasteCommand);
  await page.waitForFunction(marker => window.__floetermPerfHarness.serialize().includes(marker), pasteReadyMarker);
  const expectedPasteHash = hash(
    pastePattern.repeat(Math.floor(pasteBytes / pastePatternBytes))
      + 'X'.repeat(pasteBytes % pastePatternBytes),
  );
  await page.evaluate(({ bytes, pattern, patternBytes }) => {
    const repetitions = Math.floor(bytes / patternBytes);
    window.__floetermPastePayload = pattern.repeat(repetitions) + 'X'.repeat(bytes - repetitions * patternBytes);
    if (new TextEncoder().encode(window.__floetermPastePayload).byteLength !== bytes) {
      throw new Error('large paste payload byte length mismatch');
    }
  }, { bytes: pasteBytes, pattern: pastePattern, patternBytes: pastePatternBytes });
  const pasteHeapBeforeMiB = await collectHeapMiB(page, cdp);
  await resetProbe(page);
  await startSentinel(page);
  const pasteDispatch = await page.evaluate(() => {
    const textarea = document.querySelector('textarea[aria-label="Terminal input"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('terminal input textarea is unavailable');
    const payload = window.__floetermPastePayload;
    if (typeof payload !== 'string') throw new Error('large paste payload is unavailable');
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', payload);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
    const startedAt = performance.now();
    textarea.dispatchEvent(event);
    return {
      startedAt,
      dispatchMs: performance.now() - startedAt,
      defaultPrevented: event.defaultPrevented,
    };
  });
  await page.waitForFunction(marker => window.__floetermPerfHarness.serialize().includes(marker), pasteResultMarker, {
    timeout: 30_000,
  });
  const pasteCompletionMs = await page.evaluate(startedAt => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - startedAt)));
  }), pasteDispatch.startedAt);
  const pasteSentinelSamples = await stopSentinel(page);
  const pasteSnapshot = await page.evaluate(() => window.__floetermPerfProbe.snapshot());
  const pasteResult = await page.evaluate(marker => {
    const serialized = window.__floetermPerfHarness.serialize();
    const match = serialized.match(new RegExp(`${marker} (\\d+) ([0-9a-f]{64})`));
    return match ? { receivedBytes: Number(match[1]), checksum: match[2] } : null;
  }, pasteResultMarker);
  await page.evaluate(() => { delete window.__floetermPastePayload; });
  const pasteHeapAfterMiB = await collectHeapMiB(page, cdp);
  report.metrics.large_paste = {
    input_bytes: pasteBytes,
    received_bytes: pasteResult?.receivedBytes ?? 0,
    expected_checksum: expectedPasteHash,
    received_checksum: pasteResult?.checksum ?? '',
    checksum_match: pasteResult?.checksum === expectedPasteHash,
    paste_event_consumed: pasteDispatch.defaultPrevented,
    dispatch_ms: round(pasteDispatch.dispatchMs),
    completion_ms: round(pasteCompletionMs),
    websocket_messages: pasteSnapshot.wsSentInputMessages,
    wire_bytes: pasteSnapshot.wsSentInputBytes,
    wire_ratio: round(pasteSnapshot.wsSentInputBytes / pasteBytes, 5),
    total_websocket_messages: pasteSnapshot.wsSentMessages,
    total_wire_bytes: pasteSnapshot.wsSentBytes,
    ui_sentinel_p95_ms: round(nearestRankPercentile(pasteSentinelSamples, 0.95)),
    heap_before_mib: round(pasteHeapBeforeMiB),
    heap_after_mib: round(pasteHeapAfterMiB),
    heap_delta_mib: round(Math.max(0, pasteHeapAfterMiB - pasteHeapBeforeMiB)),
    history_recovery_requests: pasteSnapshot.historyRequests,
  };

  const heapBeforeMiB = await collectHeapMiB(page, cdp);
  await clearTerminal(page);
  const plainMarker = 'FLOETERM_PERF_PLAIN_DONE';
  const plainCommand = `python3 -c "import os; os.write(1,b'A'*${plainBytes}); os.write(1,b'\\n${plainMarker}\\n')"`;
  const plain = await runOutputCase({
    page,
    command: plainCommand,
    marker: plainMarker,
    expectedBytes: plainBytes + plainMarker.length + plainCommand.length,
  });
  report.metrics.plain_output = {
    input_bytes: plainBytes,
    duration_ms: round(plain.durationMs),
    websocket_messages: plain.snapshot.wsMessages,
    wire_bytes: plain.snapshot.wsBytes,
    wire_ratio: round(plain.snapshot.wsBytes / plainBytes, 5),
    terminal_write_bytes: plain.snapshot.terminalWriteBytes,
    terminal_writes: plain.snapshot.terminalWrites,
    history_recovery_requests: plain.snapshot.historyRequests,
    sequence_gaps: report.errors.some(error => error.includes('expected output sequence')) ? 1 : 0,
    silent_drops: plain.snapshot.terminalWriteBytes >= plainBytes ? 0 : 1,
  };

  await clearTerminal(page);
  await resetTerminalState(page);
  const ansiMarker = 'FLOETERM_PERF_ANSI_DONE';
  const ansiPatternHex = Buffer.from('\x1b[31mRED\x1b[0m \x1b[1;34mWIDE\x1b[0m 中文 😀\n').toString('hex');
  const ansiSuffixHex = Buffer.from(`\n${ansiMarker}\n\x1b[?25l`).toString('hex');
  const ansiCommand = `python3 -c "import os; p=bytes.fromhex('${ansiPatternHex}'); s=bytes.fromhex('${ansiSuffixHex}'); n=${ansiBytes}; os.write(1,(p*((n+len(p)-1)//len(p)))[:n]+s)"`;
  const ansiFirst = await runOutputCase({
    page,
    command: ansiCommand,
    marker: ansiMarker,
    expectedBytes: ansiBytes + Buffer.byteLength(ansiSuffixHex, 'hex') + ansiCommand.length,
  });
  const firstCanvas = await captureVisibleCanvas(page);
  const firstState = await page.evaluate(() => ({
    serialized: window.__floetermPerfHarness.serialize(),
    info: window.__floetermPerfHarness.getTerminalInfo(),
  }));

  await clearTerminal(page);
  await resetTerminalState(page);
  const ansiSecond = await runOutputCase({
    page,
    command: ansiCommand,
    marker: ansiMarker,
    expectedBytes: ansiBytes + Buffer.byteLength(ansiSuffixHex, 'hex') + ansiCommand.length,
  });
  const secondCanvas = await captureVisibleCanvas(page);
  const secondState = await page.evaluate(() => ({
    serialized: window.__floetermPerfHarness.serialize(),
    info: window.__floetermPerfHarness.getTerminalInfo(),
  }));
  await mkdir(evidenceDir, { recursive: true });
  const firstCanvasPath = path.join(evidenceDir, 'ansi-first.png');
  const secondCanvasPath = path.join(evidenceDir, 'ansi-second.png');
  await Promise.all([
    writeFile(firstCanvasPath, firstCanvas),
    writeFile(secondCanvasPath, secondCanvas),
  ]);
  report.metrics.ansi_unicode_output = {
    input_bytes: ansiBytes,
    duration_ms: round(ansiFirst.durationMs),
    repeated_duration_ms: round(ansiSecond.durationMs),
    canvas_hash: hash(firstCanvas),
    repeated_canvas_hash: hash(secondCanvas),
    canvas_match: hash(firstCanvas) === hash(secondCanvas),
    terminal_state_hash: hash(JSON.stringify(firstState)),
    repeated_terminal_state_hash: hash(JSON.stringify(secondState)),
    terminal_state_match: hash(JSON.stringify(firstState)) === hash(JSON.stringify(secondState)),
    first_canvas_path: firstCanvasPath,
    repeated_canvas_path: secondCanvasPath,
  };

  const renderSamples = [
    ...plain.snapshot.terminalRenderDurationsMs,
    ...ansiFirst.snapshot.terminalRenderDurationsMs,
  ];
  report.metrics.render_frames = {
    sample_count: renderSamples.length,
    samples_ms: renderSamples.map(value => round(value)),
    p95_ms: round(nearestRankPercentile(renderSamples, 0.95)),
    p99_ms: round(nearestRankPercentile(renderSamples, 0.99)),
    max_ms: round(Math.max(0, ...renderSamples)),
  };
  const sentinelSamples = [...plain.sentinelSamples, ...ansiFirst.sentinelSamples];
  report.metrics.ui_sentinel = {
    sample_count: sentinelSamples.length,
    samples_ms: sentinelSamples.map(value => round(value)),
    p95_ms: round(nearestRankPercentile(sentinelSamples, 0.95)),
  };

  await clearTerminal(page);
  await page.reload({ waitUntil: 'networkidle' });
  await waitForReady(page, 'reconnect baseline warm-up');
  await page.waitForTimeout(500);
  const runtimeBeforeReconnect = await collectStableRuntime(page);
  const goroutinesBeforeReconnect = await collectGoroutineProfile(page);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    await page.reload({ waitUntil: 'networkidle' });
    await waitForReady(page, `reconnect iteration ${iteration + 1}`);
  }
  await page.waitForTimeout(500);
  const runtimeAfterReconnect = await collectStableRuntime(page);
  const goroutinesAfterReconnect = await collectGoroutineProfile(page);
  const heapAfterMiB = await collectHeapMiB(page, cdp);
  await mkdir(evidenceDir, { recursive: true });
  const goroutinesBeforePath = path.join(evidenceDir, 'goroutines-before-reconnect.txt');
  const goroutinesAfterPath = path.join(evidenceDir, 'goroutines-after-reconnect.txt');
  await Promise.all([
    writeFile(goroutinesBeforePath, goroutinesBeforeReconnect),
    writeFile(goroutinesAfterPath, goroutinesAfterReconnect),
  ]);
  report.metrics.reconnect = {
    iterations: 20,
    before: runtimeBeforeReconnect,
    after: runtimeAfterReconnect,
    goroutine_delta: runtimeAfterReconnect.goroutines - runtimeBeforeReconnect.goroutines,
    connection_delta: runtimeAfterReconnect.connection_count - runtimeBeforeReconnect.connection_count,
    live_attachment_delta: runtimeAfterReconnect.live_attachment_count - runtimeBeforeReconnect.live_attachment_count,
    heap_before_mib: round(heapBeforeMiB),
    heap_after_mib: round(heapAfterMiB),
    heap_delta_mib: round(Math.max(0, heapAfterMiB - heapBeforeMiB)),
    goroutines_before_path: goroutinesBeforePath,
    goroutines_after_path: goroutinesAfterPath,
  };

  report.functional.renderer_backend = await page.evaluate(() => ({
    visible_canvas_count: Array.from(document.querySelectorAll('canvas')).filter(canvas => getComputedStyle(canvas).opacity !== '0').length,
    hidden_canvas_count: Array.from(document.querySelectorAll('canvas')).filter(canvas => getComputedStyle(canvas).opacity === '0').length,
    renderer_error_count: document.querySelectorAll('.terminalRendererError').length,
  }));

  await page.goto('about:blank');
  await page.waitForTimeout(250);
  const mirrorRuntimeBaseline = await collectStableRuntimeFromNode();
  await page.goto(`${baseURL}/?mode=mirror&perf_probe=1`, { waitUntil: 'networkidle' });
  await waitForMirrorReady(page);
  let mirrorState = await collectMirrorState(page);
  const distinctViewDimensions = Boolean(
    mirrorState.views[0]?.viewport
    && mirrorState.views[1]?.viewport
    && (
      mirrorState.views[0].viewport.cols !== mirrorState.views[1].viewport.cols
      || mirrorState.views[0].viewport.rows !== mirrorState.views[1].viewport.rows
    ),
  );

  await page.evaluate(() => {
    window.__floetermMirrorHarness.getViews().forEach(view => view.resetStreamDiagnostics());
  });
  const consistencyMarkers = [
    'FLOETERM_MIRROR_CONSISTENCY_A',
    'FLOETERM_MIRROR_CONSISTENCY_B 中文 😀',
    'FLOETERM_MIRROR_CONSISTENCY_END',
  ];
  await page.evaluate(() => {
    window.__floetermMirrorHarness.getViews()[0].sendInput(
      "printf '\\033[3J\\033[2J\\033[HFLOETERM_MIRROR_CONSISTENCY_A\\nFLOETERM_MIRROR_CONSISTENCY_B 中文 😀\\nFLOETERM_MIRROR_CONSISTENCY_END\\n'\r",
    );
  });
  await page.waitForFunction(marker => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes(marker))
  ), consistencyMarkers[2]);
  const consistencyState = await page.evaluate(markers => window.__floetermMirrorHarness.getViews().map(view => ({
    stream: view.getStreamDiagnostics(),
    markers: markers.map(marker => view.serialize().includes(marker)),
    serialized: view.serialize(),
  })), consistencyMarkers);
  const identicalOutputStreams = JSON.stringify(consistencyState[0]?.stream) === JSON.stringify(consistencyState[1]?.stream);
  const semanticMarkersVisibleInBoth = consistencyState.every(view => view.markers.every(Boolean));
  const identicalTerminalState = consistencyState[0]?.serialized === consistencyState[1]?.serialized;

  const firstMirrorMarker = 'FLOETERM_MIRROR_FIRST_INPUT';
  await page.evaluate(marker => {
    window.__floetermMirrorHarness.getViews()[0].sendInput(`printf '${marker}\\n'\r`);
  }, firstMirrorMarker);
  await page.waitForFunction(marker => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes(marker))
  ), firstMirrorMarker);
  const firstInputVisibleInBoth = (await collectMirrorState(page)).views
    .every(view => view.serialized.includes(firstMirrorMarker));

  const sizeMarker = 'FLOETERM_MIRROR_STTY';
  await page.evaluate(marker => {
    window.__floetermMirrorHarness.getViews()[1].sendInput(`printf '${marker} '; stty size\r`);
  }, sizeMarker);
  await page.waitForFunction(marker => (
    window.__floetermMirrorHarness.getViews().every(view => new RegExp(`${marker} \\d+ \\d+`).test(view.serialize()))
  ), sizeMarker);
  mirrorState = await collectMirrorState(page);
  const sizeMatch = mirrorState.views[0]?.serialized.match(new RegExp(`${sizeMarker} (\\d+) (\\d+)`));
  const expectedMirrorRows = Math.min(...mirrorState.views.map(view => view.viewport.rows));
  const expectedMirrorCols = Math.min(...mirrorState.views.map(view => view.viewport.cols));
  const sharedPTYUsesMinimumDimensions = Boolean(
    sizeMatch
    && Number(sizeMatch[1]) === expectedMirrorRows
    && Number(sizeMatch[2]) === expectedMirrorCols,
  );

  const mirrorLatencySamples = [];
  await page.evaluate(() => window.__floetermMirrorHarness.getViews()[0].sendInput('\x15'));
  const mirrorLatencyCharacters = '0123456789abcdefghijklmnopqrst';
  for (let index = 0; index < 30; index += 1) {
    const character = mirrorLatencyCharacters[index];
    const durationMs = await page.evaluate(value => new Promise((resolve, reject) => {
      const harness = window.__floetermMirrorHarness;
      const views = harness.getViews();
      const renderCounts = views.map(view => view.getRenderDiagnostics().count);
      const startedAt = performance.now();
      const timeoutAt = startedAt + 5000;
      views[0].sendInput(value);
      const observe = () => {
        if (views.every((view, viewIndex) => view.getRenderDiagnostics().count > renderCounts[viewIndex])) {
          requestAnimationFrame(() => resolve(performance.now() - startedAt));
          return;
        }
        if (performance.now() >= timeoutAt) {
          const views = harness.getViews().map(view => ({
            label: view.label,
            info: view.getTerminalInfo(),
            render: view.getRenderDiagnostics(),
            stream: view.getStreamDiagnostics(),
          }));
          reject(new Error(`mirror input did not render in both views: ${JSON.stringify(views)}`));
          return;
        }
        requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    }), character);
    mirrorLatencySamples.push(durationMs);
  }
  await page.evaluate(() => window.__floetermMirrorHarness.getViews()[0].sendInput('\x15'));

  const reconnectStartedAt = await page.evaluate(() => {
    const started = performance.now();
    window.__floetermMirrorHarness.getViews()[0].reconnect();
    return started;
  });
  await waitForMirrorReady(page, 'mirror reconnect');
  const reconnectMs = await page.evaluate(start => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
  }), reconnectStartedAt);
  const runtimeAfterMirrorReconnect = await collectStableRuntime(page);
  const reconnectPreservedTwoAttachments = (
    runtimeAfterMirrorReconnect.connection_count - mirrorRuntimeBaseline.connection_count === 2
    && runtimeAfterMirrorReconnect.live_attachment_count - mirrorRuntimeBaseline.live_attachment_count === 2
  );

  const secondMirrorMarker = 'FLOETERM_MIRROR_SECOND_INPUT';
  await page.evaluate(marker => {
    window.__floetermMirrorHarness.getViews()[1].sendInput(`printf '${marker}\\n'\r`);
  }, secondMirrorMarker);
  await page.waitForFunction(marker => (
    window.__floetermMirrorHarness.getViews().every(view => view.serialize().includes(marker))
  ), secondMirrorMarker);
  const secondInputVisibleInBoth = (await collectMirrorState(page)).views
    .every(view => view.serialized.includes(secondMirrorMarker));

  await page.setViewportSize({ width: 1080, height: 720 });
  await page.evaluate(() => window.__floetermMirrorHarness.getViews().forEach(view => view.forceResize()));
  await waitForMirrorReady(page, 'mirror resize');
  const resizedMirrorRuntime = await collectStableRuntime(page);
  mirrorState = await collectMirrorState(page);
  const resizePreservedConnections = (
    resizedMirrorRuntime.connection_count - mirrorRuntimeBaseline.connection_count === 2
    && resizedMirrorRuntime.live_attachment_count - mirrorRuntimeBaseline.live_attachment_count === 2
    && mirrorState.runtime.connectedCount === 2
  );
  const mirrorRendererErrorCount = await page.locator('.terminalRendererError').count();

  report.metrics.mirror_same_session = {
    sample_count: mirrorLatencySamples.length,
    samples_ms: mirrorLatencySamples.map(value => round(value)),
    p95_ms: round(nearestRankPercentile(mirrorLatencySamples, 0.95)),
    p99_ms: round(nearestRankPercentile(mirrorLatencySamples, 0.99)),
    reconnect_ms: round(reconnectMs),
  };
  report.functional.mirror_same_session = {
    connected_views: mirrorState.runtime.connectedCount,
    distinct_view_dimensions: distinctViewDimensions,
    shared_pty_uses_minimum_dimensions: sharedPTYUsesMinimumDimensions,
    identical_output_streams: identicalOutputStreams,
    identical_terminal_state: identicalTerminalState,
    semantic_markers_visible_in_both: semanticMarkersVisibleInBoth,
    first_input_visible_in_both: firstInputVisibleInBoth,
    reconnect_preserved_two_attachments: reconnectPreservedTwoAttachments,
    second_input_visible_in_both: secondInputVisibleInBoth,
    resize_preserved_connections: resizePreservedConnections,
    renderer_error_count: mirrorRendererErrorCount,
  };

  await page.goto('about:blank');
  const multiPageSession = await createPerformanceSession(`multi-page-resize-${Date.now()}`);
  let multiPageSecond = null;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    multiPageSecond = await context.newPage();
    await multiPageSecond.setViewportSize({ width: 1100, height: 900 });
    multiPageSecond.on('pageerror', error => report.errors.push(`multi-page:pageerror:${error.message}`));
    multiPageSecond.on('console', message => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      const text = message.text();
      report.errors.push(`multi-page:console:${message.type()}:${text}`);
    });

    const sharedURL = `${baseURL}/?mode=single&session=${encodeURIComponent(multiPageSession.id)}&perf_probe=1`;
    await Promise.all([
      page.goto(sharedURL, { waitUntil: 'networkidle' }),
      multiPageSecond.goto(sharedURL, { waitUntil: 'networkidle' }),
    ]);
    await Promise.all([
      waitForReady(page, 'multi-page first view'),
      waitForReady(multiPageSecond, 'multi-page second view'),
    ]);

    await page.bringToFront();
    await applyTerminalHostSize(page, 1100, 480);
    await multiPageSecond.bringToFront();
    await applyTerminalHostSize(multiPageSecond, 720, 700);
    let resizeState = await waitForMultiPageResizeConvergence(page, multiPageSecond);

    await Promise.all([page, multiPageSecond].map(target => target.evaluate(() => {
      window.__floetermPerfHarness.resetStreamDiagnostics();
      window.__floetermPerfProbe.reset();
    })));
    const resizeOutputMarker = 'FLOETERM_MULTI_PAGE_RESIZE_OUTPUT_DONE';
    const resizeOutputMarkerHex = Buffer.from(`\n${resizeOutputMarker}\n`).toString('hex');
    const resizeOutputBytes = 1024 * 1024;
    const resizeOutputCommand = `python3 -c "import os,time; p=b'R'*4096; [(os.write(1,p),time.sleep(.004)) for _ in range(256)]; os.write(1,bytes.fromhex('${resizeOutputMarkerHex}'))"`;
    if (resizeOutputCommand.includes(resizeOutputMarker)) {
      throw new Error('multi-page output command exposed its causal completion marker in shell input');
    }
    await page.bringToFront();
    await page.evaluate(value => window.__floetermPerfHarness.sendInput(`${value}\r`), resizeOutputCommand);

    const resizeSamples = [];
    let geometryMismatches = 0;
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const previousGeneration = resizeState.first.geometry.generation;
      const resizeFirst = iteration % 2 === 0;
      const target = resizeFirst ? page : multiPageSecond;
      const phase = Math.floor(iteration / 2) % 2;
      const width = resizeFirst ? 1100 : (phase === 0 ? 820 : 620);
      const height = resizeFirst ? (phase === 0 ? 560 : 420) : 700;
      await target.bringToFront();
      const startedAt = performance.now();
      await applyTerminalHostSize(target, width, height);
      resizeState = await waitForMultiPageResizeConvergence(page, multiPageSecond, previousGeneration);
      resizeSamples.push(performance.now() - startedAt);
      if (
        resizeState.first.geometry.generation !== resizeState.second.geometry.generation
        || resizeState.first.geometry.cols !== resizeState.second.geometry.cols
        || resizeState.first.geometry.rows !== resizeState.second.geometry.rows
      ) geometryMismatches += 1;
    }

    await page.bringToFront();
    await page.waitForFunction(marker => (
      window.__floetermPerfHarness.getStreamDiagnostics().tail.includes(marker)
    ), resizeOutputMarker);
    await page.waitForFunction(marker => window.__floetermPerfHarness.serialize().includes(marker), resizeOutputMarker);
    const multiFirstSerialized = await collectStableSerializedState(page);
    await multiPageSecond.bringToFront();
    await multiPageSecond.waitForFunction(marker => (
      window.__floetermPerfHarness.getStreamDiagnostics().tail.includes(marker)
    ), resizeOutputMarker);
    await multiPageSecond.waitForFunction(marker => window.__floetermPerfHarness.serialize().includes(marker), resizeOutputMarker);
    const multiSecondSerialized = await collectStableSerializedState(multiPageSecond);

    const [multiFirst, multiSecond] = await Promise.all([
      collectSinglePageResizeState(page),
      collectSinglePageResizeState(multiPageSecond),
    ]);
    const rendererErrorCount = await page.locator('.terminalRendererError').count()
      + await multiPageSecond.locator('.terminalRendererError').count();
    const outputStreamsMatch = JSON.stringify(multiFirst.stream) === JSON.stringify(multiSecond.stream);
    const terminalStateMatch = multiFirstSerialized === multiSecondSerialized;
    await mkdir(evidenceDir, { recursive: true });
    const multiFirstStatePath = path.join(evidenceDir, 'multi-page-first-state.txt');
    const multiSecondStatePath = path.join(evidenceDir, 'multi-page-second-state.txt');
    await Promise.all([
      writeFile(multiFirstStatePath, multiFirstSerialized),
      writeFile(multiSecondStatePath, multiSecondSerialized),
    ]);
    const historyRecoveryRequests = Number(multiFirst.probe.historyRequests || 0)
      + Number(multiSecond.probe.historyRequests || 0);
    const sequenceGaps = Number(multiFirst.stream.sequenceGaps || 0)
      + Number(multiSecond.stream.sequenceGaps || 0);
    const distinctConnectionIDs = Boolean(
      multiFirst.connection_id
      && multiSecond.connection_id
      && multiFirst.connection_id !== multiSecond.connection_id
    );

    const remainingHost = multiFirst.host;
    const generationBeforeDetach = multiFirst.geometry.generation;
    await multiPageSecond.close();
    const detachDeadline = performance.now() + 5000;
    let detachRestoredRemainingView = false;
    while (performance.now() < detachDeadline) {
      const remaining = await collectSinglePageResizeState(page);
      if (
        remaining.effective?.cols === remainingHost.cols
        && remaining.effective?.rows === remainingHost.rows
        && remaining.geometry.cols === remainingHost.cols
        && remaining.geometry.rows === remainingHost.rows
        && remaining.geometry.generation > generationBeforeDetach
      ) {
        detachRestoredRemainingView = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 4));
    }
    const sessionListResponse = await fetch(`${baseURL}/api/sessions`);
    const sessionList = sessionListResponse.ok ? await sessionListResponse.json() : [];
    const externalSessionPreserved = sessionList.some(item => item.id === multiPageSession.id);

    report.metrics.multi_page_resize = {
      sample_count: resizeSamples.length,
      samples_ms: resizeSamples.map(value => round(value)),
      p95_ms: round(nearestRankPercentile(resizeSamples, 0.95)),
      p99_ms: round(nearestRankPercentile(resizeSamples, 0.99)),
      max_ms: round(Math.max(0, ...resizeSamples)),
      output_bytes: Math.min(multiFirst.stream.totalBytes, multiSecond.stream.totalBytes),
      expected_output_bytes: resizeOutputBytes,
      geometry_mismatches: geometryMismatches,
      sequence_gaps: sequenceGaps,
      history_recovery_requests: historyRecoveryRequests,
    };
    report.functional.multi_page_resize = {
      distinct_connection_ids: distinctConnectionIDs,
      output_streams_match: outputStreamsMatch,
      terminal_state_match: terminalStateMatch,
      detach_restored_remaining_view: detachRestoredRemainingView,
      external_session_preserved: externalSessionPreserved,
      renderer_error_count: rendererErrorCount,
      first_terminal_state_hash: hash(multiFirstSerialized),
      second_terminal_state_hash: hash(multiSecondSerialized),
      first_terminal_state_path: multiFirstStatePath,
      second_terminal_state_path: multiSecondStatePath,
    };
  } finally {
    if (multiPageSecond && !multiPageSecond.isClosed()) await multiPageSecond.close();
    await page.goto('about:blank').catch(() => undefined);
    await deletePerformanceSession(multiPageSession.id);
  }
} catch (error) {
  report.errors.push(`runner:${error instanceof Error ? error.stack || error.message : String(error)}`);
} finally {
  await context.close();
  await browser.close();
}

const evaluation = evaluateStandalonePerformanceReport(report);
report.status = evaluation.status;
report.failures = evaluation.failures;
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`floeterm standalone performance report: ${reportPath}\n`);
if (evaluation.status !== 'passed') {
  for (const failure of evaluation.failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
}
