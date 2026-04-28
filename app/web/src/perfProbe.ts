type PerfProbeSnapshot = {
  wsMessages: number;
  wsBytes: number;
  terminalWrites: number;
  terminalWriteBytes: number;
  terminalRenders: number;
  terminalRenderMs: number;
  terminalRenderMaxMs: number;
  rafFrames: number;
  rafP95Ms: number;
  rafMaxMs: number;
  longTasks: number;
  longTaskMs: number;
  heapMB: number | null;
};

type PerfProbeWindow = Window & {
  __floetermPerfProbe?: {
    onTerminalWrite: (bytes: number) => void;
    onTerminalRender: (durationMs: number) => void;
  };
  WebSocket: typeof WebSocket;
  performance: Performance & {
    memory?: {
      usedJSHeapSize: number;
    };
  };
};

const formatNumber = (value: number, digits = 1): string => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toFixed(digits);
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
};

export const installFrontendPerfProbe = (): void => {
  if (typeof window === 'undefined') {
    return;
  }
  const perfWindow = window as PerfProbeWindow;
  const params = new URLSearchParams(perfWindow.location.search);
  if (params.get('perf') !== '1' || perfWindow.__floetermPerfProbe) {
    return;
  }

  const counters = {
    wsMessages: 0,
    wsBytes: 0,
    terminalWrites: 0,
    terminalWriteBytes: 0,
    terminalRenders: 0,
    terminalRenderMs: 0,
    terminalRenderMaxMs: 0,
    rafDeltas: [] as number[],
    longTasks: 0,
    longTaskMs: 0
  };

  const overlay = document.createElement('pre');
  overlay.className = 'perfProbe';
  overlay.textContent = 'perf probe starting...';
  document.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(overlay);
  });

  const NativeWebSocket = perfWindow.WebSocket;
  perfWindow.WebSocket = class FloetermInstrumentedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols as string | string[] | undefined);
      this.addEventListener('message', event => {
        counters.wsMessages += 1;
        if (typeof event.data === 'string') {
          counters.wsBytes += event.data.length;
        } else if (event.data instanceof ArrayBuffer) {
          counters.wsBytes += event.data.byteLength;
        } else if (event.data instanceof Blob) {
          counters.wsBytes += event.data.size;
        }
      });
    }
  } as typeof WebSocket;

  perfWindow.__floetermPerfProbe = {
    onTerminalWrite: bytes => {
      counters.terminalWrites += 1;
      counters.terminalWriteBytes += bytes;
    },
    onTerminalRender: durationMs => {
      counters.terminalRenders += 1;
      counters.terminalRenderMs += durationMs;
      counters.terminalRenderMaxMs = Math.max(counters.terminalRenderMaxMs, durationMs);
    }
  };

  if ('PerformanceObserver' in perfWindow) {
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          counters.longTasks += 1;
          counters.longTaskMs += entry.duration;
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // Long task observation is optional and browser-dependent.
    }
  }

  let lastRaf = performance.now();
  const rafLoop = (now: number) => {
    counters.rafDeltas.push(now - lastRaf);
    if (counters.rafDeltas.length > 600) {
      counters.rafDeltas.splice(0, counters.rafDeltas.length - 600);
    }
    lastRaf = now;
    requestAnimationFrame(rafLoop);
  };
  requestAnimationFrame(rafLoop);

  const takeSnapshot = (): PerfProbeSnapshot => {
    const rafDeltas = counters.rafDeltas.splice(0);
    const heapMB = perfWindow.performance.memory
      ? perfWindow.performance.memory.usedJSHeapSize / 1024 / 1024
      : null;
    return {
      wsMessages: counters.wsMessages,
      wsBytes: counters.wsBytes,
      terminalWrites: counters.terminalWrites,
      terminalWriteBytes: counters.terminalWriteBytes,
      terminalRenders: counters.terminalRenders,
      terminalRenderMs: counters.terminalRenderMs,
      terminalRenderMaxMs: counters.terminalRenderMaxMs,
      rafFrames: rafDeltas.length,
      rafP95Ms: percentile(rafDeltas, 0.95),
      rafMaxMs: rafDeltas.reduce((max, value) => Math.max(max, value), 0),
      longTasks: counters.longTasks,
      longTaskMs: counters.longTaskMs,
      heapMB
    };
  };

  let previous = takeSnapshot();
  window.setInterval(() => {
    const current = takeSnapshot();
    const delta = {
      wsMessages: current.wsMessages - previous.wsMessages,
      wsBytes: current.wsBytes - previous.wsBytes,
      terminalWrites: current.terminalWrites - previous.terminalWrites,
      terminalWriteBytes: current.terminalWriteBytes - previous.terminalWriteBytes,
      terminalRenders: current.terminalRenders - previous.terminalRenders,
      terminalRenderMs: current.terminalRenderMs - previous.terminalRenderMs,
      terminalRenderMaxMs: current.terminalRenderMaxMs,
      longTasks: current.longTasks - previous.longTasks,
      longTaskMs: current.longTaskMs - previous.longTaskMs
    };
    counters.terminalRenderMaxMs = 0;
    previous = current;

    const avgRenderMs = delta.terminalRenders > 0 ? delta.terminalRenderMs / delta.terminalRenders : 0;
    const lines = [
      '[floeterm perf]',
      `ws ${delta.wsMessages}/s ${formatNumber(delta.wsBytes / 1024)} KB/s`,
      `write ${delta.terminalWrites}/s ${formatNumber(delta.terminalWriteBytes / 1024)} KB/s`,
      `render ${delta.terminalRenders}/s avg ${formatNumber(avgRenderMs)}ms max ${formatNumber(delta.terminalRenderMaxMs)}ms`,
      `raf p95 ${formatNumber(current.rafP95Ms)}ms max ${formatNumber(current.rafMaxMs)}ms`,
      `longtask ${delta.longTasks}/s ${formatNumber(delta.longTaskMs)}ms/s`,
      `heap ${current.heapMB === null ? 'n/a' : `${formatNumber(current.heapMB)} MB`}`
    ];

    overlay.textContent = lines.join('\n');
    console.info(lines.join(' | '));
  }, 1000);
};
