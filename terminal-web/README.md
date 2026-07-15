# terminal-web

Framework-neutral ghostty-web (xterm.js API-compatible) integration with terminal core, session, and data flow utilities.

## Install

```bash
npm i @floegence/floeterm-terminal-web
```

## Usage

Use the managed controller when you want attach, reconnect-friendly replay, ordered writes, resize, and action helpers handled for you:

```ts
import { createTerminalInstance } from '@floegence/floeterm-terminal-web';

const controller = createTerminalInstance({
  sessionId: 'session-1',
  isActive: true,
  transport: myTransport,
  eventSource: myEventSource,
});

const unsubscribe = controller.subscribe((snapshot) => {
  console.log(snapshot.connection.state, snapshot.loadingMessage);
});

await controller.mount(container);

// Later:
controller.actions.copySelection('command');
unsubscribe();
controller.dispose();
```

Use `TerminalCore` directly when the host product owns its own session lifecycle, paging, shell integration, or workbench coordination:

```ts
import { TerminalCore, getDefaultTerminalConfig } from '@floegence/floeterm-terminal-web';

const core = new TerminalCore(
  container,
  getDefaultTerminalConfig('dark', { clipboard: { copyOnSelect: false } }),
  {
    onData: data => transport.sendInput(sessionId, data),
    onResize: size => transport.resize(sessionId, size.cols, size.rows),
  },
);

await core.initialize();
```

Hosts can preload the dynamic Ghostty module, WASM, and renderer resources before a terminal surface is visible without creating a `TerminalCore`:

```ts
import { preloadTerminalResources } from '@floegence/floeterm-terminal-web/preload';

await preloadTerminalResources({ signal });
await core.initialize({ priority: 'interactive', signal });
```

Resource loading is single-flight and retryable after a real import or WASM initialization failure. Caller cancellation only stops that caller from waiting; it does not interrupt shared resource initialization. Core initialization is globally bounded, gives queued interactive work priority over background work, and shares the actual ready promise across duplicate calls.

Use the lightweight subpath exports when the host needs session metadata or renderer-neutral history before loading the full terminal feature:

```ts
import { TerminalSessionsCoordinator } from '@floegence/floeterm-terminal-web/sessions';
import { preparePagedTerminalHistory } from '@floegence/floeterm-terminal-web/history';
```

`TerminalSessionsCoordinator` treats `pollMs: 0` as a real periodic-poll disable. Subscribing still performs one best-effort initial reconcile, and explicit `refresh()` calls remain available to a host-owned lifecycle coordinator.

## Notes

- You must provide a `TerminalTransport` and `TerminalEventSource` for the managed controller.
- `ghostty-web` needs a one-time `init()`; `TerminalCore` handles that internally.
- `TerminalCore` bridges the hidden textarea used by `ghostty-web`, so soft-keyboard and composition input continue to work on touch devices.
- Programmatic terminal focus uses no-scroll focus by default, keeping embedded terminals stable inside scaled, projected, or otherwise transformed host surfaces.
- Explicit terminal copy is handled through shared selection-copy APIs, so keyboard shortcuts, native app menus, and product context menus can reuse the same selection logic.
- `TerminalCore` exposes runtime appearance updates, shell bell/title events, custom terminal link providers, buffer line reads, and touch-scroll helpers without requiring consumers to reach into private runtime objects.
- Multiple live `TerminalCore` instances share one render scheduler, so large terminal grids coalesce demand-driven canvas work into browser frames.

## Paged History And Live Recovery

Hosts with cursor-paged history APIs can use the framework-neutral coordinator instead of maintaining a second live-output queue:

```ts
const output = createPagedTerminalOutputCoordinator({
  fetchPage: ({ startSequence, endSequence, historyGeneration, cursor, signal }) =>
    transport.historyPage(sessionId, {
      startSequence,
      endSequence,
      historyGeneration,
      cursor,
      signal,
    }),
  write: data => new Promise(resolve => core.write(data, resolve)),
  writeHistory: data => new Promise(resolve => core.writeHistory(data, resolve)),
  clear: () => core.clear(),
});

void output.attach(1);
const baseline = await output.waitForBaseline();
if (!baseline.baselineReady) {
  throw baseline.failure;
}
events.onData(sessionId, chunk => output.pushLive(chunk));
```

