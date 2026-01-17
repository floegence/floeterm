# terminal-web

Headless ghostty-web (xterm.js API-compatible) integration with data flow utilities. Provides `TerminalCore` and
`useTerminalInstance` without UI components.

## Install
```bash
npm i @floegence/floeterm-terminal-web
```

## Usage (React)
```tsx
import { useTerminalInstance } from '@floegence/floeterm-terminal-web';

export function TerminalPane() {
  const { containerRef } = useTerminalInstance({
    sessionId: 'session-1',
    isActive: true,
    transport: myTransport,
    eventSource: myEventSource
  });

  return <div ref={containerRef} style={{ height: 400 }} />;
}
```

## Notes
- You must provide a `TerminalTransport` and `TerminalEventSource`.
- `ghostty-web` needs a one-time `init()` (handled internally by `TerminalCore`).
