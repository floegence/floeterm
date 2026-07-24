import { Ghostty, Terminal } from 'ghostty-web';

import {
  TerminalCore,
  getTerminalInitializationSchedulerStats,
  preloadTerminalResources,
} from '../src/index.js';
import type { TerminalRestorableSnapshot } from '../src/types.js';

const SCROLLBACK_ROWS = 10_000;
const HISTORY_ROWS = 10_100;
const VIEWPORT_ROWS = 53;

type FixtureKind = 'plain' | 'ansi-wide';

type ScenarioRequest =
  | { kind: 'direct-control'; cols: number; fixture: FixtureKind }
  | { kind: 'compatibility'; cols: number; resizeTo?: number; fixture: FixtureKind }
  | { kind: 'same-page-pressure' }
  | { kind: 'cancellation-storm' }
  | { kind: 'performance'; metric: 'cold' | 'preloaded' | 'concurrent' | 'write' | 'resume' };

interface HistoryResult {
  bufferLength: number;
  expectedBoundaryMarker: string;
  finalMarker: string;
  hasBoundaryMarker: boolean;
  hasFinalMarker: boolean;
  firstNonEmptyLine: string;
  lastNonEmptyLine: string;
}

interface ScenarioResult {
  kind: ScenarioRequest['kind'];
  durationMs: number;
  [key: string]: unknown;
}

declare global {
  interface Window {
    runTerminalBrowserScenario(request: ScenarioRequest): Promise<ScenarioResult>;
  }
}

const nextFrame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));

const settleCommittedFrame = async (core: TerminalCore): Promise<void> => {
  await core.forceResizeAndWaitForPresentation();
};

const createContainer = (): HTMLElement => {
  const container = document.createElement('section');
  container.className = 'terminal-fixture';
  document.querySelector('#fixtures')?.appendChild(container);
  return container;
};

const removeContainer = (container: HTMLElement): void => {
  container.remove();
};

const marker = (index: number): string => `FLOETERM-${String(index).padStart(6, '0')}`;

const historyLine = (index: number, fixture: FixtureKind): string => {
  const id = marker(index);
  if (fixture === 'ansi-wide') {
    // Printable width is 18 cells, below the narrowest supported 20-column fixture.
    return `\x1b[3${index % 8}m${id}\x1b[0m \u754c`;
  }
  return `${id} ok`;
};

const buildHistory = (fixture: FixtureKind, count = HISTORY_ROWS): string => {
  const lines = Array.from({ length: count }, (_, index) => historyLine(index, fixture));
  return `${lines.join('\r\n')}\r\n`;
};

const writeCore = (core: TerminalCore, data: string): Promise<void> => new Promise(resolve => {
  core.writeHistory(data, resolve);
});

const writeRaw = (terminal: Terminal, data: string): Promise<void> => new Promise(resolve => {
  terminal.write(data, resolve);
});

const inspectHistory = (
  bufferLength: number,
  readLine: (row: number) => string,
): HistoryResult => {
  // A trailing CRLF leaves one active blank row. This is the first marker that
  // must survive when scrollback rows plus the viewport are fully retained.
  const boundaryIndex = HISTORY_ROWS - (SCROLLBACK_ROWS + VIEWPORT_ROWS) + 1;
  const expectedBoundaryMarker = marker(boundaryIndex);
  const finalMarker = marker(HISTORY_ROWS - 1);
  let hasBoundaryMarker = false;
  let hasFinalMarker = false;
  let firstNonEmptyLine = '';
  let lastNonEmptyLine = '';

  for (let row = 0; row < bufferLength; row += 1) {
    const line = readLine(row).trimEnd();
    if (!line) continue;
    if (!firstNonEmptyLine) firstNonEmptyLine = line;
    lastNonEmptyLine = line;
    if (line.includes(expectedBoundaryMarker)) hasBoundaryMarker = true;
    if (line.includes(finalMarker)) hasFinalMarker = true;
  }

  return {
    bufferLength,
    expectedBoundaryMarker,
    finalMarker,
    hasBoundaryMarker,
    hasFinalMarker,
    firstNonEmptyLine,
    lastNonEmptyLine,
  };
};

