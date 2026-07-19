import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BrowserWebSocketByteStream,
  openBrowserWebSocketByteStream,
} from './terminalWebSocket';

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;
  readonly sends: Uint8Array[] = [];
  closeCode: number | null = null;

  send(data: ArrayBufferView | ArrayBuffer | Blob | string): void {
    if (!(data instanceof Uint8Array)) throw new Error('expected Uint8Array');
    this.sends.push(data.slice());
  }

  close(code?: number): void {
    this.closeCode = code ?? null;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(data: ArrayBuffer | string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

const originalWebSocket = globalThis.WebSocket;

describe('browser terminal WebSocket byte stream', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
    vi.restoreAllMocks();
  });

  it('opens in arraybuffer mode and preserves binary message boundaries', async () => {
    const socket = new FakeWebSocket();
    const opening = openBrowserWebSocketByteStream('ws://terminal.test/ws', () => socket as unknown as WebSocket);
    expect(socket.binaryType).toBe('arraybuffer');
    socket.open();
    const stream = await opening;

    socket.message(new Uint8Array([1, 2, 3]).buffer);
    await expect(stream.read()).resolves.toEqual(new Uint8Array([1, 2, 3]));

    await stream.write(new Uint8Array([4, 5]));
    expect(socket.sends).toEqual([new Uint8Array([4, 5])]);
  });

  it('rejects text messages instead of attempting JSON compatibility', async () => {
    const socket = new FakeWebSocket();
    socket.readyState = FakeWebSocket.OPEN;
    const stream = new BrowserWebSocketByteStream(socket as unknown as WebSocket);
    const reading = stream.read();

    socket.message('{"type":"data"}');

    await expect(reading).rejects.toThrow(/non-binary/i);
    expect(socket.closeCode).toBe(1002);
  });

  it('ends pending reads explicitly when the socket closes', async () => {
    const socket = new FakeWebSocket();
    socket.readyState = FakeWebSocket.OPEN;
    const stream = new BrowserWebSocketByteStream(socket as unknown as WebSocket);
    const reading = stream.read();

    socket.close(1000);

    await expect(reading).resolves.toBeNull();
    await expect(stream.read()).resolves.toBeNull();
  });
});