History pages must explicitly include `coveredThroughSequence`, including the valid empty-history value `0`. A missing or malformed value produces a structured contract failure instead of guessing from the last returned chunk. The first page may also provide `snapshotEndSequence`, `firstRetainedSequence`, and `historyGeneration`; pass the snapshot end and generation through each later request.

If a page reports `historyReset` or changes `historyGeneration` while catch-up is running, the coordinator atomically clears the obsolete baseline, preserves retained live output, and restarts from the new generation. Hosts must not merge pages from different generations or reinterpret the expected coverage reset as a malformed regression.

`baselineReady` becomes true only after the complete fixed history snapshot has been source-sequence merged with retained live output and the final history writer completion has fired. After that fence, catch-up retries preserve baseline readiness and do not need to block input. Structured failures distinguish initial replay from background catch-up and expose stable codes without requiring error-string parsing.

Use `TerminalCore.writeHistory` for history batches. Its auto-response suppression is scoped to that parser write and ends at its completion callback, so later live output and user input use normal terminal behavior.

Running sessions can prepare bounded history before a visible terminal exists. Preparation does not create a Core, attach a session, resize a PTY, or subscribe to live output:

```ts
const preparedHistory = await preparePagedTerminalHistory({
  fetchPage: request => transport.historyPage(sessionId, request),
  maxBytes: 4 * 1024 * 1024,
  signal,
});

const attachGeneration = output.beginAttach(0);
const attach = await transport.attachWithHistoryBoundary(sessionId, cols, rows);
await output.completeAttach(attachGeneration, attach.historyBoundarySequence, {
  preparedHistory,
});

const baseline = await output.waitForBaseline();
if (baseline.preparedHistoryOutcome?.status === 'accepted') {
  console.log('prepared history used', { rebased: baseline.preparedHistoryOutcome.rebased });
}
```

Prepared history is renderer-neutral and pins `historyGeneration`, `firstRetainedSequence`, and `snapshotEndSequence`. The visible attach validates those boundaries, replays the seed once, and fetches only the missing delta. A generation reset, retention advance, stale fence, or malformed seed discards it and falls back to the normal full recovery path. The baseline snapshot reports `accepted`, `rejected`, or `not-provided` plus a `rebased` flag, so hosts do not need to infer seed use from fetched byte counts.

`preparePagedTerminalHistory` requires those three metadata fields on every prepared page and passes the remaining retained-byte budget as `request.maxBytes` so transports can bound each page as well. The helper always enforces its retained seed budget after a page returns; adapters should honor the request hint to keep peak response memory bounded too.

## Restorable In-Memory Snapshots

Adaptive host worksets can release inactive renderers without closing their PTY sessions:

```ts
await output.pause();
const snapshot = core.captureRestorableSnapshot({
  coveredThroughSequence: output.getSnapshot().coveredThroughSequence,
});
const estimate = core.getResourceEstimate();

core.dispose(); // The host-owned PTY and output coordinator remain alive.

const restored = await nextCore.restoreSnapshot(snapshot);
output.setActive(true);
```

`pause()` stops new live writes, cancels retry or catch-up work, and resolves only after every writer that already entered the terminal parser has completed. Live output received while paused remains in the coordinator's bounded retained queue. Hosts must await this fence before capturing or disposing a core; if a host abandons hibernation, it should keep the core and call `setActive(true)`.

Snapshots are versioned opaque values intended for memory-only storage. They are bounded to 2 MiB by default and include sequence coverage so the host can fetch only newer output. Floeterm does not write snapshots to persistent browser storage.

## Responsive Resize

When the same remote terminal session can be displayed in multiple views, enable responsive options so the focused terminal re-syncs cols/rows to the remote PTY:

```ts
const core = new TerminalCore(container, {
  responsive: {
    fitOnFocus: true,
    emitResizeOnFocus: true,
    notifyResizeOnlyWhenFocused: true,
  },
});
```