const makeCore = (
  cols: number,
  scrollback = SCROLLBACK_ROWS,
  onRender?: (durationMs: number) => void,
): { container: HTMLElement; core: TerminalCore } => {
  const container = createContainer();
  const core = new TerminalCore(container, {
    cols,
    rows: VIEWPORT_ROWS,
    fixedDimensions: { cols, rows: VIEWPORT_ROWS },
    fontSize: 8,
    cursorBlink: false,
    rendererType: 'canvas',
    scrollback,
  }, { onRender });
  return { container, core };
};

const findOwnedMemory = (core: TerminalCore): WebAssembly.Memory | null => {
  for (const key of Reflect.ownKeys(core)) {
    const candidate = Reflect.get(core, key);
    if (!candidate || typeof candidate !== 'object') continue;
    const memory = Reflect.get(candidate, 'memory');
    if (memory instanceof WebAssembly.Memory) return memory;
  }
  return null;
};

const runDirectControl = async (cols: number, fixture: FixtureKind): Promise<ScenarioResult> => {
  const startedAt = performance.now();
  const container = createContainer();
  const runtime = await Ghostty.load();
  const terminal = new Terminal({
    cols,
    rows: VIEWPORT_ROWS,
    fontSize: 8,
    cursorBlink: false,
    scrollback: SCROLLBACK_ROWS,
    ghostty: runtime,
  });

  try {
    terminal.open(container);
    await writeRaw(terminal, buildHistory(fixture));
    await nextFrame();
    const buffer = terminal.buffer.active;
    const history = inspectHistory(
      buffer.length,
      row => buffer.getLine(row)?.translateToString(true) ?? '',
    );
    return {
      kind: 'direct-control',
      durationMs: performance.now() - startedAt,
      history,
    };
  } finally {
    terminal.dispose();
    removeContainer(container);
  }
};

const runCompatibility = async (
  cols: number,
  fixture: FixtureKind,
  resizeTo?: number,
): Promise<ScenarioResult> => {
  const startedAt = performance.now();
  const { container, core } = makeCore(cols);

  try {
    await core.initialize();
    await writeCore(core, buildHistory(fixture));
    if (resizeTo !== undefined) {
      core.setFixedDimensions({ cols: resizeTo, rows: VIEWPORT_ROWS });
    }
    await settleCommittedFrame(core);
    const info = core.getTerminalInfo();
    if (!info) throw new Error('TerminalCore did not expose terminal info after initialization');
    const history = inspectHistory(info.bufferLength, row => core.readBufferLine(row, { trimRight: true }));
    return {
      kind: 'compatibility',
      durationMs: performance.now() - startedAt,
      cols,
      resizeTo: resizeTo ?? null,
      dimensions: core.getDimensions(),
      history,
      estimate: core.getResourceEstimate(),
    };
  } finally {
    core.dispose();
    removeContainer(container);
  }
};

const initializeCore = async (core: TerminalCore): Promise<void> => {
  await core.initialize();
  await settleCommittedFrame(core);
};

