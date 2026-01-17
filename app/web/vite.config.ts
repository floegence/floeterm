import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // @floegence/floeterm-terminal-web is installed via a symlink during local development, which can
    // otherwise lead to duplicated React copies (and broken hooks) in the final bundle.
    dedupe: ['react', 'react-dom']
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true
      }
    }
  }
});
