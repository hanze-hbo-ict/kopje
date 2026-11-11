// sessionStorage adapter: source + UI state only, for reload of the same tab.
//
// Caveats (also in docs/limitations.md): browsers may restore sessionStorage when a
// closed tab or a whole session is restored; a duplicated tab starts with a copy of
// the original's storage; sessionStorage is not a secure-deletion mechanism. Compiled
// classes and console contents are never stored. Any storage error (quota, disabled
// storage, private mode) degrades to in-memory operation.

import { validateFiles, isValidMainClass } from './paths.ts';
import type { JavaProject, UiState, ThemeChoice } from './model.ts';
import { MAX_ARGS_CHARS } from './args.ts';

const KEY = 'kopje:session:v1';

interface Stored { v: 1; project: JavaProject; ui: UiState }

export class SessionStore {
  /** false once a write has failed; the app keeps working in memory. */
  persistent = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Stored | null = null;

  private readonly storage: Storage | null;

  constructor(storage: Storage | null = SessionStore.available()) {
    this.storage = storage;
    if (!this.storage) this.persistent = false;
  }

  static available(): Storage | null {
    try { return window.sessionStorage; } catch { return null; }
  }

  load(): { project: JavaProject; ui: UiState } | null {
    if (!this.storage) return null;
    let raw: string | null;
    try { raw = this.storage.getItem(KEY); } catch { return null; }
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as Partial<Stored>;
      if (data.v !== 1 || !data.project) return null;
      const files = validateFiles(data.project.files ?? {});
      const paths = Object.keys(files);
      if (!paths.length) return null;
      const activeFile = paths.includes(data.project.activeFile) ? data.project.activeFile : paths[0];
      const mainClass = isValidMainClass(data.project.mainClass) ? data.project.mainClass : '';
      const theme: ThemeChoice = (['system', 'light', 'dark'] as const).includes(data.ui?.theme as ThemeChoice)
        ? (data.ui!.theme as ThemeChoice) : 'system';
      const args = typeof data.project.args === 'string' ? data.project.args.slice(0, MAX_ARGS_CHARS) : '';
      const project: JavaProject = { files, activeFile, mainClass, args };
      if (data.project.baseline) {
        try {
          const baseline = validateFiles(data.project.baseline);
          if (Object.keys(baseline).length) project.baseline = baseline;
        } catch { /* invalid baseline: Reset falls back to the template */ }
      }
      return { project, ui: { theme } };
    } catch {
      return null; // corrupt or from an incompatible version: start fresh
    }
  }

  /** Debounced save for editing; `immediate` for file operations and UI changes. */
  save(project: JavaProject, ui: UiState, immediate = false) {
    this.pending = { v: 1, project: { ...project, files: { ...project.files }, ...(project.baseline && { baseline: { ...project.baseline } }) }, ui: { ...ui } };
    clearTimeout(this.timer);
    if (immediate) this.flush();
    else this.timer = setTimeout(() => this.flush(), 400);
  }

  /** Remove the stored session (Reset to the template). */
  clear() {
    clearTimeout(this.timer);
    this.pending = null;
    try { this.storage?.removeItem(KEY); } catch { /* ignore */ }
  }

  flush() {
    clearTimeout(this.timer);
    const data = this.pending;
    this.pending = null;
    if (!data || !this.storage) return;
    try {
      this.storage.setItem(KEY, JSON.stringify(data));
      this.persistent = true;
    } catch {
      this.persistent = false;
    }
  }
}
