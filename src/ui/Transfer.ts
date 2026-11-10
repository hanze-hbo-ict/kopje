// Copy for Ans / paste project (PLAN.md §14 E1, E2) and New project (E4).
import { parseBundle, serializeProject } from '../project/bundle.ts';
import type { ProjectManager } from '../project/ProjectManager.ts';

export interface TransferHooks {
  locked(): boolean;
  say(text: string): void;           // short status, aria-live
  confirm(message: string): boolean;
  afterReplace(): void;              // files changed wholesale: reopen editor etc.
  newProject(): void;
}

export class Transfer {
  private readonly dialog: HTMLDialogElement;
  private readonly text: HTMLTextAreaElement;
  private readonly title: HTMLElement;
  private readonly help: HTMLElement;
  private readonly message: HTMLElement;
  private readonly replaceBtn: HTMLButtonElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly project: ProjectManager;
  private readonly hooks: TransferHooks;

  constructor(project: ProjectManager, hooks: TransferHooks) {
    this.project = project;
    this.hooks = hooks;
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.dialog = $('transfer');
    this.text = $('transfer-text');
    this.title = $('transfer-title');
    this.help = $('transfer-help');
    this.message = $('transfer-message');
    this.replaceBtn = $('transfer-replace');
    this.addBtn = $('transfer-add');
    this.closeBtn = $('transfer-close');
    $('copy-file').addEventListener('click', () => void this.copyFile());
    $('copy-all').addEventListener('click', () => void this.copyAll());
    $('paste-project').addEventListener('click', () => this.openPaste());
    $('new-project').addEventListener('click', () => this.newProject());
    this.closeBtn.addEventListener('click', () => this.dialog.close());
    this.replaceBtn.addEventListener('click', () => this.importText('replace'));
    this.addBtn.addEventListener('click', () => this.importText('add'));
  }

  private async copy(text: string, what: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      this.hooks.say(`Copied ${what}.`);
    } catch {
      this.openCopyFallback(text, what);
    }
  }

  copyFile() {
    const path = this.project.activeFile;
    return this.copy(this.project.source(path), path);
  }

  copyAll() {
    const n = this.project.paths.length;
    return this.copy(serializeProject({ ...this.project.files }, this.project.paths), n === 1 ? '1 file' : `${n} files`);
  }

  /** The browser refused programmatic copying: show the text selected for Ctrl+C. */
  private openCopyFallback(text: string, what: string) {
    this.title.textContent = `Copy ${what}`;
    this.help.textContent = 'Automatic copying is blocked in this browser. The text below is selected: press Ctrl+C (⌘C on a Mac), then close this window.';
    this.text.value = text;
    this.text.readOnly = true;
    this.message.textContent = '';
    this.replaceBtn.hidden = true;
    this.addBtn.hidden = true;
    this.closeBtn.textContent = 'Close';
    this.dialog.showModal();
    this.text.focus();
    this.text.select();
  }

  openPaste() {
    if (this.hooks.locked()) return;
    this.title.textContent = 'Paste project';
    this.help.textContent = 'Paste files copied with "Copy all" (each starts with a // File: line), or a single class.';
    this.text.value = '';
    this.text.readOnly = false;
    this.message.textContent = '';
    this.replaceBtn.hidden = false;
    this.addBtn.hidden = false;
    this.closeBtn.textContent = 'Cancel';
    this.dialog.showModal();
    this.text.focus();
  }

  private importText(mode: 'replace' | 'add') {
    let files: Record<string, string>;
    try {
      files = parseBundle(this.text.value);
    } catch (e) {
      this.message.textContent = (e as Error).message;
      this.text.focus();
      return;
    }
    const paths = Object.keys(files);
    try {
      if (mode === 'replace') {
        if (this.project.isModified() && !this.hooks.confirm(`Replace all ${this.project.paths.length} files with the ${paths.length} pasted file(s)? Your current files will be lost.`)) return;
        this.project.replaceAll(files);
      } else {
        const clash = paths.filter((p) => p in this.project.files);
        if (clash.length && !this.hooks.confirm(`Overwrite ${clash.join(', ')}?`)) return;
        this.project.addFiles(files);
      }
    } catch (e) {
      this.message.textContent = (e as Error).message;
      return;
    }
    this.dialog.close();
    this.hooks.afterReplace();
    this.hooks.say(`Imported ${paths.length === 1 ? '1 file' : `${paths.length} files`}.`);
  }

  newProject() {
    if (this.hooks.locked()) return;
    if (this.project.isModified() && !this.hooks.confirm('Start a new project? All current files will be removed from this tab.')) return;
    this.hooks.newProject();
  }
}
