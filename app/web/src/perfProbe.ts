export type PerfProbeSnapshot = {
  wsMessages: number;
  wsBytes: number;
  wsSentMessages: number;
  wsSentBytes: number;
  wsSentInputMessages: number;
  wsSentInputBytes: number;
  historyRequests: number;
  terminalWrites: number;
  terminalWriteBytes: number;
  terminalWriteDurationsMs: number[];
  terminalParseDurationsMs: number[];
  terminalSnapshotDurationsMs: number[];
  inputToWriteMs: number[];
  terminalRenders: number;
  terminalRenderMs: number;
  terminalRenderMaxMs: number;
  terminalRenderDurationsMs: number[];
  keyToPaintMs: number[];
  rafFrames: number;
  rafP95Ms: number;
  rafMaxMs: number;
  rafDurationsMs: number[];
  longTasks: number;
  longTaskMs: number;
  heapMB: number | null;
};

export type FrontendPerfProbe = {
  onTerminalInput: (bytes: number) => void;
  onTerminalWrite: (bytes: number) => void;
  onTerminalWriteProfile: (profile: { totalMs: number; parseMs: number; snapshotMs: number }) => void;
  onTerminalRender: (durationMs: number) => void;
  snapshot: () => PerfProbeSnapshot;
  reset: () => void;
  dispose: () => void;
};

type PerfProbeWindow = Window & {
  __floetermPerfProbe?: FrontendPerfProbe;
  WebSocket: typeof WebSocket;
  performance: Performance & {
    memory?: {
      usedJSHeapSize: number;
    };
  };
};

const MAX_RETAINED_SAMPLES = 20_000;

const formatNumber = (value: number, digits = 1): string => {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(digits);
};

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index]!;
};

const retainSample = (values: number[], value: number): void => {
  values.push(value);
  if (values.length > MAX_RETAINED_SAMPLES) {
    values.splice(0, values.length - MAX_RETAINED_SAMPLES);
  }
};

const websocketPayloadBytes = (data: string | ArrayBufferLike | Blob | ArrayBufferView): number => {
  if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
  if (data instanceof Blob) return data.size;
  return data.byteLength;
};

const websocketPayloadFirstByte = (data: string | ArrayBufferLike | Blob | ArrayBufferView): number | null => {
  if (typeof data === 'string' || data instanceof Blob || data.byteLength === 0) return null;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, 1)[0] ?? null;
  return new Uint8Array(data, 0, 1)[0] ?? null;
};

