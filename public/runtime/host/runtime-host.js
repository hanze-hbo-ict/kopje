// runtime-host.js — runs inside the disposable runtime iframe (runtime.html).
//
// Boots ONE JavaBox JVM with the javaedit driver first on the class path, then
// bridges three channels to the parent window via postMessage:
//   control  (Java -> host): JSON lines on the /dev/jectl device
//   stdout / stderr (Java -> host): per-byte Emscripten devices, forwarded in order
//   stdin    (host -> Java): append-only MEMFS file /work/stdin, polled by the driver
//
// Messages from the parent: {type:'start', files, mainClass} | {type:'stdin', text} | {type:'eof'}
// Messages to the parent:   {type:'event', event:{...}}  (see src/runtime/runtime-protocol.ts)

const EOF_BYTE = 0x04;             // driver maps 0x04 to end-of-stream
const FLUSH_MS = 16;

// Security (PLAN.md §13 S1): asset locations are fixed and same-origin. No URL parameter
// may choose code, classes or JVM options; outputCap is the only parameter and is clamped.
const RUNTIME_BASE = new URL('../javabox/', location.href).href;
const DRIVER_BASE = new URL('../driver/', location.href).href;
const OUTPUT_CAP = (() => {
  const raw = new URLSearchParams(location.search).get('outputCap');
  const n = raw !== null && /^[0-9]{1,9}$/.test(raw) ? Number(raw) : 1_000_000;
  return Math.min(Math.max(n, 1_000), 10_000_000);   // bytes
})();

const parentOrigin = location.origin;   // same-origin topology (Phase 5 may change this)
const post = (event) => parent.postMessage({ type: 'event', event }, parentOrigin);

let Module = null;
let started = false;

// ── output: preserve stdout/stderr interleaving at byte granularity ────────────
const chunks = [];                 // [{stream, bytes:number[]}]
let outputBytes = 0;
let capped = false;
let flushTimer = 0;
const decoders = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') };

const bootNoise = [];
function pushByte(stream, byte) {
  if (byte === null || byte === undefined) return;
  if (!started) {             // before the run starts, output is runtime noise, not the program's
    bootNoise.push(byte & 0xff);
    if (byte === 0x0a) { post({ kind: 'log', message: `[boot ${stream}] ` + new TextDecoder().decode(new Uint8Array(bootNoise)).trimEnd() }); bootNoise.length = 0; }
    return;
  }
  if (capped) return;
  if (++outputBytes > OUTPUT_CAP) {
    capped = true;
    flushOutput();
    post({ kind: 'output-limit', limit: OUTPUT_CAP });
    return;
  }
  const last = chunks[chunks.length - 1];
  if (last && last.stream === stream) last.bytes.push(byte & 0xff);
  else chunks.push({ stream, bytes: [byte & 0xff] });
  if (!flushTimer) flushTimer = setTimeout(flushOutput, FLUSH_MS);
}

function flushOutput() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  for (const c of chunks.splice(0)) {
    const text = decoders[c.stream].decode(new Uint8Array(c.bytes), { stream: true });
    if (text) post({ kind: c.stream, text });
  }
}

// ── control channel ─────────────────────────────────────────────────────────────
let ctlBuf = [];
const ctlDecoder = new TextDecoder('utf-8');
function ctlByte(byte) {
  if (byte === null || byte === undefined) return;
  if (byte !== 0x0a) { if (ctlBuf.length < 4 << 20) ctlBuf.push(byte); return; }
  const line = ctlDecoder.decode(new Uint8Array(ctlBuf));
  ctlBuf = [];
  let msg;
  try { msg = JSON.parse(line); } catch { post({ kind: 'log', message: 'bad control line: ' + line.slice(0, 200) }); return; }
  flushOutput();   // keep output that precedes a status change ahead of it
  switch (msg.t) {
    case 'ready': post({ kind: 'ready' }); break;
    case 'compiling': post({ kind: 'compiling' }); break;
    case 'compiled': post({ kind: 'compiled', ok: msg.ok, ms: msg.ms, diagnostics: msg.diagnostics }); break;
    case 'running': post({ kind: 'running' }); break;
    case 'stdin-wait': post({ kind: 'waiting-for-input' }); break;
    case 'stdin-resume': post({ kind: 'input-consumed' }); break;
    case 'exit': post({ kind: 'exit', code: msg.code, source: 'driver' }); break;
    case 'error': post({ kind: 'error', errorKind: msg.kind, message: msg.message }); break;
    case 'compiler-crash': post({ kind: 'error', errorKind: 'compiler-crash', message: msg.message }); break;
    case 'fatal': post({ kind: 'error', errorKind: 'fatal', message: msg.message }); break;
    case 'log': post({ kind: 'log', message: msg.message }); break;
    default: post({ kind: 'log', message: 'unknown control event ' + msg.t });
  }
}

