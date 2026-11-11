import { normalizePath, validateFiles, isJavaPath, LIMITS } from './paths.ts';
import { templateProject, type JavaProject } from './model.ts';
import { findMains, type MainEntry } from './mains.ts';
import { MAX_ARGS_CHARS } from './args.ts';

export type ProjectChange =
  | { type: 'content'; path: string }
  | { type: 'files' }
  | { type: 'active' }
  | { type: 'main' }
  | { type: 'args' };

/** In-memory project model. All path rules live in paths.ts; this enforces uniqueness. */
export class ProjectManager {
  private project: JavaProject;
  private listeners = new Set<(c: ProjectChange) => void>();

  constructor(initial: JavaProject) {
    this.project = { files: { ...initial.files }, mainClass: initial.mainClass, activeFile: initial.activeFile, args: initial.args ?? '' };
    if (initial.baseline) this.project.baseline = { ...initial.baseline };
    if (!this.findMain(this.project.mainClass)) this.project.mainClass = this.defaultMain();
    this.syncHome();
  }

  onChange(fn: (c: ProjectChange) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(c: ProjectChange) { for (const fn of this.listeners) fn(c); }

  snapshot(): JavaProject {
    const s: JavaProject = { ...this.project, files: { ...this.project.files } };
    if (s.baseline) s.baseline = { ...s.baseline };
    return s;
  }
  /** What Reset restores: the last full import, or the starter template. */
  private get baseline(): Record<string, string> { return this.project.baseline ?? templateProject().files; }
  /** True while Reset would go back to the unchanged starter template (nothing was imported). */
  get baselineIsTemplate() { return !this.project.baseline; }
  get files(): Readonly<Record<string, string>> { return this.project.files; }
  get paths(): string[] { return Object.keys(this.project.files).sort((a, b) => a.localeCompare(b)); }
  get activeFile() { return this.project.activeFile; }
  get mainClass() { return this.project.mainClass; }
  get args() { return this.project.args; }
  source(path: string) { return this.project.files[path] ?? ''; }

  /** Classes with a launchable main method, by name. Scans are cached per file text. */
  mainCandidates(): MainEntry[] {
    const out: MainEntry[] = [];
    for (const p of this.paths) {
      if (!isJavaPath(p)) continue;
      const text = this.project.files[p];
      let hit = this.mainCache.get(p);
      if (!hit || hit.text !== text) { hit = { text, mains: findMains(p, text) }; this.mainCache.set(p, hit); }
      out.push(...hit.mains);
    }
    for (const p of this.mainCache.keys()) if (!this.exists(p)) this.mainCache.delete(p);
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }
  private mainCache = new Map<string, { text: string; mains: MainEntry[] }>();

  findMain(className: string): MainEntry | undefined {
    return className ? this.mainCandidates().find((m) => m.className === className) : undefined;
  }

  private exists(path: string) { return Object.prototype.hasOwnProperty.call(this.project.files, path); }

  private collision(path: string, except?: string): string | null {
    const key = path.toLowerCase();
    return this.paths.find((p) => p !== except && p.toLowerCase() === key) ?? null;
  }

  /** Prefer a class called Main, then the first in the menu; '' when there is none. */
  private defaultMain(): string {
    const c = this.mainCandidates();
    return (c.find((m) => /(^|[.$])Main$/.test(m.className)) ?? c[0])?.className ?? '';
  }

  setContent(path: string, text: string) {
    if (!this.exists(path) || this.project.files[path] === text) return;
    this.project.files[path] = text;
    this.emit({ type: 'content', path });
    this.followMain(path);
  }

  /**
   * After an edit: no main selected yet and one appears -> select it; the selected class
   * was renamed in the file it was last seen in (it is gone and that file now has exactly
   * one main) -> follow it. Otherwise the selection stays, so a half-typed edit, even one
   * that briefly removes every main, doesn't move it.
   */
  private followMain(path: string) {
    let next = this.project.mainClass;
    const current = this.findMain(next);
    const here = this.mainCandidates().filter((m) => m.path === path);
    if (!next) next = this.defaultMain();
    else if (!current && this.mainHome === path && here.length === 1) next = here[0].className;
    if (next !== this.project.mainClass) this.setMainClass(next);
    else if (current) this.mainHome = current.path;
  }
  /** File the selected main class was last found in. */
  private mainHome = '';
  private syncHome() { this.mainHome = this.findMain(this.project.mainClass)?.path ?? (this.project.mainClass ? this.mainHome : ''); }

  setArgs(args: string) {
    args = args.slice(0, MAX_ARGS_CHARS);
    if (args === this.project.args) return;
    this.project.args = args;
    this.emit({ type: 'args' });
  }

  setActive(path: string) {
    if (!this.exists(path) || path === this.project.activeFile) return;
    this.project.activeFile = path;
    this.emit({ type: 'active' });
  }

  setMainClass(name: string) {
    if (name === this.project.mainClass) return;
    this.project.mainClass = name;
    this.mainHome = this.findMain(name)?.path ?? this.mainHome;
    this.emit({ type: 'main' });
  }

  /** @throws Error with a user-readable message */
  createFile(rawPath: string): string {
    const path = normalizePath(rawPath);
    const clash = this.collision(path);
    if (clash) throw new Error(`${clash} already exists`);
    if (this.paths.length >= LIMITS.maxFiles) throw new Error(`A project can have at most ${LIMITS.maxFiles} files`);
    this.project.files[path] = '';
    this.project.activeFile = path;
    this.syncHome();
    this.emit({ type: 'files' });
    return path;
  }

  /** Renames the file only; source text is not refactored (PLAN.md §7.2). */
  renameFile(from: string, rawTo: string): string {
    if (!this.exists(from)) throw new Error(`${from} does not exist`);
    const to = normalizePath(rawTo);
    if (to === from) return from;
    const clash = this.collision(to, from);
    if (clash) throw new Error(`${clash} already exists`);
    const files: Record<string, string> = {};
    for (const p of Object.keys(this.project.files)) files[p === from ? to : p] = this.project.files[p];
    this.project.files = files;
    if (this.project.activeFile === from) this.project.activeFile = to;
    // The main class keeps its name: class names come from the source, which isn't refactored.
    this.syncHome();
    this.emit({ type: 'files' });
    return to;
  }

  deleteFile(path: string) {
    if (!this.exists(path)) return;
    if (this.paths.length === 1) throw new Error('A project needs at least one file');
    const wasMain = this.findMain(this.project.mainClass)?.path === path;
    delete this.project.files[path];
    if (this.project.activeFile === path) this.project.activeFile = this.paths[0];
    if (wasMain || !this.project.mainClass) this.project.mainClass = this.defaultMain();
    this.syncHome();
    this.emit({ type: 'files' });
  }

  /**
   * Replace every file (full import); the result becomes what Reset returns to.
   * Picks a main class that exists, preferring one with main().
   */
  replaceAll(files: Record<string, string>) {
    const valid = validateFiles(files);
    if (!Object.keys(valid).length) throw new Error('The project would be empty');
    this.project.baseline = { ...valid };
    this.load(valid);
    this.emit({ type: 'files' });
  }

  private load(files: Record<string, string>) {
    this.project.files = { ...files };
    this.project.activeFile = this.paths[0];
    this.project.mainClass = this.defaultMain();
    const main = this.findMain(this.project.mainClass);
    if (main) this.project.activeFile = main.path;
    this.syncHome();
  }

  /**
   * Add or overwrite files (import into project). The files are merged into what Reset
   * returns to as well. Returns the paths that were overwritten.
   */
  addFiles(files: Record<string, string>): string[] {
    const merged = validateFiles({ ...this.project.files, ...files });
    const baseline = validateFiles({ ...this.baseline, ...files });
    const overwritten = Object.keys(files).filter((p) => p in this.project.files);
    this.project.files = { ...merged };
    this.project.baseline = { ...baseline };
    this.project.activeFile = Object.keys(files).sort()[0] ?? this.project.activeFile;
    if (!this.findMain(this.project.mainClass)) this.project.mainClass = this.defaultMain();
    this.syncHome();
    this.emit({ type: 'files' });
    return overwritten;
  }

  /**
   * Create or overwrite one file and make it active, e.g. an output file the student keeps
   * (PLAN.md §16 F3). Unlike an import it is not added to what Reset returns to.
   */
  saveFile(rawPath: string, text: string): string {
    const path = normalizePath(rawPath);
    this.project.files = { ...validateFiles({ ...this.project.files, [path]: text }) };
    this.project.activeFile = path;
    this.syncHome();
    this.emit({ type: 'files' });
    return path;
  }

  /** Back to the last full import, or the starter template when there was none. Clears the arguments. */
  reset() {
    this.load(this.baseline);
    this.project.args = '';
    this.emit({ type: 'files' });
  }

  /** True when the files differ from what Reset would restore. */
  isModified(): boolean { return !sameFiles(this.project.files, this.baseline); }

  /** True when the files differ from the starter template (used for the unload warning). */
  differsFromTemplate(): boolean { return !sameFiles(this.project.files, templateProject().files); }
}

function sameFiles(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((p) => Object.prototype.hasOwnProperty.call(b, p) && a[p] === b[p]);
}
