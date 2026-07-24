#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const passthroughArgs = process.argv.slice(2);
const vitestArgs = [
  'run',
  '--config',
  'vitest.browser.config.ts',
  ...passthroughArgs.filter((arg, index) => !(index === 0 && arg === '--')),
];

const result = spawnSync('vitest', vitestArgs, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

const vitestStatus = result.status ?? (result.signal ? 1 : 0);
if (vitestStatus !== 0) process.exit(vitestStatus);

const gateScript = fileURLToPath(new URL('./runTerminalBrowserGate.mjs', import.meta.url));
const gate = spawnSync(process.execPath, [gateScript], {
  stdio: 'inherit',
});

if (gate.error) {
  console.error(gate.error);
  process.exit(1);
}

process.exit(gate.status ?? (gate.signal ? 1 : 0));
