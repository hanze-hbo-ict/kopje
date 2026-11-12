import './styles.css';
import { JavaEditor } from './editor/JavaEditor.ts';
import { JavaConsole } from './console/JavaConsole.ts';
import { FileExplorer } from './ui/FileExplorer.ts';
import { createTheme } from './ui/theme.ts';
import { Transfer } from './ui/Transfer.ts';
import { OutputFiles } from './console/OutputFiles.ts';
import { addCopyButton } from './ui/CopyButton.ts';
import { ProjectManager } from './project/ProjectManager.ts';
import { SessionStore } from './project/SessionStorage.ts';
import { templateProject, type UiState } from './project/model.ts';
import { JavaBoxEngine } from './runtime/JavaBoxEngine.ts';
import { parseArgs, formatCommand } from './project/args.ts';
import { isJavaPath } from './project/paths.ts';
import type { CompilerDiagnostic, RunResult, RuntimeEvent } from './runtime/runtime-protocol.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ── state ──────────────────────────────────────────────────────────────────────
const store = new SessionStore();
const restored = store.load();
const project = new ProjectManager(restored?.project ?? templateProject());
const ui: UiState = restored?.ui ?? { theme: 'system' };
/** Set by Clear all: nothing may be stored again before the page reloads. */
let clearing = false;
const save = (immediate = false) => {
  if (clearing) return;
  store.save(project.snapshot(), ui, immediate);
  if (immediate) $('storage-warning').hidden = store.persistent;
};
addEventListener('pagehide', () => store.flush());

// ── editor ─────────────────────────────────────────────────────────────────────
const editor = new JavaEditor($('editor'), (path, text) => project.setContent(path, text));
function openFile(path: string) {
  project.setActive(path);
  if (editor.path !== path) editor.open(path, project.source(path));
  showFilename(path);
  explorer.render();
}

addCopyButton($('editor-wrap'), 'editor-copy', 'Copy file', () => project.source(project.activeFile));

function showFilename(path: string) {
  $('filename-text').textContent = path;
  $('filename').dataset.kind = isJavaPath(path) ? 'java' : 'data';
}

// ── command line: main class + arguments ─────────────────────────────────────
const mainSelect = $<HTMLSelectElement>('main-class');
let renderedMains = '';
/** Lists the classes that have a main method; only rebuilt when that list changes. */
function renderMainSelect() {
  const candidates = project.mainCandidates();
  const selected = project.mainClass;
  const run = project.runClass;
  const key = JSON.stringify([selected, run, candidates.map((c) => c.className)]);
  if (key === renderedMains) return;
  renderedMains = key;
  mainSelect.textContent = '';
  for (const c of candidates) mainSelect.add(new Option(c.label, c.className));
  if (selected && !candidates.some((c) => c.className === selected)) {
    // Only flag it when there are other classes to pick instead; if the last main
    // went away, keep showing the plain name (Run then reports what is missing).
    const name = selected.replace(/\$/g, '.');
    mainSelect.add(new Option(candidates.length ? `${name} (no main method)` : name, selected));
  }
  // No main method anywhere: offer the first Java file's class, so Run still compiles.
  if (!selected && run) mainSelect.add(new Option(run, run));
  if (!mainSelect.options.length) {
    const none = new Option('no Java files', '');
    none.disabled = true;
    mainSelect.add(none);
  }
  mainSelect.value = selected || run;
}
mainSelect.addEventListener('change', () => project.setMainClass(mainSelect.value));

const argsInput = $<HTMLInputElement>('args');
argsInput.value = project.args;
function checkArgs(): string[] | null {
  try {
    const args = parseArgs(argsInput.value);
    argsInput.removeAttribute('aria-invalid');
    argsInput.title = argsInput.dataset.help!;
    return args;
  } catch (err) {
    argsInput.setAttribute('aria-invalid', 'true');
    argsInput.title = (err as Error).message;
    return null;
  }
}
argsInput.dataset.help = argsInput.title;
argsInput.addEventListener('input', () => { project.setArgs(argsInput.value); checkArgs(); });
// Enter on the command line runs, like a terminal.
$<HTMLFormElement>('command-line').addEventListener('submit', (e) => {
  e.preventDefault();
  if (runButton.dataset.action === 'run') void run();
});