const runSamePagePressure = async (): Promise<ScenarioResult> => {
  const startedAt = performance.now();
  const concurrent = Array.from({ length: 3 }, () => makeCore(166));
  const memories: WebAssembly.Memory[] = [];

  try {
    await Promise.all(concurrent.map(({ core }) => core.initialize()));
    await Promise.all(concurrent.map(({ core }, index) => writeCore(core, `CONCURRENT-${index}\r\n`)));
    await Promise.all(concurrent.map(({ core }) => settleCommittedFrame(core)));

    concurrent.forEach(({ core }, index) => {
      const memory = findOwnedMemory(core);
      if (!memory) throw new Error(`Core ${index} does not expose its owned Ghostty WebAssembly.Memory`);
      memories.push(memory);
      const info = core.getTerminalInfo();
      if (!info) throw new Error(`Core ${index} lost terminal info`);
      const contents = core.readBufferLines(0, info.bufferLength - 1, { trimRight: true })
        .map(line => line.text)
        .join('\n');
      if (!contents.includes(`CONCURRENT-${index}`)) {
        throw new Error(`Core ${index} lost its own marker`);
      }
      concurrent.forEach((_other, otherIndex) => {
        if (otherIndex !== index && contents.includes(`CONCURRENT-${otherIndex}`)) {
          throw new Error(`Core ${index} contains marker from Core ${otherIndex}`);
        }
      });
    });

    if (new Set(memories).size !== memories.length) {
      throw new Error('Concurrent TerminalCore instances share a WebAssembly.Memory');
    }
  } finally {
    concurrent.forEach(({ core, container }) => {
      core.dispose();
      removeContainer(container);
    });
  }

  const lifecycle: Array<{ cols: number; resizeTo?: number }> = [
    { cols: 20 },
    { cols: 166 },
    { cols: 500 },
    { cols: 20, resizeTo: 500 },
    { cols: 500, resizeTo: 20 },
  ];
  for (const [index, item] of lifecycle.entries()) {
    const { core, container } = makeCore(item.cols);
    try {
      await core.initialize();
      await writeCore(core, `LIFECYCLE-${index}-${item.cols}\r\n`);
      if (item.resizeTo !== undefined) {
        core.setFixedDimensions({ cols: item.resizeTo, rows: VIEWPORT_ROWS });
      }
      await settleCommittedFrame(core);
      const info = core.getTerminalInfo();
      if (!info || !core.readBufferLines(0, info.bufferLength - 1).some(line => line.text.includes(`LIFECYCLE-${index}`))) {
        throw new Error(`Mixed-width lifecycle ${index} lost its marker`);
      }
    } finally {
      core.dispose();
      removeContainer(container);
    }
  }

  const hibernating = makeCore(166);
  let snapshot: TerminalRestorableSnapshot;
  let hibernatedMemory: WebAssembly.Memory;
  try {
    await initializeCore(hibernating.core);
    const memory = findOwnedMemory(hibernating.core);
    if (!memory) throw new Error('Hibernating Core does not expose its owned WebAssembly.Memory');
    hibernatedMemory = memory;
    await writeCore(hibernating.core, 'HIBERNATE-BEFORE\r\n');
    const captured = hibernating.core.captureRestorableSnapshot({ maxBytes: 512 * 1024 });
    if (!captured) throw new Error('Unable to capture hibernate snapshot');
    snapshot = captured;
  } finally {
    hibernating.core.dispose();
    removeContainer(hibernating.container);
  }

  const resumed = makeCore(166);
  try {
    await resumed.core.initialize();
    const resumedMemory = findOwnedMemory(resumed.core);
    if (!resumedMemory) throw new Error('Resumed Core does not expose its owned WebAssembly.Memory');
    if (resumedMemory === hibernatedMemory) throw new Error('Resumed Core reused the hibernated WebAssembly.Memory');
    if (!await resumed.core.restoreSnapshot(snapshot)) throw new Error('Unable to restore hibernate snapshot');
    await writeCore(resumed.core, 'HIBERNATE-AFTER\r\n');
    await settleCommittedFrame(resumed.core);
    const info = resumed.core.getTerminalInfo();
    if (!info) throw new Error('Resumed Core lost terminal info');
    const contents = resumed.core.readBufferLines(0, info.bufferLength - 1).map(line => line.text).join('\n');
    if (!contents.includes('HIBERNATE-BEFORE') || !contents.includes('HIBERNATE-AFTER')) {
      throw new Error('Hibernate/resume did not preserve and extend terminal history');
    }
  } finally {
    resumed.core.dispose();
    removeContainer(resumed.container);
  }

  const scheduler = getTerminalInitializationSchedulerStats();
  return {
    kind: 'same-page-pressure',
    durationMs: performance.now() - startedAt,
    distinctConcurrentMemories: memories.length,
    hibernateMemoryReplaced: true,
    scheduler,
  };
};