// ── stdin: append-only MEMFS file polled by the driver ──────────────────────────
// The prebuilt's fd 0 ring buffer reports available() == 0 forever, so the driver
// cannot wait on it without risking the upstream futex lost-wakeup. MEMFS lives on
// this (main) thread; the JVM's reads are proxied here, so appends are seen at once.
let stdinStream = null;
const encoder = new TextEncoder();
function enqueueStdin(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (!data.length) return;
  stdinStream ??= Module.FS.open('/work/stdin', 'a');
  Module.FS.write(stdinStream, data, 0, data.length);
}

// ── messages from the parent ────────────────────────────────────────────────────
addEventListener('message', (e) => {
  if (e.origin !== parentOrigin || e.source !== parent) return;
  const m = e.data;
  if (!m || typeof m.type !== 'string' || !Module) return;
  if (m.type === 'start' && !started) {
    started = true;
    const FS = Module.FS;
    for (const [path, text] of Object.entries(m.files)) {
      // Paths are validated by the parent (project/paths.js); re-check defensively.
      if (!/^([A-Za-z0-9_$\-]+\/)*[A-Za-z0-9_$\-]+\.java$/.test(path)) continue;
      const full = '/work/src/' + path;
      FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
      FS.writeFile(full, text);
    }
    enqueueStdin(encoder.encode('JAVAEDIT_GO ' + m.mainClass + '\n'));
  } else if (m.type === 'stdin' && started && typeof m.text === 'string') {
    enqueueStdin(encoder.encode(m.text));
  } else if (m.type === 'eof' && started) {
    enqueueStdin([EOF_BYTE]);
  }
});

// ── boot ───────────────────────────────────────────────────────────────────────
async function boot() {
  if (!crossOriginIsolated) { post({ kind: 'error', errorKind: 'not-isolated', message: 'SharedArrayBuffer unavailable: COOP/COEP headers missing' }); return; }
  const t0 = performance.now();
  const manifest = await (await fetch(DRIVER_BASE + 'manifest.json')).json();
  const driverFiles = await Promise.all(manifest.classes.map(async (name) =>
    [name, new Uint8Array(await (await fetch(DRIVER_BASE + encodeURIComponent(name))).arrayBuffer())]));
  const { default: createModule } = await import(RUNTIME_BASE + 'javabox-direct.mjs');
  post({ kind: 'initializing' });

  Module = await createModule({
    locateFile: (p) => RUNTIME_BASE + p,
    // The upstream prebuilt ignores Module.arguments; source builds append them after
    // jvm-main.c's defaults. The class path is NOT overridden: the driver is installed
    // over upstream's CompileServer in /opt/javabox, which works for both binaries.
    // The driver's property defaults already equal these values.
    arguments: [
      '-Djavaedit.src=/work/src',
      '-Djavaedit.ctl=/dev/jectl',
    ],
    preRun: [(M) => {
      const FS = M.FS;
      for (const d of ['/tmp', '/tmp/hsperfdata_root', '/root', '/work', '/work/src']) {
        try { FS.mkdir(d); } catch { /* exists */ }
      }
      FS.createDevice('/dev', 'jectl', null, ctlByte);
      // Create the file only. Opening a stream here would take fd 0: preRun runs
      // before FS.init() creates the standard streams, shifting stdout/stderr.
      FS.writeFile('/work/stdin', new Uint8Array(0));
      // The prebuilt ignores Module.arguments, so the class path cannot be changed.
      // Instead hold main() back with a run dependency until the preload package has
      // populated /opt/javabox, then overwrite upstream's CompileServer*.class with
      // ours and drop Doom from the class path (ADR-1, revised).
      M.addRunDependency('javaedit-driver');
      const install = () => {
        if (!FS.analyzePath('/opt/javabox/CompileServer.class').exists) { setTimeout(install, 2); return; }
        for (const name of FS.readdir('/opt/javabox')) {
          if (name.startsWith('CompileServer') || /^(doom\.jar|freedoom1\.wad|doom\.cfg)$/.test(name)) FS.unlink('/opt/javabox/' + name);
        }
        for (const [name, bytes] of driverFiles) FS.writeFile('/opt/javabox/' + name, bytes);
        M.removeRunDependency('javaedit-driver');
      };
      install();
    }],
    stdout: (b) => pushByte('stdout', b),
    stderr: (b) => pushByte('stderr', b),
    print: (t) => post({ kind: 'log', message: t }),
    printErr: (t) => post({ kind: 'log', message: t }),
    onExit: (code) => { flushOutput(); post({ kind: 'exit', code, source: 'runtime' }); },
    onAbort: (what) => { flushOutput(); post({ kind: 'error', errorKind: 'abort', message: String(what) }); },
  });
  // Not used for input, but keeps direct FileDescriptor.in reads blocking harmlessly
  // in the JVM thread instead of hitting Emscripten's default TTY (window.prompt).
  Module.ccall('jvm_enable_ring_buffer_stdin', null, [], []);
  post({ kind: 'log', message: `module instantiated in ${Math.round(performance.now() - t0)} ms` });
}

boot().catch((err) => post({ kind: 'error', errorKind: 'boot', message: String(err && err.stack || err) }));
