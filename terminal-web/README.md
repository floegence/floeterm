# terminal-web

Headless xterm.js integration with data flow utilities. Provides `TerminalCore` and
`useTerminalInstance` without UI components.

## Install
```bash
# This repo does not publish npm packages.
# Install by vendoring/cloning the repo and installing from the local path.
git clone https://github.com/floegence/floeterm.git
cd floeterm/terminal-web
npm ci
npm run build
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
- The package expects your bundler to handle CSS imports (search highlight styles).
