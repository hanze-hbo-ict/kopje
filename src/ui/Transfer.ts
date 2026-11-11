// Export (copy for Ans), Import (paste project) and Reset (PLAN.md §14 E1, E2, E4).
import { parseBundle, serializeProject } from '../project/bundle.ts';
import type { ProjectManager } from '../project/ProjectManager.ts';

export interface TransferHooks {
  locked(): boolean;
  say(text: string): void;           // short status, aria-live
  confirm(message: string): boolean;
  afterReplace(): void;              // files changed wholesale: reopen editor etc.
  reset(): void;
  clearAll(): void;                  // wipe the stored session and reload, as a new tab
}

const count = (n: number) => (n === 1 ? '1 file' : `${n} files`);

export class Transfer {
  private readonly $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  // Import
  private readonly importDialog = this.$<HTMLDialogElement>('transfer');
  private readonly importText = this.$<HTMLTextAreaElement>('transfer-text');
  private readonly importMessage = this.$('transfer-message');
  // Export
  private readonly exportDialog = this.$<HTMLDialogElement>('export');
  private readonly exportList = this.$<HTMLUListElement>('export-list');
  private readonly exportAll = this.$<HTMLInputElement>('export-all');
  private readonly preview = this.$<HTMLTextAreaElement>('export-preview');
  private readonly exportMessage = this.$('export-message');
  private readonly exportCount = this.$('export-count');
  private readonly copyBtn = this.$<HTMLButtonElement>('export-copy');
  private selected = new Set<string>();

  private readonly project: ProjectManager;
  private readonly hooks: TransferHooks;

  constructor(project: ProjectManager, hooks: TransferHooks) {
    this.project = project;
    this.hooks = hooks;
    this.$('project-reset').addEventListener('click', () => this.reset());
    this.$('project-clear').addEventListener('click', () => this.clearAll());
    this.$('project-import').addEventListener('click', () => this.openImport());
    this.$('project-export').addEventListener('click', () => this.openExport());

    this.$('transfer-close').addEventListener('click', () => this.importDialog.close());
    this.$('transfer-replace').addEventListener('click', () => this.doImport('replace'));
    this.$('transfer-add').addEventListener('click', () => this.doImport('add'));

    this.$('export-close').addEventListener('click', () => this.exportDialog.close());
    this.copyBtn.addEventListener('click', () => void this.copy());
    this.exportAll.addEventListener('change', () => {
      this.selected = new Set(this.exportAll.checked ? this.project.paths : []);
      this.renderExport();
    });
    this.exportList.addEventListener('change', (e) => {
      const box = e.target as HTMLInputElement;
      if (box.checked) this.selected.add(box.value); else this.selected.delete(box.value);
      this.renderExport();
    });
  }

  // ── export ──────────────────────────────────────────────────────────────────
  openExport() {
    this.selected = new Set(this.project.paths);
    this.exportList.textContent = '';
    for (const path of this.project.paths) {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = path;
      label.append(box, path);
      li.append(label);
      this.exportList.append(li);
    }
    this.exportMessage.textContent = '';
    this.renderExport();
    this.exportDialog.showModal();
    this.copyBtn.focus();
  }

  /** One file: its source as is. Several: the bundle, each with a // File: header. */
  exportText(paths = this.selectedPaths()): string {
    if (paths.length === 1) return this.project.source(paths[0]);
    return serializeProject({ ...this.project.files }, paths);
  }

  private selectedPaths() { return this.project.paths.filter((p) => this.selected.has(p)); }

  private renderExport() {
    const paths = this.selectedPaths();
    const total = this.project.paths.length;
    for (const box of this.exportList.querySelectorAll('input')) box.checked = this.selected.has(box.value);
    this.exportAll.checked = paths.length === total;
    this.exportAll.indeterminate = paths.length > 0 && paths.length < total;
    this.preview.value = this.exportText(paths);
    this.preview.placeholder = paths.length ? '' : 'No files selected';
    this.exportCount.textContent = `${count(paths.length)} selected`;
    this.copyBtn.disabled = paths.length === 0;
    this.exportMessage.textContent = '';
  }

  private async copy() {
    const paths = this.selectedPaths();
    if (!paths.length) return;
    const what = paths.length === 1 ? paths[0] : count(paths.length);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(this.preview.value);
    } catch {
      // The browser refused programmatic copying: select the preview for Ctrl+C.
      this.exportMessage.textContent = 'Automatic copying is blocked in this browser. The text is selected: press Ctrl+C (⌘C on a Mac).';
      this.preview.focus();
      this.preview.select();
      return;
    }
    this.exportDialog.close();
    this.hooks.say(`Copied ${what}.`);
  }

  // ── import ──────────────────────────────────────────────────────────────────
  openImport() {
    if (this.hooks.locked()) return;
    this.importText.value = '';
    this.importMessage.textContent = '';
    this.importDialog.showModal();
    this.importText.focus();
  }

  private doImport(mode: 'replace' | 'add') {
    let files: Record<string, string>;
    try {
      files = parseBundle(this.importText.value);
    } catch (e) {
      this.importMessage.textContent = (e as Error).message;
      this.importText.focus();
      return;
    }
    const paths = Object.keys(files);
    try {
      if (mode === 'replace') {
        if (this.project.isModified() && !this.hooks.confirm(`Replace all ${count(this.project.paths.length)} with the ${count(paths.length)} pasted? Your current changes will be lost.`)) return;
        this.project.replaceAll(files);
      } else {
        const clash = paths.filter((p) => p in this.project.files);
        if (clash.length && !this.hooks.confirm(`Overwrite ${clash.join(', ')}?`)) return;
        this.project.addFiles(files);
      }
    } catch (e) {
      this.importMessage.textContent = (e as Error).message;
      return;
    }
    this.importDialog.close();
    this.hooks.afterReplace();
    this.hooks.say(`Imported ${count(paths.length)}.`);
  }

  // ── reset ───────────────────────────────────────────────────────────────────
  reset() {
    if (this.hooks.locked()) return;
    const to = this.project.baselineIsTemplate ? 'a new project' : 'the last imported project';
    if (this.project.isModified() && !this.hooks.confirm(`Reset to ${to}? Your changes since then will be lost.`)) return;
    this.hooks.reset();
    this.hooks.say(`Reset to ${to}.`);
  }

  /** Everything back to a new tab: files, last import, arguments, theme, console, Java. Also while running. */
  clearAll() {
    if (this.project.differsFromTemplate()
      && !this.hooks.confirm('Clear all and start as a new tab? All files, including the last import, will be lost.')) return;
    this.hooks.clearAll();
  }
}
