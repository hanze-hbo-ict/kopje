// runtime-host.js — runs inside the disposable runtime iframe (runtime.html).
//
// Boots ONE JavaBox JVM with the Kopje driver first on the class path, then
// bridges three channels to the parent window via postMessage:
//   control  (Java -> host): JSON lines on the /dev/jectl device
//   stdout / stderr (Java -> host): per-byte Emscripten devices, forwarded in order
//   stdin    (host -> Java): append-only MEMFS file /work/stdin, polled by the driver
//
// Messages from the parent: {type:'start', files, mainClass, args} | {type:'stdin', text} | {type:'eof'}
//                           | {type:'collect'} (files written by the program, PLAN.md §16 F3)
// Messages to the parent:   {type:'event', event:{...}}  (see src/runtime/runtime-protocol.ts)

const EOF_BYTE = 0x04;             // driver maps 0x04 to end-of-stream
const FLUSH_MS = 16;

// Security (PLAN.md §13 S1, S4): this frame fetches nothing. The IDE page sends the runtime
// files (module source, .wasm, .data, driver classes) by postMessage, and the frame's CSP is
// connect-src 'none'. No URL parameter may choose code, classes or JVM options; outputCap is
// the only parameter and is clamped.
const OUTPUT_CAP = (() => {
  const raw = new URLSearchParams(location.search).get('outputCap');
  const n = raw !== null && /^[0-9]{1,9}$/.test(raw) ? Number(raw) : 1_000_000;
  return Math.min(Math.max(n, 1_000), 10_000_000);   // bytes
})();

// Phase 5 (S4): this document normally runs in a sandboxed iframe with an opaque origin, so it
// has no access to the IDE's DOM, storage or cookies (WebKit: same-origin fallback, see the
// engine). The parent's origin can't be named from an opaque origin, so messages go to
// `parent` with target "*". That is safe: the runtime document's CSP (frame-ancestors 'self')
// means only our own pages can be the parent.
const post = (event, transfer = []) => parent.postMessage({ type: 'event', event }, '*', transfer);

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

// ── browser stack exhaustion ─────────────────────────────────────────────────────
// HotSpot Zero makes one native call per Java call, so very deep recursion can exhaust the
// browser's worker stack before the JVM's own check throws StackOverflowError (always in
// WebKit; in Chromium/Firefox the JVM's own check fires first, at ~700-850 frames). The JVM thread then dies silently;
// report it instead of hanging until the timeout.
let stackReported = false;
addEventListener('error', (e) => {
  const msg = String(e.message || e.error?.message || '');
  if (stackReported || !/Maximum call stack size exceeded|too much recursion/i.test(msg)) return;
  stackReported = true;
  flushOutput();
  post({
    kind: 'error', errorKind: 'stack-overflow',
    message: 'StackOverflowError: the program nested method calls deeper than the browser allows '
      + '(roughly 700 calls in Edge/Chrome, fewer in Safari). Check for recursion without a base case.',
  });
});

// ── files written by the program (PLAN.md §16 F3) ───────────────────────────────
// At start the whole file system is recorded (size + mtime per file); on 'collect' every
// file that is new or changed is sent back, up to the limits. Kopje's own runtime state
// (/work: sources and stdin, the JVM's perf data, devices) is not the program's output.
// Project data files count as changed only when their content differs.
const SKIP_FS = /^\/(dev|proc|sys|work)(\/|$)|^\/tmp\/hsperfdata_root(\/|$)/;
const MAX_OUTPUT_FILES = 50;
const OUTPUT_FILE_LIMIT = 1 << 20;     // bytes per file
const OUTPUT_TOTAL_LIMIT = 5 << 20;    // bytes in total
let fsBefore = null;                   // Map<path, {size, mtime}>
const dataFiles = new Map();           // absolute path -> UTF-8 bytes as copied in
let collected = false;

function snapshotFs(FS) {
  const out = new Map();
  const walk = (dir) => {
    let names;
    try { names = FS.readdir(dir); } catch { return; }
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const path = (dir === '/' ? '' : dir) + '/' + name;
      if (SKIP_FS.test(path)) continue;
      let st;
      try { st = FS.lstat(path); } catch { continue; }
      if (FS.isDir(st.mode)) walk(path);
      else if (FS.isFile(st.mode)) out.set(path, { size: st.size, mtime: +st.mtime });
    }
  };
  walk('/');
  return out;
}

