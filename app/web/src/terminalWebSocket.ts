import type { TerminalByteStream } from '@floegence/floeterm-terminal-web/live';

const WRITE_BUFFER_LOW_WATERMARK_BYTES = 1024 * 1024;

type ReadWaiter = Readonly<{
  resolve: (value: Uint8Array | null) => void;
  reject: (error: Error) => void;
}>;

type SocketFactory = (url: string) => WebSocket;

const asError = (value: unknown, fallback: string): Error => (
  value instanceof Error ? value : new Error(fallback)
);

export class BrowserWebSocketByteStream implements TerminalByteStream {
  private readonly reads: Uint8Array[] = [];
  private readonly waiters: ReadWaiter[] = [];
  private closed = false;
  private failure: Error | null = null;

  constructor(private readonly socket: WebSocket) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
    socket.addEventListener('error', this.handleError);
  }

  async read(): Promise<Uint8Array | null> {
    if (this.reads.length > 0) return this.reads.shift() ?? null;
    if (this.failure) throw this.failure;
    if (this.closed) return null;
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('terminal WebSocket is not open');
    }
    this.socket.send(data);
    while (this.socket.bufferedAmount > WRITE_BUFFER_LOW_WATERMARK_BYTES) {
      await new Promise<void>((resolve, reject) => {
        window.setTimeout(() => {
          if (this.failure) reject(this.failure);
          else if (this.closed || this.socket.readyState !== WebSocket.OPEN) reject(new Error('terminal WebSocket closed while writing'));
          else resolve();
        }, 1);
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.settleReaders(null);
    this.detach();
    if (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, 'terminal stream closed');
    }
  }

  async reset(error = new Error('terminal WebSocket reset')): Promise<void> {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.rejectReaders(error);
    this.detach();
    if (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1002, 'terminal protocol error');
    }
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (!(event.data instanceof ArrayBuffer)) {
      void this.reset(new Error('terminal WebSocket received a non-binary message'));
      return;
    }
    const data = new Uint8Array(event.data);
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(data);
    else this.reads.push(data);
  };

  private readonly handleClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.settleReaders(null);
    this.detach();
  };

  private readonly handleError = (event: Event): void => {
    if (this.closed) return;
    const error = asError(event, 'terminal WebSocket failed');
    this.failure = error;
    this.closed = true;
    this.rejectReaders(error);
    this.detach();
  };

  private settleReaders(value: Uint8Array | null): void {
    for (const waiter of this.waiters.splice(0)) waiter.resolve(value);
  }

  private rejectReaders(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private detach(): void {
    this.socket.removeEventListener('message', this.handleMessage);
    this.socket.removeEventListener('close', this.handleClose);
    this.socket.removeEventListener('error', this.handleError);
  }
}

export const openBrowserWebSocketByteStream = async (
  url: string,
  createSocket: SocketFactory = nextUrl => new WebSocket(nextUrl),
): Promise<TerminalByteStream> => {
  const socket = createSocket(url);
  socket.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (event: Event) => {
      cleanup();
      reject(asError(event, 'terminal WebSocket failed to open'));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error('terminal WebSocket closed before opening'));
    };
    const cleanup = () => {
      socket.removeEventListener('open', handleOpen);
      socket.removeEventListener('error', handleError);
      socket.removeEventListener('close', handleClose);
    };
    socket.addEventListener('open', handleOpen);
    socket.addEventListener('error', handleError);
    socket.addEventListener('close', handleClose);
  });
  return new BrowserWebSocketByteStream(socket);
};
