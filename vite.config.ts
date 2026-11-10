import { defineConfig, type Plugin } from 'vite';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain ES module without type declarations
import { ISOLATION, SECURITY_HEADERS, headersFile } from './security-headers.mjs';

// S6: the engine test page is built only for e2e runs, never for production.
const testPages = process.env.JAVAEDIT_TEST_PAGES === '1';

const headersFilePlugin = (): Plugin => ({
  name: 'javaedit-headers-file',
  apply: 'build',
  writeBundle(options) {
    const dir = options.dir ?? 'dist';
    writeFileSync(join(dir, '_headers'), headersFile());
    if (!testPages && existsSync(join(dir, 'slice.html'))) throw new Error('S6: slice.html must not be in a production build');
  },
});

export default defineConfig({
  base: './',
  plugins: [headersFilePlugin()],
  // Dev keeps only isolation headers: Vite's HMR client relies on inline scripts.
  server: { headers: ISOLATION, host: '127.0.0.1' },
  preview: { headers: SECURITY_HEADERS, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: testPages ? { index: 'index.html', slice: 'slice.html' } : { index: 'index.html' },
    },
  },
});
