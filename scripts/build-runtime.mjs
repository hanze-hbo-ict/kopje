#!/usr/bin/env node
// Assemble dist/ for the vertical slice:
//   dist/engine/*            parent-side engine (ES modules)
//   dist/host/runtime.html   disposable runtime document
//   dist/host/driver/*       javaedit driver classes + manifest.json
//   dist/host/javabox/*      JavaBox runtime (symlinked from RUNTIME_DIR, default runtime-prebuilt/)
//   dist/slice.html          minimal Gate 2 test page
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const RUNTIME_DIR = resolve(process.env.RUNTIME_DIR || join(ROOT, 'runtime-prebuilt'));

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'host', 'driver'), { recursive: true });
cpSync(join(ROOT, 'runtime', 'engine'), join(DIST, 'engine'), { recursive: true });
cpSync(join(ROOT, 'runtime', 'host'), join(DIST, 'host'), { recursive: true });
cpSync(join(ROOT, 'runtime', 'slice.html'), join(DIST, 'slice.html'));

// Driver bytecode targets Java 17 so any host JDK >= 17 can build it; it runs on the JDK 21 runtime.
const driverOut = join(DIST, 'host', 'driver');
execFileSync('javac', ['--release', '17', '-d', driverOut, join(ROOT, 'runtime', 'java', 'CompileServer.java')], { stdio: 'inherit' });
const classes = readdirSync(driverOut).filter((f) => f.endsWith('.class')).sort();
writeFileSync(join(driverOut, 'manifest.json'), JSON.stringify({ classes }, null, 2));

for (const f of ['javabox-direct.mjs', 'javabox-direct.wasm', 'javabox-direct.data']) {
  if (!existsSync(join(RUNTIME_DIR, f))) { console.error(`missing ${join(RUNTIME_DIR, f)} — see docs/baseline.md`); process.exit(1); }
}
symlinkSync(RUNTIME_DIR, join(DIST, 'host', 'javabox'), 'dir');
console.log(`dist/ ready (${classes.length} driver classes; runtime -> ${RUNTIME_DIR})`);