function readPrefix(FS, path, length) {
  const buf = new Uint8Array(length);
  const stream = FS.open(path, 'r');
  try { return buf.subarray(0, FS.read(stream, buf, 0, length, 0)); } finally { FS.close(stream); }
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function collectFiles() {
  const FS = Module.FS;
  const now = snapshotFs(FS);
  const changed = [];
  for (const [path, st] of now) {
    const before = fsBefore.get(path);
    const original = dataFiles.get(path);
    if (original) {
      if (st.size === original.length) {
        try { if (sameBytes(readPrefix(FS, path, st.size), original)) continue; } catch { continue; }
      }
    } else if (before && before.size === st.size && before.mtime === st.mtime) continue;
    changed.push(path);
  }
  // Working-directory files first, then other absolute paths; alphabetical within each.
  const shown = (path) => (path.startsWith('/root/') ? path.slice('/root/'.length) : path);
  changed.sort((a, b) => (shown(a).startsWith('/') - shown(b).startsWith('/')) || (shown(a) < shown(b) ? -1 : 1));
  const files = [];
  const transfer = [];
  let budget = OUTPUT_TOTAL_LIMIT;
  for (const path of changed.slice(0, MAX_OUTPUT_FILES)) {
    const size = now.get(path).size;
    let bytes;
    try { bytes = readPrefix(FS, path, Math.min(size, OUTPUT_FILE_LIMIT, budget)).slice(); } catch { continue; }
    budget -= bytes.length;
    files.push({ path: shown(path), size, bytes: bytes.buffer, truncated: bytes.length < size, changed: fsBefore.has(path) });
    transfer.push(bytes.buffer);
  }
  return { event: { kind: 'files', files, more: Math.max(0, changed.length - MAX_OUTPUT_FILES) }, transfer };
}

// ── messages from the parent ────────────────────────────────────────────────────
addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'init' && !assetsReceived) {
    assetsReceived = true;
    boot(m.assets).catch((err) => post({ kind: 'error', errorKind: 'boot', message: String(err && err.stack || err) }));
    return;
  }
  if (!Module) return;
  if (m.type === 'start' && !started) {
    started = true;
    const FS = Module.FS;
    for (const [path, text] of Object.entries(m.files)) {
      if (typeof text !== 'string') continue;
      // Paths are validated by the parent (project/paths.ts); re-check defensively.
      // Sources go to the compiler's source root; data files (PLAN.md §16 F2) to the
      // program's working directory (user.dir = /root), so the project root is the
      // working directory and the sources are not visible there.
      let full;
      if (/^([A-Za-z0-9_$\-]+\/)*[A-Za-z0-9_$\-]+\.java$/.test(path)) full = '/work/src/' + path;
      else if (/^([A-Za-z0-9_][A-Za-z0-9_.\-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(path) && !/\.(java|class)$/i.test(path)) full = '/root/' + path;
      else continue;
      try {
        if (full.lastIndexOf('/') > 0) FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
        FS.writeFile(full, text);
        if (full.startsWith('/root/')) dataFiles.set(full, encoder.encode(text));
      } catch { /* file/folder clash: rejected by the parent already */ }
    }
    fsBefore = snapshotFs(FS);
    // Each argument travels base64-encoded with a '+' prefix ('+' alone = empty), so
    // spaces, quotes and non-ASCII text survive the one-line control message.
    const args = Array.isArray(m.args) ? m.args.filter((a) => typeof a === 'string').slice(0, 100) : [];
    const b64 = (a) => '+' + btoa(String.fromCharCode(...encoder.encode(a)));
    enqueueStdin(encoder.encode(['KOPJE_GO', String(m.mainClass), ...args.map(b64)].join(' ') + '\n'));
  } else if (m.type === 'stdin' && started && typeof m.text === 'string') {
    enqueueStdin(encoder.encode(m.text));
  } else if (m.type === 'eof' && started) {
    enqueueStdin([EOF_BYTE]);
  } else if (m.type === 'collect' && started && fsBefore && !collected) {
    // Answered once, right before the parent removes this frame. MEMFS lives on this thread,
    // so the JVM's file calls are paused while it is read: each file is seen as a whole.
    collected = true;
    let result;
    try { result = collectFiles(); } catch (err) {
      post({ kind: 'log', message: 'collecting files failed: ' + err });
      result = { event: { kind: 'files', files: [], more: 0 }, transfer: [] };
    }
    post(result.event, result.transfer);
  } else if (m.type === 'stats') {
    // Diagnostics: current WASM heap size (used by tests/e2e/memory.spec.mjs).
    post({ kind: 'stats', heapBytes: Module.HEAPU8.length });
  }
});