// ── console + status ──────────────────────────────────────────────────────────
const consoleView = new JavaConsole({
  body: document.querySelector('.console-body')!, output: $('output'),
  form: $<HTMLFormElement>('input-form'), answer: $<HTMLInputElement>('answer'),
  notes: $('notes'), error: $('error'), command: $('command-echo'),
});

// Copies the console as it reads, minus the command echo: output and typed input, then notes and errors.
const consoleText = () => {
  const parts = [$('output'), $('notes'), $('error')]
    .filter((el) => !el.hidden)
    .map((el) => (el.id === 'output' ? el.textContent! : el.innerText).replace(/\n$/, ''))
    .filter((t) => t);
  return parts.length ? parts.join('\n') + '\n' : '';
};
const consoleCopy = addCopyButton($('console-wrap'), 'console-copy', 'Copy output', consoleText);
const syncConsoleCopy = () => { consoleCopy.hidden = !consoleText(); };
new MutationObserver(syncConsoleCopy).observe(document.querySelector('.console-body')!, {
  childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'],
});
syncConsoleCopy();

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
  argsInput.disabled = busy;
  $<HTMLButtonElement>('project-reset').disabled = busy;
  $<HTMLButtonElement>('project-import').disabled = busy;
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
    case 'files':
      outputFiles.show(ev);
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
  consoleView.clear();
  outputFiles.clear();
  const mainClass = project.runClass;
  if (!mainClass) {
    consoleView.error('No Java files to run.');
    return;
  }
  const args = checkArgs();
  if (!args) { consoleView.error(argsInput.title); argsInput.focus(); return; }
  store.flush();
  consoleView.command(formatCommand(mainClass, argsInput.value));
  setState(engineReady ? 'compiling' : 'starting');
  let result: RunResult;
  try {
    result = await engine.run({ ...project.files }, mainClass, onRuntimeEvent, args);
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
  if (c.type === 'content') { renderMainSelect(); save(); return; }
  if (c.type === 'args') { save(); return; }
  if (c.type === 'files' || c.type === 'main') renderMainSelect();
  save(true);
});

// ── export / import / reset (E1, E2, E4) ──────────────────────────────────────
function reopenProject() {
  editor.forgetAll();
  renderMainSelect();
  argsInput.value = project.args;
  checkArgs();
  editor.open(project.activeFile, project.source(project.activeFile));
  showFilename(project.activeFile);
  explorer.render();
}
new Transfer(project, {
  locked: busy,
  say: (text) => { $('file-message').textContent = text; },
  confirm: (m) => window.confirm(m),
  afterReplace: reopenProject,
  reset: () => {
    project.reset();
    reopenProject();
    consoleView.clear();
  },
  clearAll: () => {
    // A reload with no stored session is exactly a new tab, and tears down a running program.
    clearing = true;
    store.clear();
    location.reload();
  },
});
// ── files written by the program (PLAN.md §16 F3) ───────────────────────────
const outputFiles = new OutputFiles({
  locked: busy,
  confirm: (m) => window.confirm(m),
  exists: (p) => p in project.files,
  add: (p, text) => {
    project.saveFile(p, text);
    // editor.open replaces a cached copy whose text differs; openFile skips the file already shown.
    if (editor.path === p) editor.open(p, project.source(p));
    openFile(p);
  },
  say: (text) => { $('file-message').textContent = text; },
});

// Closing the tab loses the project (sessionStorage only survives reloads).
addEventListener('beforeunload', (e) => {
  if (clearing || !project.differsFromTemplate()) return;
  store.flush();
  e.preventDefault();
  e.returnValue = '';
});

// ── theme ──────────────────────────────────────────────────────────────────────
createTheme($<HTMLButtonElement>('theme'), ui.theme, (resolved, choice) => {
  editor.setTheme(resolved);
  if (ui.theme !== choice) { ui.theme = choice; save(true); }
});

// ── start ──────────────────────────────────────────────────────────────────────
renderMainSelect();
checkArgs();
openFile(project.activeFile);
save(true);
boot();
