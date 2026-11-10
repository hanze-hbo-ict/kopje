#!/usr/bin/env node
// Generates public/runtime/{driver,javabox}/ (git-ignored):
//   driver/   javaedit driver classes (javac --release 17) + manifest.json
//   javabox/  JavaBox runtime files copied from RUNTIME_DIR
// RUNTIME_DIR defaults to ~/javaedit-build/out-minimal (source build, docs/runtime-build.md),
// falling back to runtime-prebuilt/ (upstream demo artifacts; contains Doom, dev only).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'runtime');
const FILES = ['javabox-direct.mjs', 'javabox-direct.wasm', 'javabox-direct.data'];
const candidates = [process.env.RUNTIME_DIR, join(homedir(), 'javaedit-build', 'out-minimal'), join(ROOT, 'runtime-prebuilt')].filter(Boolean);
const runtimeDir = candidates.map((d) => resolve(d)).find((d) => FILES.every((f) => existsSync(join(d, f))));
if (!runtimeDir) {
  console.error(`No JavaBox runtime found in:\n  ${candidates.join('\n  ')}\nSee docs/runtime-build.md.`);
  process.exit(1);
}

const driver = join(OUT, 'driver');
rmSync(driver, { recursive: true, force: true });
mkdirSync(driver, { recursive: true });
execFileSync('javac', ['--release', '17', '-d', driver, join(ROOT, 'runtime', 'java', 'CompileServer.java')], { stdio: 'inherit' });
const classes = readdirSync(driver).filter((f) => f.endsWith('.class')).sort();
writeFileSync(join(driver, 'manifest.json'), JSON.stringify({ classes }, null, 2) + '\n');

const javabox = join(OUT, 'javabox');
rmSync(javabox, { recursive: true, force: true });
mkdirSync(javabox, { recursive: true });
const summary = {};
for (const f of FILES) {
  cpSync(join(runtimeDir, f), join(javabox, f));
  summary[f] = { bytes: statSync(join(javabox, f)).size, sha256: createHash('sha256').update(readFileSync(join(javabox, f))).digest('hex') };
}
writeFileSync(join(javabox, 'runtime.json'), JSON.stringify({ source: runtimeDir, files: summary }, null, 2) + '\n');
console.log(`public/runtime ready: ${classes.length} driver classes; runtime from ${runtimeDir}`);
for (const [f, s] of Object.entries(summary)) console.log(`  ${f}  ${(s.bytes / 1e6).toFixed(1)} MB  ${s.sha256.slice(0, 12)}`);