const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Condition did not settle within ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
};

const runCancellationStorm = async (): Promise<ScenarioResult> => {
  const startedAt = performance.now();
  const originalLoad = Ghostty.load.bind(Ghostty);
  let activeLoads = 0;
  let maxActiveLoads = 0;
  Reflect.set(Ghostty, 'load', async (...args: Parameters<typeof Ghostty.load>) => {
    activeLoads += 1;
    maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
    try {
      // Keep the real, non-cancellable load observable long enough for all
      // cancelled waiters to exercise the scheduler ownership boundary.
      await new Promise(resolve => setTimeout(resolve, 25));
      return await originalLoad(...args);
    } finally {
      activeLoads -= 1;
    }
  });

  const fixtures = Array.from({ length: 12 }, () => makeCore(166, 1_000));
  const controllers = fixtures.map(() => new AbortController());
  let leakedEstimates = 0;
  let leakedContainers = 0;
  try {
    const waits = fixtures.map(({ core }, index) => core.initialize({
      signal: controllers[index]?.signal,
      priority: 'interactive',
    }));
    await waitUntil(() => maxActiveLoads === 3, 5_000);
    controllers.forEach(controller => controller.abort());
    const callerOutcomes = await Promise.allSettled(waits);
    if (callerOutcomes.some(outcome => outcome.status !== 'rejected' || outcome.reason?.name !== 'AbortError')) {
      throw new Error('Every cancelled initialization caller must receive AbortError');
    }

    await waitUntil(() => {
      const scheduler = getTerminalInitializationSchedulerStats();
      return activeLoads === 0 && scheduler.active === 0 && scheduler.queued === 0;
    }, 10_000);

    if (maxActiveLoads > 3) throw new Error(`Cancellation storm started ${maxActiveLoads} concurrent Ghostty loads`);
    leakedEstimates = fixtures.filter(({ core }) => {
      const estimate = core.getResourceEstimate();
      return estimate.bufferBytes !== 0
        || estimate.cellCount !== 0
        || estimate.wasmMemoryBytes !== 0
        || estimate.estimatedBytes !== 0;
    }).length;
    leakedContainers = fixtures.filter(({ container }) => container.childElementCount > 0).length;
    if (leakedEstimates > 0) throw new Error(`${leakedEstimates} cancelled Cores retained live resource estimates`);
    if (leakedContainers > 0) throw new Error(`${leakedContainers} cancelled Cores retained terminal DOM`);
  } finally {
    Reflect.set(Ghostty, 'load', originalLoad);
    fixtures.forEach(({ core }) => core.dispose());
    fixtures.forEach(({ container }) => removeContainer(container));
  }

  return {
    kind: 'cancellation-storm',
    durationMs: performance.now() - startedAt,
    maxActiveLoads,
    scheduler: getTerminalInitializationSchedulerStats(),
    leakedEstimates,
    leakedContainers,
  };
};