When a host can capture an atomic attach boundary, call `beginAttach(startSequence)` before subscribing and starting the server attach, then pass its generation token together with the returned server boundary to `completeAttach(attachGeneration, snapshotEndSequence)`. Live output arriving during the attach round trip remains retained, while a stale attach acknowledgement cannot complete a newer generation. The convenience `attach(startSequence, snapshotEndSequence)` performs both steps when no such window exists. Route only sequences after the boundary to `pushLive`: initial history is fixed at the boundary, while catch-up history is bounded before the first retained live sequence. If defensive overlap still reaches the coordinator, the raw live copy wins over history for the same sequence so terminal query/response behavior is not replaced by replay semantics.

Passive mirrors of a remote PTY can render with the session owner's current dimensions:

```ts
const core = new TerminalCore(container, {
  fixedDimensions: { cols: 100, rows: 30 },
});

core.setFixedDimensions(null);
core.forceResize();
```

Hosts with overlay scrollbars can remove the default ghostty-web scrollbar reserve:

```ts
const core = new TerminalCore(container, {
  fit: {
    scrollbarReservePx: 0,
  },
});
```

## Clipboard

By default, upstream mouse selection keeps the `ghostty-web` behavior and copies immediately on selection. Consumers that want explicit copy commands only can disable that side effect:

```ts
const core = new TerminalCore(container, {
  clipboard: {
    copyOnSelect: false,
  },
});
```

With `copyOnSelect: false`, `TerminalCore` keeps selection explicit:

- `core.hasSelection()` reports whether the terminal currently owns a copyable selection.
- `core.copySelection()` writes the current terminal selection to the clipboard.
- `Cmd+C` / `Ctrl+C` only claims the shortcut when the terminal currently has a selection. Otherwise the shortcut falls through unchanged.

The managed controller exposes the same helpers through `controller.actions`.

## Link Providers And Buffer Reads

`TerminalCore` forwards shell lifecycle events and lets consumers register custom links over rendered terminal rows:

```ts
import { TerminalCore, type TerminalLinkProvider } from '@floegence/floeterm-terminal-web';

const linkProvider: TerminalLinkProvider = {
  provideLinks(y, callback) {
    const line = core.readBufferLine(y);
    void line;
    callback(undefined);
  },
};

const core = new TerminalCore(container, {}, {
  onBell: () => console.log('bell'),
  onTitleChange: title => console.log('title', title),
});

await core.initialize();
core.registerLinkProvider(linkProvider);
```

This is the intended extension point for product features such as modifier-click file navigation, build-log deep links, or shell attention badges driven by bell events.

## Touch Scroll Helpers

Hosts with custom mobile input surfaces can ask `TerminalCore` for a safe touch-scroll facade instead of reaching into the underlying runtime:

```ts
const touch = core.getTouchScrollRuntime();

if (touch?.isAlternateScreen()) {
  touch.sendAlternateScreenInput('\x1B[A');
} else {
  touch?.scrollLines(-3);
}
```

## Visual Work Suspension

Hosts that animate a surrounding workbench can temporarily suspend expensive terminal visual work while keeping PTY output and the terminal buffer live:

```ts
const suspend = core.beginVisualSuspend({ reason: 'workbench_widget_drag' });

try {
  // Move, zoom, or resize the host surface.
} finally {
  suspend.dispose();
}
```

While suspended, `write()` continues to update terminal state. Rendering, fit, full repaint, and overlay refresh requests are coalesced and reconciled when the final nested suspend handle is disposed.

## Multi-Terminal Render Scheduling

`TerminalCore` keeps ghostty-web rendering demand-driven and routes visible terminal repaints through a shared scheduler. Demo or profiling surfaces can inspect the scheduler without reaching into private instances:

```ts
import { getTerminalRenderSchedulerStats } from '@floegence/floeterm-terminal-web';

const stats = getTerminalRenderSchedulerStats();
console.log(stats.lastFrameRendered, stats.pending);
```

Product code should continue to interact with `TerminalCore` or the managed controller.

## Runtime Appearance Updates

Consumers that need to respond to user preferences can update appearance without rebuilding the terminal session:

```ts
import { getThemeColors } from '@floegence/floeterm-terminal-web';

core.setAppearance({
  theme: getThemeColors('light'),
  fontSize: 14,
  fontFamily: '"Iosevka Term", monospace',
  presentationScale: 1,
});

core.setFontFamily('"Iosevka Term", monospace');
```
