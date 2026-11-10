import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
// @ts-expect-error plain ES module without type declarations
import { ISOLATION, SECURITY_HEADERS, headersFile } from './security-headers.mjs';

// S6: the engine test page is built only for e2e runs, never for production.
const testPages = process.env.KOPJE_TEST_PAGES === '1';

/** Commit this build comes from (CI: GITHUB_SHA), for the source link in the notices. */
function sourceCommit(): string {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  try {
    const sha = process.env.GITHUB_SHA || git('rev-parse', 'HEAD');
    const dirty = !process.env.GITHUB_SHA && git('status', '--porcelain', '--untracked-files=no', '--ignore-submodules') !== '';
    return dirty ? `${sha} (plus uncommitted local changes)` : sha;
  } catch { return 'main (commit unknown)'; }
}

const headersFilePlugin = (): Plugin => ({
  name: 'kopje-headers-file',
  apply: 'build',
  writeBundle(options) {
    const dir = options.dir ?? 'dist';
    writeFileSync(join(dir, '_headers'), headersFile());
    const notices = join(dir, 'THIRD_PARTY_NOTICES.txt');
    writeFileSync(notices, readFileSync(notices, 'utf8').replaceAll('@KOPJE_COMMIT@', sourceCommit()));
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
