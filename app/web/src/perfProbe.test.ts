// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFrontendPerfProbe, type FrontendPerfProbe } from './perfProbe';

type TestWindow = Window & { __floetermPerfProbe?: FrontendPerfProbe };

afterEach(() => {
  (window as TestWindow).__floetermPerfProbe?.dispose();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('frontend performance probe', () => {
  it('records input-to-render samples and resets cumulative counters', () => {
    let now = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    window.history.replaceState({}, '', '/?perf=1');

    installFrontendPerfProbe();
    const probe = (window as TestWindow).__floetermPerfProbe!;
    probe.onTerminalInput(1);
    probe.onTerminalWrite(8);
    probe.onTerminalWriteProfile({ totalMs: 6, parseMs: 4, snapshotMs: 1 });
    now = 17;
    probe.onTerminalRender(2.5);

    expect(probe.snapshot()).toMatchObject({
      terminalWrites: 1,
      terminalWriteBytes: 8,
      terminalWriteDurationsMs: [6],
      terminalParseDurationsMs: [4],
      terminalSnapshotDurationsMs: [1],
      inputToWriteMs: [0],
      terminalRenders: 1,
      terminalRenderMaxMs: 2.5,
      terminalRenderDurationsMs: [2.5],
      keyToPaintMs: [7],
    });

    probe.reset();
    expect(probe.snapshot()).toMatchObject({
      terminalWrites: 0,
      terminalWriteBytes: 0,
      terminalWriteDurationsMs: [],
      terminalParseDurationsMs: [],
      terminalSnapshotDurationsMs: [],
      inputToWriteMs: [],
      terminalRenders: 0,
      terminalRenderDurationsMs: [],
      keyToPaintMs: [],
    });
  });

  it('records exact outgoing WebSocket message and byte counts', () => {
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readonly readyState = FakeWebSocket.OPEN;
      readonly sent: unknown[] = [];

      constructor(_url: string | URL, _protocols?: string | string[]) {
        super();
      }

      send(data: unknown): void {
        this.sent.push(data);
      }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    window.history.replaceState({}, '', '/?perf_probe=1');

    installFrontendPerfProbe();
    const socket = new window.WebSocket('ws://example.test');
    socket.send('中文');
    socket.send(new Uint8Array([0x02, 2, 3]));
    socket.send(new ArrayBuffer(5));

    expect((window as TestWindow).__floetermPerfProbe!.snapshot()).toMatchObject({
      wsSentMessages: 3,
      wsSentBytes: 14,
      wsSentInputMessages: 1,
      wsSentInputBytes: 3,
    });
  });
});
