import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const env = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env ?? {};

const parsePort = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const backendOrigin = env.FLOETERM_BACKEND_ORIGIN ?? 'http://localhost:8080';
const backendWsOrigin = backendOrigin.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [solid()],
  server: {
    host: true,
    port: parsePort(env.FLOETERM_WEB_PORT, 5173),
    strictPort: env.FLOETERM_WEB_STRICT_PORT !== 'false',
    proxy: {
      '/api': backendOrigin,
      '/ws': {
        target: backendWsOrigin,
        ws: true,
        configure: (proxy: unknown) => {
          const emitter = proxy as { removeAllListeners?: (event: string) => void; on?: (event: string, handler: (err: unknown) => void) => void };
          emitter.removeAllListeners?.('error');
          emitter.on?.('error', (err: unknown) => {
            const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
            if (code === 'EPIPE' || code === 'ECONNRESET') {
              return;
            }
          });
        }
      }
    }
  }
});