const runPerformance = async (metric: Extract<ScenarioRequest, { kind: 'performance' }>['metric']): Promise<ScenarioResult> => {
  if (metric === 'preloaded') {
    await preloadTerminalResources();
  }

  if (metric === 'concurrent') {
    const fixtures = Array.from({ length: 3 }, () => makeCore(166, 1_000));
    let maxActive = 0;
    const sample = window.setInterval(() => {
      maxActive = Math.max(maxActive, getTerminalInitializationSchedulerStats().active);
    }, 1);
    const startedAt = performance.now();
    try {
      await Promise.all(fixtures.map(({ core }) => initializeCore(core)));
      return {
        kind: 'performance',
        metric,
        durationMs: performance.now() - startedAt,
        maxActive,
        scheduler: getTerminalInitializationSchedulerStats(),
      };
    } finally {
      clearInterval(sample);
      fixtures.forEach(({ core, container }) => {
        core.dispose();
        removeContainer(container);
      });
    }
  }

  if (metric === 'write') {
    let resolveCommittedRender: (() => void) | null = null;
    const { core, container } = makeCore(166, 1_000, () => {
      const resolve = resolveCommittedRender;
      if (!resolve) return;
      resolveCommittedRender = null;
      requestAnimationFrame(() => resolve());
    });
    try {
      await initializeCore(core);
      const sampleWrite = async (index: number): Promise<number> => {
        await nextFrame();
        const committedRender = new Promise<void>((resolve, reject) => {
          if (resolveCommittedRender) {
            reject(new Error('A write/render performance sample overlapped another sample'));
            return;
          }
          resolveCommittedRender = resolve;
        });
        const startedAt = performance.now();
        await writeCore(core, `PERF-WRITE-${index}\r\n`);
        await committedRender;
        return performance.now() - startedAt;
      };
      for (let index = 0; index < 3; index += 1) await sampleWrite(index);
      const samples: number[] = [];
      for (let index = 0; index < 30; index += 1) samples.push(await sampleWrite(index + 3));
      samples.sort((left, right) => left - right);
      const p95 = samples[Math.ceil(0.95 * samples.length) - 1] ?? Number.POSITIVE_INFINITY;
      return {
        kind: 'performance',
        metric,
        durationMs: p95,
        p95,
        samples,
      };
    } finally {
      core.dispose();
      removeContainer(container);
    }
  }

  if (metric === 'resume') {
    const source = makeCore(166, 1_000);
    let snapshot: TerminalRestorableSnapshot;
    try {
      await initializeCore(source.core);
      await writeCore(source.core, 'PERF-RESUME-MARKER\r\n');
      const captured = source.core.captureRestorableSnapshot({ maxBytes: 512 * 1024 });
      if (!captured) throw new Error('Unable to capture performance resume snapshot');
      snapshot = captured;
    } finally {
      source.core.dispose();
      removeContainer(source.container);
    }

    const resumed = makeCore(166, 1_000);
    const startedAt = performance.now();
    try {
      await resumed.core.initialize();
      if (!await resumed.core.restoreSnapshot(snapshot)) throw new Error('Unable to restore performance snapshot');
      await settleCommittedFrame(resumed.core);
      const info = resumed.core.getTerminalInfo();
      const found = info && resumed.core.readBufferLines(0, info.bufferLength - 1)
        .some(line => line.text.includes('PERF-RESUME-MARKER'));
      if (!found) throw new Error('Resume marker was not committed');
      return {
        kind: 'performance',
        metric,
        durationMs: performance.now() - startedAt,
      };
    } finally {
      resumed.core.dispose();
      removeContainer(resumed.container);
    }
  }

  const { core, container } = makeCore(166, 1_000);
  const startedAt = performance.now();
  try {
    await initializeCore(core);
    return {
      kind: 'performance',
      metric,
      durationMs: performance.now() - startedAt,
    };
  } finally {
    core.dispose();
    removeContainer(container);
  }
};

window.runTerminalBrowserScenario = async (request: ScenarioRequest): Promise<ScenarioResult> => {
  switch (request.kind) {
    case 'direct-control':
      return runDirectControl(request.cols, request.fixture);
    case 'compatibility':
      return runCompatibility(request.cols, request.fixture, request.resizeTo);
    case 'same-page-pressure':
      return runSamePagePressure();
    case 'cancellation-storm':
      return runCancellationStorm();
    case 'performance':
      return runPerformance(request.metric);
  }
};
