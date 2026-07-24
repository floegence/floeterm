#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';
import wasm from 'vite-plugin-wasm';

const terminalWebRoot = fileURLToPath(new URL('..', import.meta.url));
const caseTimeoutMs = 60_000;
const expectedMinimumBufferLength = 10_000 + 53;

const correctnessCases = [
  { name: '20 columns plain', request: { kind: 'compatibility', cols: 20, fixture: 'plain' } },
  { name: '20 columns ANSI/wide', request: { kind: 'compatibility', cols: 20, fixture: 'ansi-wide' } },
  { name: '166 columns plain', request: { kind: 'compatibility', cols: 166, fixture: 'plain' } },
  { name: '166 columns ANSI/wide', request: { kind: 'compatibility', cols: 166, fixture: 'ansi-wide' } },
  { name: '500 columns plain', request: { kind: 'compatibility', cols: 500, fixture: 'plain' } },
  { name: '500 columns ANSI/wide', request: { kind: 'compatibility', cols: 500, fixture: 'ansi-wide' } },
  { name: 'resize 20 to 500', request: { kind: 'compatibility', cols: 20, resizeTo: 500, fixture: 'ansi-wide' } },
  { name: 'resize 500 to 20', request: { kind: 'compatibility', cols: 500, resizeTo: 20, fixture: 'ansi-wide' } },
];

const performanceCases = [
  ...Array.from({ length: 5 }, (_, index) => ({
    name: `cold ${index + 1}`,
    request: { kind: 'performance', metric: 'cold' },
  })),
  ...Array.from({ length: 5 }, (_, index) => ({
    name: `preloaded ${index + 1}`,
    request: { kind: 'performance', metric: 'preloaded' },
  })),
  ...Array.from({ length: 3 }, (_, index) => ({
    name: `three concurrent cores ${index + 1}`,
    request: { kind: 'performance', metric: 'concurrent' },
  })),
  { name: 'ready write/render', request: { kind: 'performance', metric: 'write' } },
  ...Array.from({ length: 5 }, (_, index) => ({
    name: `hibernate/resume ${index + 1}`,
    request: { kind: 'performance', metric: 'resume' },
  })),
];

const fail = (message) => {
  throw new Error(message);
};

const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
};

const formatMs = value => `${value.toFixed(1)} ms`;

