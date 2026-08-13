type TerminalSize = Readonly<{ cols: number; rows: number }>;
type TerminalGeometry = Readonly<{
  generation: number;
  outputSequenceBoundary: number;
  cols: number;
  rows: number;
}>;

type SemanticResizeControllerOptions = Readonly<{
  measure(): TerminalSize;
  repaint(): void;
  attach(size: TerminalSize): Promise<TerminalGeometry>;
  resize(size: TerminalSize): Promise<TerminalGeometry>;
  onConnectionChange(connected: boolean): void;
  onGeometry(geometry: TerminalGeometry): void;
  onError(message: string): void;
}>;

const sameSize = (left: TerminalSize | null, right: TerminalSize): boolean => (
  left?.cols === right.cols && left.rows === right.rows
);

const isMissingAttachment = (error: unknown): boolean => (
  error instanceof Error && (
    error.name === 'AbortError'
    || error.message.includes('not attached')
    || error.message.includes('connection is closed')
    || error.message.includes('stream ended')
    || error.message.includes('was superseded')
  )
);

export type SemanticResizeController = Readonly<{
  requestResize(): Promise<void>;
  handleAttached(): void;
  handleClosed(reason?: string): void;
  handleGeometry(geometry: TerminalGeometry): void;
  dispose(): void;
}>;

export function createSemanticResizeController(
  options: SemanticResizeControllerOptions,
): SemanticResizeController {
  let connected = false;
  let disposed = false;
  let desired: TerminalSize | null = null;
  let applied: TerminalSize | null = null;
  let resizing: TerminalSize | null = null;
  let attaching: Promise<void> | null = null;
  let working: Promise<void> | null = null;
  let connectionEpoch = 0;
  let attachEpoch = 0;

  const ensureAttached = (): Promise<void> => {
    if (disposed || connected) return Promise.resolve();
    if (attaching) return attaching;

    const size = desired ?? options.measure();
    const operationEpoch = ++attachEpoch;
    // Defer the transport call until `attaching` is assigned. Replacing an
    // older transport synchronously emits its superseded lifecycle event.
    attaching = Promise.resolve()
      .then(() => options.attach(size))
      .then(geometry => {
        if (disposed || operationEpoch !== attachEpoch) return;
        connected = true;
        applied = { cols: geometry.cols, rows: geometry.rows };
        if (sameSize(desired, applied)) desired = null;
        options.onConnectionChange(true);
        options.onGeometry(geometry);
        options.onError('');
      })
      .catch(error => {
        if (disposed || operationEpoch !== attachEpoch) return;
        connected = false;
        desired = null;
        options.onConnectionChange(false);
        options.onError(error instanceof Error ? error.message : String(error));
        throw error;
      })
      .finally(() => {
        attaching = null;
      });
    return attaching;
  };

  const run = async (): Promise<void> => {
    while (!disposed && desired) {
      try {
        await ensureAttached();
      } catch {
        return;
      }
      if (disposed || !connected || !desired) return;

      const next = desired;
      desired = null;
      resizing = next;
      const resizeConnectionEpoch = connectionEpoch;
      try {
        const geometry = await options.resize(next);
        if (disposed) return;
        if (!connected || resizeConnectionEpoch !== connectionEpoch) continue;
        applied = { cols: geometry.cols, rows: geometry.rows };
        options.onGeometry(geometry);
        options.onError('');
      } catch (error) {
        if (disposed) return;
        desired ??= next;
        if (connected && resizeConnectionEpoch === connectionEpoch && !isMissingAttachment(error)) {
          desired = null;
          options.onError(error instanceof Error ? error.message : String(error));
          return;
        }
        connected = false;
        applied = null;
        options.onConnectionChange(false);
      } finally {
        resizing = null;
      }
    }
  };

  const startWork = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (!working) {
      working = run().finally(() => {
        working = null;
        if (!disposed && desired) void startWork();
      });
    }
    return working;
  };

  return {
    requestResize: () => {
      if (disposed) return Promise.resolve();
      const next = options.measure();
      options.repaint();
      if (!connected) {
        desired = next;
      } else if (resizing) {
        // The mailbox is latest-wins. Returning to the in-flight size cancels
        // any intermediate size that was queued while the drag continued.
        desired = sameSize(resizing, next) ? null : next;
      } else {
        desired = sameSize(applied, next) ? null : next;
      }
      return startWork();
    },
    handleAttached: () => {
      if (disposed) return;
      connected = true;
      options.onConnectionChange(true);
      options.onError('');
      if (desired) void startWork();
    },
    handleClosed: reason => {
      if (disposed || reason === 'disposed' || reason === 'session_deleted') return;
      if (reason === 'superseded' && attaching) return;
      connectionEpoch += 1;
      attachEpoch += 1;
      connected = false;
      applied = null;
      options.onConnectionChange(false);
      desired = options.measure();
      void startWork();
    },
    handleGeometry: geometry => {
      if (disposed) return;
      applied = { cols: geometry.cols, rows: geometry.rows };
      if (sameSize(desired, applied)) desired = null;
      options.onGeometry(geometry);
    },
    dispose: () => {
      disposed = true;
      connected = false;
      desired = null;
      options.onConnectionChange(false);
    },
  };
}
