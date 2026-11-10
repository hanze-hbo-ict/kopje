import { normalizePath, pathToClassName, classNameToPath, validateFiles, LIMITS } from './paths.ts';
import { looksLikeMain, newFileSource, templateProject, type JavaProject } from './model.ts';

export type ProjectChange =
  | { type: 'content'; path: string }
  | { type: 'files' }
  | { type: 'active' }
  | { type: 'main' };

/** In-memory project model. All path rules live in paths.ts; this enforces uniqueness. */
export class ProjectManager {
  private project: JavaProject;
  private listeners = new Set<(c: ProjectChange) => void>();

  constructor(initial: JavaProject) {
    this.project = { files: { ...initial.files }, mainClass: initial.mainClass, activeFile: initial.activeFile };
    if (!this.project.mainClass || !this.exists(classNameToPath(this.project.mainClass))) this.project.mainClass = this.defaultMain();
  }

  onChange(fn: (c: ProjectChange) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(c: ProjectChange) { for (const fn of this.listeners) fn(c); }

  snapshot(): JavaProject { return { files: { ...this.project.files }, mainClass: this.project.mainClass, activeFile: this.project.activeFile }; }
  get files(): Readonly<Record<string, string>> { return this.project.files; }
  get paths(): string[] { return Object.keys(this.project.files).sort((a, b) => a.localeCompare(b)); }
  get activeFile() { return this.project.activeFile; }
  get mainClass() { return this.project.mainClass; }
  source(path: string) { return this.project.files[path] ?? ''; }

  /** Classes the user can pick as entry point, likely mains first. */
  mainCandidates(): { className: string; hasMain: boolean }[] {
    return this.paths
      .map((p) => ({ className: pathToClassName(p), hasMain: looksLikeMain(this.project.files[p]) }))
      .sort((a, b) => Number(b.hasMain) - Number(a.hasMain) || a.className.localeCompare(b.className));
  }

  private exists(path: string) { return Object.prototype.hasOwnProperty.call(this.project.files, path); }

  private collision(path: string, except?: string): string | null {
    const key = path.toLowerCase();
    return this.paths.find((p) => p !== except && p.toLowerCase() === key) ?? null;
  }

  private defaultMain(): string {
    const c = this.mainCandidates();
    return c.length ? c[0].className : '';
  }

  setContent(path: string, text: string) {
    if (!this.exists(path) || this.project.files[path] === text) return;
    this.project.files[path] = text;
    this.emit({ type: 'content', path });
  }

  setActive(path: string) {
    if (!this.exists(path) || path === this.project.activeFile) return;
    this.project.activeFile = path;
    this.emit({ type: 'active' });
  }

  setMainClass(name: string) {
    if (name === this.project.mainClass) return;
    this.project.mainClass = name;
    this.emit({ type: 'main' });
  }

  /** @throws Error with a user-readable message */
  createFile(rawPath: string): string {
    const path = normalizePath(rawPath);
    const clash = this.collision(path);
    if (clash) throw new Error(`${clash} already exists`);
    if (this.paths.length >= LIMITS.maxFiles) throw new Error(`A project can have at most ${LIMITS.maxFiles} files`);
    this.project.files[path] = newFileSource(path);
    this.project.activeFile = path;
    if (!this.project.mainClass) this.project.mainClass = pathToClassName(path);
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
    if (this.project.mainClass === pathToClassName(from)) this.project.mainClass = pathToClassName(to);
    this.emit({ type: 'files' });
    return to;
  }

  deleteFile(path: string) {
    if (!this.exists(path)) return;
    if (this.paths.length === 1) throw new Error('A project needs at least one file');
    delete this.project.files[path];
    if (this.project.activeFile === path) this.project.activeFile = this.paths[0];
    if (this.project.mainClass === pathToClassName(path)) this.project.mainClass = this.defaultMain();
    this.emit({ type: 'files' });
  }

  /** Replace every file (paste project). Picks a main class that exists, preferring one with main(). */
  replaceAll(files: Record<string, string>) {
    const valid = validateFiles(files);
    const paths = Object.keys(valid);
    if (!paths.length) throw new Error('The project would be empty');
    this.project.files = { ...valid };
    this.project.activeFile = this.paths[0];
    this.project.mainClass = this.defaultMain();
    const main = classNameToPath(this.project.mainClass);
    if (main in this.project.files) this.project.activeFile = main;
    this.emit({ type: 'files' });
  }

  /** Add or overwrite files (paste into project). Returns the paths that were overwritten. */
  addFiles(files: Record<string, string>): string[] {
    const merged = validateFiles({ ...this.project.files, ...files });
    const overwritten = Object.keys(files).filter((p) => p in this.project.files);
    this.project.files = { ...merged };
    this.project.activeFile = Object.keys(files).sort()[0] ?? this.project.activeFile;
    if (!this.project.mainClass || !(classNameToPath(this.project.mainClass) in this.project.files)) this.project.mainClass = this.defaultMain();
    this.emit({ type: 'files' });
    return overwritten;
  }

  /** Back to the starter template (New project). */
  reset() {
    const t = templateProject();
    this.project = { files: { ...t.files }, mainClass: t.mainClass, activeFile: t.activeFile };
    this.emit({ type: 'files' });
  }

  /** True when the files differ from the starter template (used for the unload warning). */
  isModified(): boolean {
    const t = templateProject().files;
    const a = Object.keys(this.project.files), b = Object.keys(t);
    return a.length !== b.length || a.some((p) => this.project.files[p] !== t[p]);
  }
}
