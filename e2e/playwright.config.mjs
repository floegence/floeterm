import { defineConfig } from '@playwright/test';

const port = Number(process.env.FLOETERM_E2E_PORT ?? 8282);
const stateDir = process.env.FLOETERM_E2E_STATE_DIR?.trim() ?? '';
const stateArg = stateDir ? ` -state-dir ${JSON.stringify(stateDir)}` : '';
const goRun = process.env.FLOETERM_E2E_GO_RUN?.trim() || 'go run';
const headed = Boolean(process.env.CI) || process.env.FLOETERM_E2E_HEADED === '1';
const chromiumArgs = process.env.CI || !headed
  ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader']
  : [];

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    headless: !headed,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    screenshot: 'off',
    trace: 'off',
    launchOptions: {
      args: chromiumArgs,
    },
  },
  webServer: {
    command: `cd ../app/backend && ${goRun} ./cmd/floeterm -addr 127.0.0.1:${port} -static ../web/dist -log-level warn -performance-diagnostics${stateArg}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
