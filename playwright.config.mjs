import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 240_000,
  workers: 1,
  use: { baseURL: 'http://localhost:5173' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: { command: 'node scripts/serve.mjs dist 5173', port: 5173, reuseExistingServer: true },
});
