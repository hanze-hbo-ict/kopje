#!/usr/bin/env node
// Pre-deployment checks (PLAN.md §13 S5, S6, S8). Usage:
//   node scripts/verify.mjs              package pins only (CI without a runtime build)
//   node scripts/verify.mjs dist         + the production build in dist/
//   node scripts/verify.mjs dist --lock  write runtime.lock.json from dist/ (after a deliberate runtime change)
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(ROOT, 'runtime.lock.json');
const [, , distArg, flag] = process.argv;
const problems = [];
const fail = (m) => problems.push(m);

// S8: exact npm versions only (the lockfile pins transitive dependencies).
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
for (const section of ['dependencies', 'devDependencies']) {
  for (const [name, v] of Object.entries(pkg[section] ?? {})) {
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) fail(`${section}.${name} is "${v}", not an exact version`);
  }
}
if (!existsSync(join(ROOT, 'package-lock.json'))) fail('package-lock.json is missing');

if (distArg) {
  const dist = resolve(distArg);
  const headers = existsSync(join(dist, '_headers')) ? readFileSync(join(dist, '_headers'), 'utf8') : '';
  if (!headers) fail('dist/_headers is missing');
  for (const h of ['Cross-Origin-Opener-Policy: same-origin', 'Cross-Origin-Embedder-Policy: require-corp', 'Content-Security-Policy:', "frame-ancestors 'self'", 'immutable',
                   "connect-src 'none'", 'Cross-Origin-Resource-Policy: cross-origin', 'Access-Control-Allow-Origin: *']) {
    if (!headers.includes(h)) fail(`dist/_headers lacks "${h}"`);
  }
  if (existsSync(join(dist, 'slice.html'))) fail('dist/slice.html is a test page (S6); build with `npm run build`, not build:test');
  const versions = existsSync(join(dist, 'runtime')) ? readdirSync(join(dist, 'runtime')) : [];
  if (versions.length !== 1) fail(`expected exactly one runtime version in dist/runtime, found ${versions.length}`);
  for (const v of versions) {
    const base = join(dist, 'runtime', v, 'javabox');
    const info = JSON.parse(readFileSync(join(base, 'runtime.json'), 'utf8'));
    for (const [file, { bytes, sha256 }] of Object.entries(info.files)) {
      const data = readFileSync(join(base, file));
      if (data.length !== bytes || createHash('sha256').update(data).digest('hex') !== sha256) fail(`runtime file ${file} does not match runtime.json`);
    }
    if (!info.build.some((l) => l.startsWith('link: own jvm-main.c'))) {
      fail('the runtime is not a Kopje source build (scripts/build-runtime-source.sh); never deploy the upstream prebuilt');
    }
    const pinned = Object.fromEntries(['javabox-direct.mjs', 'javabox-direct.wasm', 'javabox-direct.data'].map((f) => [f, info.files[f].sha256]));
    if (flag === '--lock') {
      writeFileSync(LOCK, JSON.stringify({ note: 'SHA-256 of the deployed runtime; update with `node scripts/verify.mjs dist --lock` after a deliberate runtime change', build: info.build, files: pinned }, null, 2) + '\n');
      console.log(`wrote ${LOCK}`);
    } else if (!existsSync(LOCK)) {
      fail('runtime.lock.json is missing (create it with `node scripts/verify.mjs dist --lock`)');
    } else {
      const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
      for (const [f, sha] of Object.entries(pinned)) if (lock.files[f] !== sha) fail(`${f} differs from runtime.lock.json`);
    }
  }
}

if (problems.length) {
  console.error('verify: FAILED\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`verify: OK${distArg ? ` (package pins + ${distArg})` : ' (package pins)'}`);
