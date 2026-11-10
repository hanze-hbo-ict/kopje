// Host-JVM tests for runtime/java/CompileServer.java (the javaedit runtime driver).
//
// These exercise the compile/diagnostic/stdin protocol on a local JDK (17+), with
// the same control-channel contract used in the browser. They do NOT prove WASM
// behaviour (futex wakeups, MEMFS, Emscripten exit) — see tests/e2e for that.
//
// Run: node --test tests/host/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
let classesDir;

before(() => {
  classesDir = mkdtempSync(join(tmpdir(), 'javaedit-driver-'));
  execFileSync('javac', ['--release', '17', '-d', classesDir, join(ROOT, 'runtime/java/CompileServer.java')]);
});

/** Start one single-use driver JVM against a source directory. */
function startDriver(srcDir, { poll = true } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'javaedit-run-'));
  const ctlPath = join(work, 'ctl.jsonl');
  writeFileSync(ctlPath, '');
  const child = spawn('java', [
    '-cp', classesDir,
    `-Djavaedit.src=${srcDir}`, `-Djavaedit.ctl=${ctlPath}`,
    `-Djavaedit.poll=${poll}`, '-Djavaedit.warmup=false', '-Djavaedit.stdin=-',
    'CompileServer',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { stdout: '', stderr: '', exitCode: undefined };
  child.stdout.on('data', (d) => { state.stdout += d; });
  child.stderr.on('data', (d) => { state.stderr += d; });
  const exited = new Promise((r) => child.on('exit', (code) => { state.exitCode = code; r(code); }));
  const events = () => readFileSync(ctlPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitFor = async (pred, ms = 20000) => {
    const start = Date.now();
    for (;;) {
      if (pred()) return;
      if (Date.now() - start > ms) throw new Error(`timeout; events=${JSON.stringify(events())} stdout=${state.stdout} stderr=${state.stderr}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const go = (mainClass) => child.stdin.write(`JAVAEDIT_GO ${mainClass}\n`);
  return { child, state, exited, events, waitFor, go };
}

async function compileAndRun(fixture, mainClass, input) {
  const d = startDriver(join(FIXTURES, fixture));
  await d.waitFor(() => d.events().some((e) => e.t === 'ready'));
  d.go(mainClass);
  if (input !== undefined) d.child.stdin.write(input);
  await d.exited;
  return { ...d.state, events: d.events() };
}

const compiled = (events) => events.find((e) => e.t === 'compiled');
const exitOf = (events) => events.find((e) => e.t === 'exit');

test('package: example/Main.java uses example/Calculator.java', async () => {
  const r = await compileAndRun('package-two-file', 'example.Main');
  assert.equal(compiled(r.events).ok, true);
  assert.equal(r.stdout, '2 + 3 = 5\n');
  assert.equal(exitOf(r.events).code, 0);
  assert.equal(r.exitCode, 0);
});

test('default package: two files', async () => {
  const r = await compileAndRun('default-two-file', 'Main');
  assert.equal(r.stdout, '6 * 7 = 42\n');
});

test('syntax error in second file reports that file and line', async () => {
  const r = await compileAndRun('syntax-error-second', 'example.Main');
  const c = compiled(r.events);
  assert.equal(c.ok, false);
  const err = c.diagnostics.find((d) => d.severity === 'error');
  assert.equal(err.file, 'example/Calculator.java');
  assert.equal(err.line, 5);
  assert.ok(err.column > 0);
  assert.match(err.message, /';' expected/);
  assert.equal(exitOf(r.events).code, 1);
  assert.equal(r.events.some((e) => e.t === 'running'), false, 'must not run after failed compile');
});

test('edit second file then rerun: fresh classes, no stale bytecode', async () => {
  const src = mkdtempSync(join(tmpdir(), 'javaedit-edit-'));
  cpSync(join(FIXTURES, 'package-two-file'), src, { recursive: true });
  const run = async () => {
    const d = startDriver(src);
    await d.waitFor(() => d.events().some((e) => e.t === 'ready'));
    d.go('example.Main');
    await d.exited;
    return d.state.stdout;
  };
  assert.equal(await run(), '2 + 3 = 5\n');
  const calc = join(src, 'example/Calculator.java');
  writeFileSync(calc, readFileSync(calc, 'utf8').replace('a + b', 'a * b + 100'));
  assert.equal(await run(), '2 + 3 = 106\n');
});

test('nested, anonymous, lambda, record, enum classes across packages', async () => {
  const r = await compileAndRun('nested-classes', 'app.Main');
  assert.equal(r.stdout, 'inner anon CIRCLE 12.57\nlambda\n');
  assert.ok(compiled(r.events).classes >= 6, `classes=${compiled(r.events).classes}`);
});

test('interactive: prompt without newline is flushed before input; sequential reads; EOF via 0x04', async () => {
  const d = startDriver(join(FIXTURES, 'interactive'));
  await d.waitFor(() => d.events().some((e) => e.t === 'ready'));
  d.go('Main');
  await d.waitFor(() => d.state.stdout === 'Name? ' && d.events().some((e) => e.t === 'stdin-wait'));
  d.child.stdin.write('Ada\n');
  await d.waitFor(() => d.state.stdout === 'Name? Age? ');
  d.child.stdin.write('36\n\x04');
  await d.exited;
  assert.equal(d.state.stdout, 'Name? Age? Hello Ada (36)\nEOF\n');
  const kinds = d.events().map((e) => e.t);
  assert.ok(kinds.filter((k) => k === 'stdin-wait').length >= 2, kinds.join(','));
});

test('uncaught exception: trimmed stack trace on stderr, exit 1', async () => {
  const r = await compileAndRun('exception', 'Main');
  assert.equal(r.stdout, 'before\n');
  assert.match(r.stderr, /^Exception in thread "main" java\.lang\.ArithmeticException: \/ by zero\n\tat Main\.divide\(Main\.java:2\)\n\tat Main\.main\(Main\.java:5\)\n$/);
  assert.equal(exitOf(r.events).code, 1);
});

test('System.exit(3) ends the single-use JVM with code 3', async () => {
  const r = await compileAndRun('system-exit', 'Main');
  assert.equal(r.stdout, 'exiting\n');
  assert.equal(r.exitCode, 3);
  assert.equal(exitOf(r.events), undefined, 'host learns the code from process/Module exit, not the control channel');
});

test('missing main method is a distinct error', async () => {
  const r = await compileAndRun('no-main', 'Main');
  assert.equal(r.events.find((e) => e.t === 'error').kind, 'no-main-method');
});

test('wrong main class name is a distinct error', async () => {
  const r = await compileAndRun('default-two-file', 'example.Main');
  assert.equal(r.events.find((e) => e.t === 'error').kind, 'no-main-class');
});

test('student input cannot be parsed as a control command', async () => {
  // Input sent *after* GO, even if it looks like a command, reaches the program verbatim.
  const r = await compileAndRun('interactive', 'Main', 'JAVAEDIT_GO evil.Main\nJBOX_PING\n\x04');
  assert.equal(r.stdout, 'Name? Age? Hello JAVAEDIT_GO evil.Main (JBOX_PING)\nEOF\n');
});

test('student classes cannot resolve the driver class by name', async () => {
  const src = mkdtempSync(join(tmpdir(), 'javaedit-iso-'));
  writeFileSync(join(src, 'Main.java'), `public class Main { public static void main(String[] a) {
    try { Class.forName("CompileServer"); System.out.println("visible"); }
    catch (ClassNotFoundException e) { System.out.println("hidden"); } } }`);
  const d = startDriver(src);
  await d.waitFor(() => d.events().some((e) => e.t === 'ready'));
  d.go('Main');
  await d.exited;
  assert.equal(d.state.stdout, 'hidden\n');
});

test('infinite loop keeps running until the host kills the context', async () => {
  const d = startDriver(join(FIXTURES, 'infinite-loop'));
  await d.waitFor(() => d.events().some((e) => e.t === 'ready'));
  d.go('Main');
  await d.waitFor(() => d.events().some((e) => e.t === 'running'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(d.state.exitCode, undefined);
  d.child.kill('SIGKILL'); // host-side analogue of iframe teardown
  await d.exited;
});

test('blocked in Scanner.nextLine: host kill terminates, next run is clean', async () => {
  const d = startDriver(join(FIXTURES, 'interactive'));
  await d.waitFor(() => d.events().some((e) => e.t === 'ready'));
  d.go('Main');
  await d.waitFor(() => d.events().some((e) => e.t === 'stdin-wait'));
  d.child.kill('SIGKILL');
  await d.exited;
  const r = await compileAndRun('default-two-file', 'Main');
  assert.equal(r.stdout, '6 * 7 = 42\n');
});
