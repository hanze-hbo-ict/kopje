import './styles.css';
import { JavaEditor } from './editor/JavaEditor.ts';
import { JavaConsole } from './console/JavaConsole.ts';
import { FileExplorer } from './ui/FileExplorer.ts';
import { createTheme } from './ui/theme.ts';
import { ProjectManager } from './project/ProjectManager.ts';
import { SessionStore } from './project/SessionStorage.ts';
import { templateProject, type UiState } from './project/model.ts';
import { JavaBoxEngine } from './runtime/JavaBoxEngine.ts';
import type { CompilerDiagnostic, RunResult, RuntimeEvent } from './runtime/runtime-protocol.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ── state ──────────────────────────────────────────────────────────────────────
const store = new SessionStore();
const restored = store.load();
const project = new ProjectManager(restored?.project ?? templateProject());
const ui: UiState = restored?.ui ?? { theme: 'system' };
const save = (immediate = false) => {
  store.save(project.snapshot(), ui, immediate);
  if (immediate) $('storage-warning').hidden = store.persistent;
};
addEventListener('pagehide', () => store.flush());

// ── editor ─────────────────────────────────────────────────────────────────────
const editor = new JavaEditor($('editor'), (path, text) => project.setContent(path, text));
function openFile(path: string) {
  project.setActive(path);
  if (editor.path !== path) editor.open(path, project.source(path));
  $('filename-text').textContent = path;
  explorer.render();
}

// ── main class selector ───────────────────────────────────────────────────────
const mainSelect = $<HTMLSelectElement>('main-class');
function renderMainSelect() {
  const candidates = project.mainCandidates();
  mainSelect.textContent = '';
  for (const c of candidates) mainSelect.add(new Option(c.className, c.className));
  if (project.mainClass && !candidates.some((c) => c.className === project.mainClass)) {
    mainSelect.add(new Option(`${project.mainClass} (missing)`, project.mainClass));
  }
  mainSelect.value = project.mainClass;
}
mainSelect.addEventListener('change', () => project.setMainClass(mainSelect.value));

// ── console + status ──────────────────────────────────────────────────────────
const consoleView = new JavaConsole({
  body: document.querySelector('.console-body')!, output: $('output'),
  form: $<HTMLFormElement>('input-form'), answer: $<HTMLInputElement>('answer'),
  notes: $('notes'), error: $('error'),
});

type AppState = 'loading' | 'ready' | 'starting' | 'compiling' | 'running' | 'waiting-for-input' | 'failed';
const LABELS: Record<AppState, string> = {
  loading: 'Starting Java…', ready: 'Ready', starting: 'Starting Java…', compiling: 'Compiling…',
  running: 'Running', 'waiting-for-input': 'Waiting for input', failed: 'Unavailable',
};
let state: AppState = 'loading';
const runButton = $<HTMLButtonElement>('run');
function setState(next: AppState) {
  state = next;
  const status = $('status');
  status.textContent = LABELS[next];
  status.dataset.state = next;
  const busy = next === 'starting' || next === 'compiling' || next === 'running' || next === 'waiting-for-input';
  const [action, label, symbol] =
    busy ? ['stop', 'Stop', '■'] :
    next === 'ready' ? ['run', 'Run code', '▶'] :
    next === 'failed' ? ['retry', 'Retry', ''] : ['busy', 'Loading…', ''];
  runButton.dataset.action = action;
  runButton.disabled = action === 'busy';
  runButton.textContent = label;
  if (symbol) {
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = symbol;
    runButton.prepend(icon, ' ');
  }
  mainSelect.disabled = busy;
  explorer?.render();
}

// ── engine ─────────────────────────────────────────────────────────────────────
const engine = new JavaBoxEngine();
let engineReady = false;
function boot() {
  setState('loading');
  consoleView.error('');
  engine.initialize().then(
    () => { engineReady = true; if (state === 'loading') setState('ready'); },
    (err: Error) => {
      if (state !== 'loading') return;
      setState('failed');
      consoleView.error(`Java could not start: ${err.message}${crossOriginIsolated ? '' : '\nThis page must be served with Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.'}`);
    },
  );
}