export const installFrontendPerfProbe = (): void => {
  if (typeof window === 'undefined') return;
  const perfWindow = window as PerfProbeWindow;
  const params = new URLSearchParams(perfWindow.location.search);
  if ((params.get('perf') !== '1' && params.get('perf_probe') !== '1') || perfWindow.__floetermPerfProbe) return;

  const counters = {
    wsMessages: 0,
    wsBytes: 0,
    wsSentMessages: 0,
    wsSentBytes: 0,
    wsSentInputMessages: 0,
    wsSentInputBytes: 0,
    historyRequests: 0,
    terminalWrites: 0,
    terminalWriteBytes: 0,
    terminalWriteDurationsMs: [] as number[],
    terminalParseDurationsMs: [] as number[],
    terminalSnapshotDurationsMs: [] as number[],
    terminalRenders: 0,
    terminalRenderMs: 0,
    terminalRenderMaxMs: 0,
    terminalRenderDurationsMs: [] as number[],
    pendingInputs: [] as Array<{ startedAtMs: number; writeObserved: boolean }>,
    inputToWriteMs: [] as number[],
    keyToPaintMs: [] as number[],
    rafDurationsMs: [] as number[],
    longTasks: 0,
    longTaskMs: 0,
  };

  const overlay = document.createElement('pre');
  overlay.className = 'perfProbe';
  overlay.textContent = 'perf probe starting...';
  const appendOverlay = () => {
    if (!overlay.isConnected) document.body.appendChild(overlay);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', appendOverlay, { once: true });
  } else {
    appendOverlay();
  }

  const NativeWebSocket = perfWindow.WebSocket;
  perfWindow.WebSocket = class FloetermInstrumentedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols as string | string[] | undefined);
      this.addEventListener('message', event => {
        counters.wsMessages += 1;
        if (typeof event.data === 'string') counters.wsBytes += event.data.length;
        else if (event.data instanceof ArrayBuffer) counters.wsBytes += event.data.byteLength;
        else if (event.data instanceof Blob) counters.wsBytes += event.data.size;
      });
    }

    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const payloadBytes = websocketPayloadBytes(data);
      counters.wsSentMessages += 1;
      counters.wsSentBytes += payloadBytes;
      if (websocketPayloadFirstByte(data) === 0x02) {
        counters.wsSentInputMessages += 1;
        counters.wsSentInputBytes += payloadBytes;
      }
      super.send(data);
    }
  } as typeof WebSocket;

  const nativeFetch = perfWindow.fetch;
  if (typeof nativeFetch === 'function') {
    perfWindow.fetch = (async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const rawURL = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(rawURL, perfWindow.location.href);
      if (/^\/api\/sessions\/[^/]+\/history$/.test(url.pathname)) counters.historyRequests += 1;
      return await nativeFetch.apply(perfWindow, args);
    }) as typeof fetch;
  }

  let longTaskObserver: PerformanceObserver | null = null;
  if ('PerformanceObserver' in perfWindow) {
    try {
      longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          counters.longTasks += 1;
          counters.longTaskMs += entry.duration;
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      longTaskObserver = null;
    }
  }

  let lastRaf = performance.now();
  let rafHandle = 0;
  const rafLoop = (now: number) => {
    retainSample(counters.rafDurationsMs, Math.max(0, now - lastRaf));
    lastRaf = now;
    rafHandle = requestAnimationFrame(rafLoop);
  };
  rafHandle = requestAnimationFrame(rafLoop);

  const takeSnapshot = (): PerfProbeSnapshot => {
    const rafDurationsMs = [...counters.rafDurationsMs];
    const heapMB = perfWindow.performance.memory
      ? perfWindow.performance.memory.usedJSHeapSize / 1024 / 1024
      : null;
    return {
      wsMessages: counters.wsMessages,
      wsBytes: counters.wsBytes,
      wsSentMessages: counters.wsSentMessages,
      wsSentBytes: counters.wsSentBytes,
      wsSentInputMessages: counters.wsSentInputMessages,
      wsSentInputBytes: counters.wsSentInputBytes,
      historyRequests: counters.historyRequests,
      terminalWrites: counters.terminalWrites,
      terminalWriteBytes: counters.terminalWriteBytes,
      terminalWriteDurationsMs: [...counters.terminalWriteDurationsMs],
      terminalParseDurationsMs: [...counters.terminalParseDurationsMs],
      terminalSnapshotDurationsMs: [...counters.terminalSnapshotDurationsMs],
      inputToWriteMs: [...counters.inputToWriteMs],
      terminalRenders: counters.terminalRenders,
      terminalRenderMs: counters.terminalRenderMs,
      terminalRenderMaxMs: counters.terminalRenderMaxMs,
      terminalRenderDurationsMs: [...counters.terminalRenderDurationsMs],
      keyToPaintMs: [...counters.keyToPaintMs],
      rafFrames: rafDurationsMs.length,
      rafP95Ms: percentile(rafDurationsMs, 0.95),
      rafMaxMs: rafDurationsMs.reduce((max, value) => Math.max(max, value), 0),
      rafDurationsMs,
      longTasks: counters.longTasks,
      longTaskMs: counters.longTaskMs,
      heapMB,
    };
  };

  let previous = takeSnapshot();
  const reset = () => {
    counters.wsMessages = 0;
    counters.wsBytes = 0;
    counters.wsSentMessages = 0;
    counters.wsSentBytes = 0;
    counters.wsSentInputMessages = 0;
    counters.wsSentInputBytes = 0;
    counters.historyRequests = 0;
    counters.terminalWrites = 0;
    counters.terminalWriteBytes = 0;
    counters.terminalWriteDurationsMs = [];
    counters.terminalParseDurationsMs = [];
    counters.terminalSnapshotDurationsMs = [];
    counters.terminalRenders = 0;
    counters.terminalRenderMs = 0;
    counters.terminalRenderMaxMs = 0;
    counters.terminalRenderDurationsMs = [];
    counters.pendingInputs = [];
    counters.inputToWriteMs = [];
    counters.keyToPaintMs = [];
    counters.rafDurationsMs = [];
    counters.longTasks = 0;
    counters.longTaskMs = 0;
    lastRaf = performance.now();
    previous = takeSnapshot();
  };

  const intervalHandle = window.setInterval(() => {
    const current = takeSnapshot();
    const deltaRenders = current.terminalRenders - previous.terminalRenders;
    const deltaRenderMs = current.terminalRenderMs - previous.terminalRenderMs;
    const avgRenderMs = deltaRenders > 0 ? deltaRenderMs / deltaRenders : 0;
    const lines = [
      '[floeterm perf]',
      `ws ${current.wsMessages - previous.wsMessages}/s ${formatNumber((current.wsBytes - previous.wsBytes) / 1024)} KB/s`,
      `write ${current.terminalWrites - previous.terminalWrites}/s ${formatNumber((current.terminalWriteBytes - previous.terminalWriteBytes) / 1024)} KB/s`,
      `render ${deltaRenders}/s avg ${formatNumber(avgRenderMs)}ms max ${formatNumber(current.terminalRenderMaxMs)}ms`,
      `raf p95 ${formatNumber(current.rafP95Ms)}ms max ${formatNumber(current.rafMaxMs)}ms`,
      `longtask ${current.longTasks - previous.longTasks}/s ${formatNumber(current.longTaskMs - previous.longTaskMs)}ms/s`,
      `heap ${current.heapMB === null ? 'n/a' : `${formatNumber(current.heapMB)} MB`}`,
    ];
    previous = current;
    overlay.textContent = lines.join('\n');
    console.info(lines.join(' | '));
  }, 1000);

  const probe: FrontendPerfProbe = {
    onTerminalInput: () => {
      counters.pendingInputs.push({ startedAtMs: performance.now(), writeObserved: false });
    },
    onTerminalWrite: bytes => {
      counters.terminalWrites += 1;
      counters.terminalWriteBytes += bytes;
      const writeStartedAt = performance.now();
      for (const pending of counters.pendingInputs) {
        if (pending.writeObserved) continue;
        pending.writeObserved = true;
        retainSample(counters.inputToWriteMs, Math.max(0, writeStartedAt - pending.startedAtMs));
      }
    },
    onTerminalWriteProfile: profile => {
      retainSample(counters.terminalWriteDurationsMs, Math.max(0, profile.totalMs));
      retainSample(counters.terminalParseDurationsMs, Math.max(0, profile.parseMs));
      retainSample(counters.terminalSnapshotDurationsMs, Math.max(0, profile.snapshotMs));
    },
    onTerminalRender: durationMs => {
      const normalizedDuration = Math.max(0, durationMs);
      counters.terminalRenders += 1;
      counters.terminalRenderMs += normalizedDuration;
      counters.terminalRenderMaxMs = Math.max(counters.terminalRenderMaxMs, normalizedDuration);
      retainSample(counters.terminalRenderDurationsMs, normalizedDuration);
      const renderedAt = performance.now();
      for (const pending of counters.pendingInputs.splice(0)) {
        retainSample(counters.keyToPaintMs, Math.max(0, renderedAt - pending.startedAtMs));
      }
    },
    snapshot: takeSnapshot,
    reset,
    dispose: () => {
      window.clearInterval(intervalHandle);
      cancelAnimationFrame(rafHandle);
      longTaskObserver?.disconnect();
      document.removeEventListener('DOMContentLoaded', appendOverlay);
      overlay.remove();
      perfWindow.WebSocket = NativeWebSocket;
      perfWindow.fetch = nativeFetch;
      if (perfWindow.__floetermPerfProbe === probe) delete perfWindow.__floetermPerfProbe;
    },
  };
  perfWindow.__floetermPerfProbe = probe;
};