const runIsolatedCase = async (baseUrl, testCase) => {
  const browser = await chromium.launch({ headless: true });
  let terminalFailure = null;
  const markFailure = error => {
    terminalFailure ??= error instanceof Error ? error : new Error(String(error));
  };
  browser.on('disconnected', () => markFailure(new Error(`${testCase.name}: Chromium disconnected`)));

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('crash', () => markFailure(new Error(`${testCase.name}: page crashed`)));
  page.on('pageerror', markFailure);
  page.on('console', message => {
    if (message.type() === 'error') markFailure(new Error(`${testCase.name}: ${message.text()}`));
  });

  let timeout;
  try {
    await page.goto(`${baseUrl}/browser-tests/`, { waitUntil: 'load', timeout: caseTimeoutMs });
    await page.waitForFunction(() => typeof window.runTerminalBrowserScenario === 'function', null, {
      timeout: caseTimeoutMs,
    });
    const execution = page.evaluate(request => window.runTerminalBrowserScenario(request), testCase.request);
    const watchdog = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${testCase.name}: exceeded ${caseTimeoutMs} ms watchdog`)), caseTimeoutMs);
    });
    const result = await Promise.race([execution, watchdog]);
    if (terminalFailure) throw terminalFailure;
    return result;
  } finally {
    clearTimeout(timeout);
    await browser.close().catch(() => {});
  }
};

const assertCompatibility = (name, request, result) => {
  const history = result.history;
  const expectedCols = request.resizeTo ?? request.cols;
  if (result.dimensions?.cols !== expectedCols || result.dimensions?.rows !== 53) {
    fail(
      `${name}: expected final dimensions ${expectedCols}x53, got `
      + `${result.dimensions?.cols ?? 'none'}x${result.dimensions?.rows ?? 'none'}`,
    );
  }
  if (!history || history.bufferLength < expectedMinimumBufferLength) {
    fail(`${name}: expected at least ${expectedMinimumBufferLength} buffer rows, got ${history?.bufferLength ?? 'none'}`);
  }
  if (!history.hasBoundaryMarker) fail(`${name}: lost boundary marker ${history.expectedBoundaryMarker}`);
  if (!history.hasFinalMarker) fail(`${name}: lost final marker ${history.finalMarker}`);
  if (!Number.isFinite(result.estimate?.wasmMemoryBytes) || result.estimate.wasmMemoryBytes <= 0) {
    fail(`${name}: did not report a positive wasmMemoryBytes estimate`);
  }
  if (!Number.isFinite(result.estimate?.estimatedBytes) || result.estimate.estimatedBytes < result.estimate.wasmMemoryBytes) {
    fail(`${name}: reported an invalid resource estimate`);
  }
};

const run = async () => {
  const vite = await createServer({
    root: terminalWebRoot,
    logLevel: 'error',
    plugins: [wasm()],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });

  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === 'string') fail('Vite did not expose a TCP address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    console.log('[terminal-browser-gate] proving the pinned ghostty-web direct-pass failure');
    const direct = await runIsolatedCase(baseUrl, {
      name: 'direct ghostty-web control',
      request: { kind: 'direct-control', cols: 166, fixture: 'plain' },
    });
    if (direct.history?.hasBoundaryMarker || direct.history?.bufferLength >= expectedMinimumBufferLength) {
      fail('Direct ghostty-web scrollback=10000 unexpectedly retained the requested rows; review and remove the version-bound compatibility mapping');
    }

    for (const testCase of correctnessCases) {
      console.log(`[terminal-browser-gate] correctness: ${testCase.name}`);
      const result = await runIsolatedCase(baseUrl, testCase);
      assertCompatibility(testCase.name, testCase.request, result);
    }

    console.log('[terminal-browser-gate] same-page pressure and lifecycle isolation');
    const pressure = await runIsolatedCase(baseUrl, {
      name: 'same-page pressure',
      request: { kind: 'same-page-pressure' },
    });
    if (pressure.distinctConcurrentMemories !== 3) fail('Same-page pressure did not verify three distinct WASM memories');
    if (pressure.hibernateMemoryReplaced !== true) fail('Hibernate/resume did not replace the owned WASM memory');
    if (pressure.scheduler?.active !== 0 || pressure.scheduler?.queued !== 0) {
      fail(`Initialization scheduler leaked work: ${JSON.stringify(pressure.scheduler)}`);
    }

    console.log('[terminal-browser-gate] cancellation storm and scheduler ownership');
    const cancellation = await runIsolatedCase(baseUrl, {
      name: 'cancellation storm',
      request: { kind: 'cancellation-storm' },
    });
    if (cancellation.maxActiveLoads > 3) fail(`Cancellation storm exceeded three active loads: ${cancellation.maxActiveLoads}`);
    if (cancellation.scheduler?.active !== 0 || cancellation.scheduler?.queued !== 0) {
      fail(`Cancellation storm leaked scheduler work: ${JSON.stringify(cancellation.scheduler)}`);
    }
    if (cancellation.leakedEstimates !== 0 || cancellation.leakedContainers !== 0) {
      fail(`Cancellation storm leaked resources: ${JSON.stringify(cancellation)}`);
    }

    const performanceResults = [];
    for (const testCase of performanceCases) {
      console.log(`[terminal-browser-gate] performance: ${testCase.name}`);
      performanceResults.push({ testCase, result: await runIsolatedCase(baseUrl, testCase) });
    }

    const cold = performanceResults.filter(item => item.testCase.request.metric === 'cold').map(item => item.result.durationMs);
    const preloaded = performanceResults.filter(item => item.testCase.request.metric === 'preloaded').map(item => item.result.durationMs);
    const concurrent = performanceResults.filter(item => item.testCase.request.metric === 'concurrent');
    const write = performanceResults.find(item => item.testCase.request.metric === 'write')?.result;
    const resume = performanceResults.filter(item => item.testCase.request.metric === 'resume').map(item => item.result.durationMs);

    const coldMedian = median(cold);
    const preloadedMedian = median(preloaded);
    const resumeMedian = median(resume);
    if (coldMedian > 500) fail(`Cold Core median ${formatMs(coldMedian)} exceeds 500 ms`);
    if (preloadedMedian > 250) fail(`Preloaded first Core median ${formatMs(preloadedMedian)} exceeds 250 ms`);
    for (const item of concurrent) {
      if (item.result.durationMs > 1_000) fail(`${item.testCase.name} ${formatMs(item.result.durationMs)} exceeds 1000 ms`);
      if (item.result.maxActive > 3) fail(`${item.testCase.name} exceeded scheduler concurrency: ${item.result.maxActive}`);
    }
    if (!write || write.p95 > 50) fail(`Ready write/render p95 ${formatMs(write?.p95 ?? Number.POSITIVE_INFINITY)} exceeds 50 ms`);
    if (resumeMedian > 500) fail(`Hibernate/resume median ${formatMs(resumeMedian)} exceeds 500 ms`);

    console.log('[terminal-browser-gate] passed', {
      directBufferRows: direct.history.bufferLength,
      coldMedianMs: coldMedian,
      preloadedMedianMs: preloadedMedian,
      writeP95Ms: write.p95,
      resumeMedianMs: resumeMedian,
    });
  } finally {
    await vite.close();
  }
};

run().catch(error => {
  console.error('[terminal-browser-gate] failed');
  console.error(error);
  process.exitCode = 1;
});