function openDiagnostic(d: CompilerDiagnostic) {
  if (!d.file || !(d.file in project.files)) return;
  openFile(d.file);
  editor.goTo(d.line, d.column);
}

function onRuntimeEvent(ev: RuntimeEvent) {
  switch (ev.kind) {
    case 'initializing': if (!engineReady) setState('starting'); break;
    case 'compiling': setState('compiling'); break;
    case 'running': setState('running'); break;
    case 'stdout': case 'stderr': consoleView.append(ev.kind, ev.text); break;
    case 'waiting-for-input':
      setState('waiting-for-input');
      consoleView.requestInput((line) => engine.sendInput(line + '\n'), () => engine.sendEof());
      break;
    case 'input-consumed':
      if (state === 'waiting-for-input') setState('running');
      break;
    case 'error':
      consoleView.error(ev.message);
      break;
  }
}

function reportResult(r: RunResult) {
  consoleView.hideInput();
  switch (r.status) {
    case 'exit': if (r.code !== 0) consoleView.note(`Exited with status ${r.code}.`); break;
    case 'compile-error': {
      const first = consoleView.diagnostics(r.diagnostics, openDiagnostic);
      const firstError = r.diagnostics.find((d) => d.severity === 'error' && d.file);
      if (firstError) openDiagnostic(firstError);
      else first?.focus();
      break;
    }
    case 'stopped': consoleView.note('Stopped.'); break;
    case 'timeout': consoleView.note('Stopped: the program ran longer than the time limit (2 minutes).'); break;
    case 'output-limit': consoleView.note('Stopped: the program printed more than 1 MB of output.'); break;
    case 'error': consoleView.error(r.message); break;
  }
}

async function run() {
  if (!project.mainClass) { consoleView.clear(); consoleView.error('Choose a main class first.'); return; }
  store.flush();
  consoleView.clear();
  setState(engineReady ? 'compiling' : 'starting');
  let result: RunResult;
  try {
    result = await engine.run({ ...project.files }, project.mainClass, onRuntimeEvent);
  } catch (err) {
    result = { status: 'error', message: (err as Error).message };
  }
  engineReady = true; // a spare runtime is pre-booted after every run
  reportResult(result);
  setState('ready');
}

runButton.addEventListener('click', () => {
  const action = runButton.dataset.action;
  if (action === 'run') void run();
  else if (action === 'stop') void engine.stop();
  else if (action === 'retry') boot();
});

// ── files ──────────────────────────────────────────────────────────────────────
const busy = () => state === 'starting' || state === 'compiling' || state === 'running' || state === 'waiting-for-input';
const explorer: FileExplorer = new FileExplorer(
  {
    list: $<HTMLUListElement>('file-list'), newButton: $<HTMLButtonElement>('file-new'),
    renameButton: $<HTMLButtonElement>('file-rename'), deleteButton: $<HTMLButtonElement>('file-delete'),
    message: $('file-message'),
  },
  project,
  {
    open: (p) => openFile(p),
    renamed: (from, to) => editor.rename(from, to),
    deleted: (p) => editor.forget(p),
    locked: busy,
    confirm: (m) => window.confirm(m),
  },
);

project.onChange((c) => {
  if (c.type === 'content') { save(); return; }
  if (c.type === 'files' || c.type === 'main') renderMainSelect();
  save(true);
});

// ── theme ──────────────────────────────────────────────────────────────────────
createTheme($<HTMLButtonElement>('theme'), ui.theme, (resolved, choice) => {
  editor.setTheme(resolved);
  if (ui.theme !== choice) { ui.theme = choice; save(true); }
});

// ── start ──────────────────────────────────────────────────────────────────────
renderMainSelect();
openFile(project.activeFile);
save(true);
boot();
