// runtime-host.js — runs inside the disposable runtime iframe (runtime.html).
//
// Boots ONE JavaBox JVM with the javaedit driver first on the class path, then
// bridges three channels to the parent window via postMessage:
//   control  (Java -> host): JSON lines on the /dev/jectl device
//   stdout / stderr (Java -> host): per-byte Emscripten devices, forwarded in order
//   stdin    (host -> Java): the upstream SharedArrayBuffer ring buffer (fd 0)
//
// Messages from the parent: {type:'start', files, mainClass} | {type:'stdin', text} | {type:'eof'}
// Messages to the parent:   {type:'event', event:{...}}  (see runtime-protocol.js)

const RING_SIZE = 3072;            // must match build/jvm-main.c RING_BUF_SIZE
const EOF_BYTE = 0x04;             // driver maps 0x04 to end-of-stream
const FLUSH_MS = 16;

const params = new URLSearchParams(location.search);
const RUNTIME_BASE = params.get('runtime') || './javabox/';
const DRIVER_BASE = params.get('driver') || './driver/';
const OUTPUT_CAP = Number(params.get('outputCap') || 1_000_000);   // bytes

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

function pushByte(stream, byte) {
  if (byte === null || byte === undefined) return;
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
    case 'stdin-wait': post({ kind: 'waiting-for-input' }); pumpStdin(); break;
    case 'stdin-resume': post({ kind: 'input-consumed' }); break;
    case 'exit': post({ kind: 'exit', code: msg.code, source: 'driver' }); break;
    case 'error': post({ kind: 'error', errorKind: msg.kind, message: msg.message }); break;
    case 'compiler-crash': post({ kind: 'error', errorKind: 'compiler-crash', message: msg.message }); break;
    case 'fatal': post({ kind: 'error', errorKind: 'fatal', message: msg.message }); break;
    case 'log': post({ kind: 'log', message: msg.message }); break;
    default: post({ kind: 'log', message: 'unknown control event ' + msg.t });
  }
}

// ── stdin: bounded writes into the 3 KB ring so the writer never spins ─────────
let stdinQueue = [];               // pending bytes
let pumpTimer = 0;
const encoder = new TextEncoder();

function ringUsed() {
  // jvm_debug_stdin_state() = write_pos * 10000 + read_pos  (both < RING_SIZE)
  const s = Module.ccall('jvm_debug_stdin_state', 'number', [], []);
  if (s < 0) return RING_SIZE;
  const wp = Math.floor(s / 10000), rp = s % 10000;
  return (wp - rp + RING_SIZE) % RING_SIZE;
}

function pumpStdin() {
  clearTimeout(pumpTimer);
  pumpTimer = 0;
  if (!Module || !stdinQueue.length) return;
  const free = RING_SIZE - 1 - ringUsed();
  if (free > 0) {
    const n = Math.min(free, stdinQueue.length);
    const bytes = stdinQueue.slice(0, n);
    stdinQueue = stdinQueue.slice(n);
    Module.ccall('jvm_stdin_write', null, ['array', 'number'], [bytes, bytes.length]);
  }
  if (stdinQueue.length) pumpTimer = setTimeout(pumpStdin, 20);
}

function enqueueStdin(bytes) {
  for (const b of bytes) stdinQueue.push(b);
  pumpStdin();
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
    // Appended after jvm-main.c's defaults, so these override them.
    arguments: [
      '-Djava.class.path=/opt/javaedit',
      '-Djavaedit.src=/work/src',
      '-Djavaedit.ctl=/dev/jectl',
    ],
    preRun: [(M) => {
      const FS = M.FS;
      for (const d of ['/tmp', '/tmp/hsperfdata_root', '/root', '/work', '/work/src', '/opt', '/opt/javaedit']) {
        try { FS.mkdir(d); } catch { /* exists */ }
      }
      for (const [name, bytes] of driverFiles) FS.writeFile('/opt/javaedit/' + name, bytes);
      FS.createDevice('/dev', 'jectl', null, ctlByte);
    }],
    stdout: (b) => pushByte('stdout', b),
    stderr: (b) => pushByte('stderr', b),
    print: (t) => post({ kind: 'log', message: t }),
    printErr: (t) => post({ kind: 'log', message: t }),
    onExit: (code) => { flushOutput(); post({ kind: 'exit', code, source: 'runtime' }); },
    onAbort: (what) => { flushOutput(); post({ kind: 'error', errorKind: 'abort', message: String(what) }); },
  });
  Module.ccall('jvm_enable_ring_buffer_stdin', null, [], []);
  post({ kind: 'log', message: `module instantiated in ${Math.round(performance.now() - t0)} ms` });
}

boot().catch((err) => post({ kind: 'error', errorKind: 'boot', message: String(err && err.stack || err) }));
