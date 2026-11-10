import { defineConfig } from '@playwright/test';

// E2E_SERVER: 'dist' (default, production build) | 'dev' (vite) | 'public' (raw public/, runtime only)
const mode = process.env.E2E_SERVER || 'dist';
const commands = {
  dist: 'node scripts/serve.mjs dist 5391',
  dev: 'npx vite --port 5391 --strictPort',
  public: 'node scripts/serve.mjs public 5391',
};
export default defineConfig({
  testDir: './tests/e2e',
  // Diagnostic specs (*-diag) measure or probe and may wait for timeouts; run with DIAG=1.
  testIgnore: process.env.DIAG === '1' ? [] : [/-diag\.spec\.mjs$/],
  timeout: 240_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5391' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: commands[mode],
    url: mode === 'public' ? 'http://127.0.0.1:5391/runtime/host/runtime.html' : 'http://127.0.0.1:5391/slice.html',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