// ── boot ───────────────────────────────────────────────────────────────────────
let assetsReceived = false;

/** gzip-compressed bytes (E5) -> ArrayBuffer. */
async function inflate(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

// ── pthread Workers from an opaque origin ─────────────────────────────────────────
// A sandboxed (opaque-origin) document may not start Workers from http(s) URLs, and
// Chromium also refuses *module* Workers from Blob URLs there; classic Blob Workers work
// (probe in PLAN.md §14). Emscripten starts its pthreads as module Workers named
// "em-pthread", so those get a classic Blob Worker that import()s the real module and
// replays messages that arrived while the import was loading. Other Workers are untouched.
// WebKit additionally refuses to clone a compiled WebAssembly.Module into these Workers
// (DataCloneError). Then the WASM bytes are sent instead and the Worker compiles them before
// Emscripten's handler sees the message (in order, via a promise chain).
let wasmBytesForWorkers = null;
const NativeWorker = self.Worker;
self.Worker = class PthreadWorker extends NativeWorker {
  constructor(url, options = {}) {
    if (!String(options.name ?? '').startsWith('em-pthread')) { super(url, options); return; }
    const moduleUrl = String(url);   // the module's Blob URL (mainScriptUrlOrBlob below)
    const bootstrap = `let chain = Promise.resolve(), handle = null; const queued = [];
const fix = async (e) => { const d = e.data; if (d && d.kopjeWasmBytes) { d.wasmModule = await WebAssembly.compile(d.kopjeWasmBytes); delete d.kopjeWasmBytes; } return e; };
self.onmessage = (e) => { chain = chain.then(() => fix(e)).then((ev) => handle ? handle(ev) : queued.push(ev)); };
import(${JSON.stringify(moduleUrl)}).then(() => {
  const emscripten = self.onmessage === null ? null : self.onmessage;
  handle = emscripten;
  self.onmessage = (e) => { chain = chain.then(() => fix(e)).then((ev) => handle(ev)); };
  chain = chain.then(() => { for (const ev of queued.splice(0)) handle(ev); });
}, (err) => setTimeout(() => { throw err; }));`;
    const blob = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
    super(blob, { name: options.name });
    // A thread that cannot start (e.g. blocked by COEP) would otherwise hang the boot silently.
    this.addEventListener('error', () => post({ kind: 'error', errorKind: 'worker', message: 'A Java runtime thread could not start' }));
  }
  postMessage(message, transfer) {
    try {
      super.postMessage(message, transfer);
    } catch (err) {
      if (err?.name !== 'DataCloneError' || !(message?.wasmModule instanceof WebAssembly.Module) || !wasmBytesForWorkers) throw err;
      const { wasmModule, ...rest } = message;
      super.postMessage({ ...rest, kopjeWasmBytes: wasmBytesForWorkers }, transfer);
    }
  }
};

async function boot(assets) {
  // Feature check rather than crossOriginIsolated: WebKit reports false in an opaque-origin
  // frame although SharedArrayBuffer and shared WASM memory work there.
  if (typeof SharedArrayBuffer !== 'function') { post({ kind: 'error', errorKind: 'not-isolated', message: 'SharedArrayBuffer unavailable: COOP/COEP headers missing' }); return; }
  const t0 = performance.now();
  const driverFiles = assets.driver.map(([name, bytes]) => [name, new Uint8Array(bytes)]);
  // The module runs from a Blob URL; the same URL starts its pthread Workers.
  const moduleUrl = URL.createObjectURL(new Blob([assets.module], { type: 'text/javascript' }));
  const [{ default: createModule }, wasmModule, dataPackage] = await Promise.all([
    import(moduleUrl),
    inflate(assets.wasm).then((b) => { wasmBytesForWorkers = b; return WebAssembly.compile(b); }),
    inflate(assets.data),
  ]);
  post({ kind: 'initializing' });

  Module = await createModule({
    locateFile: (p) => p,          // never used: every file is supplied below
    mainScriptUrlOrBlob: moduleUrl,
    // Hand Emscripten the already-fetched, decompressed files (it also posts the compiled
    // module to its pthread Workers, so they don't fetch the .wasm again).
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(wasmModule, imports).then((instance) => receive(instance, wasmModule),
        (err) => post({ kind: 'error', errorKind: 'boot', message: 'WASM instantiation failed: ' + err }));
      return {};
    },
    getPreloadedPackage: () => dataPackage,
    // The upstream prebuilt ignores Module.arguments; source builds append them after
    // jvm-main.c's defaults. The class path is NOT overridden: the driver is installed
    // over upstream's CompileServer in /opt/javabox, which works for both binaries.
    // The driver's property defaults already equal these values.
    arguments: [
      '-Dkopje.src=/work/src',
      '-Dkopje.ctl=/dev/jectl',
    ],
    preRun: [(M) => {
      const FS = M.FS;
      for (const d of ['/tmp', '/tmp/hsperfdata_root', '/root', '/work', '/work/src']) {
        try { FS.mkdir(d); } catch { /* exists */ }
      }
      // The JVM reports user.dir=/root, but relative paths are resolved by the file system
      // against the process's working directory, which Emscripten starts at "/". Make them
      // agree, so "data/scores.csv" is the project's data file (PLAN.md §16 F2).
      FS.chdir('/root');
      FS.createDevice('/dev', 'jectl', null, ctlByte);
      // Create the file only. Opening a stream here would take fd 0: preRun runs
      // before FS.init() creates the standard streams, shifting stdout/stderr.
      FS.writeFile('/work/stdin', new Uint8Array(0));
      // Install the driver as /opt/javabox/CompileServer*.class once the preload package
      // has populated the filesystem; main() is held back with a run dependency until then.
      // Kopje's runtime build preloads only /opt/jdk; the upstream prebuilt also ships
      // /opt/javabox (its own CompileServer and Doom), which is removed first.
      M.addRunDependency('kopje-driver');
      const install = () => {
        if (!FS.analyzePath('/opt/jdk/lib/modules').exists) { setTimeout(install, 2); return; }
        FS.mkdirTree('/opt/javabox');
        for (const name of FS.readdir('/opt/javabox')) {
          if (name.startsWith('CompileServer') || /^(doom\.jar|freedoom1\.wad|doom\.cfg)$/.test(name)) FS.unlink('/opt/javabox/' + name);
        }
        for (const [name, bytes] of driverFiles) FS.writeFile('/opt/javabox/' + name, bytes);
        M.removeRunDependency('kopje-driver');
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

/**
 * Whether this frame can run JavaBox's threads: start a classic Blob Worker, exactly as the
 * pthreads are started, and hand it shared WASM memory. In an opaque-origin (sandboxed) frame
 * WebKit either reports crossOriginIsolated false, or (Safari 27) reports true but refuses
 * Blob Workers under COEP ("Refused to load blob:null/... worker because of
 * Cross-Origin-Embedder-Policy"), which would hang the boot. Only the probe catches the latter.
 */
function canRunThreads() {
  if (self.crossOriginIsolated !== true || typeof SharedArrayBuffer !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    let worker = null;
    const done = (ok) => { clearTimeout(timer); try { worker?.terminate(); } catch { /* gone */ } resolve(ok); };
    const timer = setTimeout(() => done(false), 10_000);
    try {
      const src = 'self.onmessage = (e) => postMessage(e.data instanceof WebAssembly.Memory && e.data.buffer instanceof SharedArrayBuffer);';
      worker = new NativeWorker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = (e) => done(e.data === true);
      worker.onerror = () => done(false);
      worker.postMessage(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }));
    } catch { done(false); }
  });
}

// Ask the IDE page for the runtime files; boot() starts when they arrive. `isolated` tells the
// page whether this frame can run the threads; if a sandboxed frame can't, the page reloads it
// without the sandbox (WebKit). A same-origin frame reports synchronously: in WebKit, a message
// it posts in a microtask right after this script ran arrives with an `event.source` that does
// not match the iframe's contentWindow, and the page drops it (the boot then hung).
if (self.origin !== 'null') post({ kind: 'awaiting-assets', isolated: self.crossOriginIsolated === true });
else canRunThreads().then((isolated) => post({ kind: 'awaiting-assets', isolated }));
