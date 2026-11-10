import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';

// SharedArrayBuffer needs cross-origin isolation in dev and preview too.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  base: './',
  server: { headers: isolation, host: '127.0.0.1' },
  preview: { headers: isolation, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: Object.fromEntries(['index', 'slice'].filter((n) => existsSync(`${n}.html`)).map((n) => [n, `${n}.html`])),
    },
  },
});
