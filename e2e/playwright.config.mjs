import { defineConfig } from '@playwright/test';

const port = 8282;
const chromiumArgs = process.env.CI
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
    headless: false,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    screenshot: 'off',
    trace: 'off',
    launchOptions: {
      args: chromiumArgs,
    },
  },
  webServer: {
    command: `cd ../app/backend && go run ./cmd/floeterm -addr 127.0.0.1:${port} -static ../web/dist -log-level warn -performance-diagnostics`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
