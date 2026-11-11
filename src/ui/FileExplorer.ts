// Compact file list with create / rename / delete (Java adaptation; not in Klode).
// Keyboard: files are buttons (Tab, Enter); F2 renames, Delete removes the focused file;
// inline name fields confirm with Enter and cancel with Escape.
import type { ProjectManager } from '../project/ProjectManager.ts';
import { isJavaPath } from '../project/paths.ts';

export interface ExplorerElements {
  list: HTMLUListElement;
  newButton: HTMLButtonElement;
  renameButton: HTMLButtonElement;
  deleteButton: HTMLButtonElement;
  message: HTMLElement; // aria-live
}

export interface ExplorerHooks {
  open(path: string): void;
  renamed(from: string, to: string): void;
  deleted(path: string): void;
  /** File operations are disabled while a program runs, to keep the run's snapshot unambiguous. */
  locked(): boolean;
  confirm(message: string): boolean;
}

export class FileExplorer {
  private editing: { mode: 'new' } | { mode: 'rename'; path: string } | null = null;

  private readonly el: ExplorerElements;
  private readonly project: ProjectManager;
  private readonly hooks: ExplorerHooks;

  constructor(el: ExplorerElements, project: ProjectManager, hooks: ExplorerHooks) {
    this.el = el;
    this.project = project;
    this.hooks = hooks;
    el.newButton.addEventListener('click', () => this.beginNew());
    el.renameButton.addEventListener('click', () => this.beginRename(project.activeFile));
    el.deleteButton.addEventListener('click', () => this.remove(project.activeFile));
    el.list.addEventListener('keydown', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-path]');
      if (!btn) return;
      if (e.key === 'F2') { e.preventDefault(); this.beginRename(btn.dataset.path!); }
      if (e.key === 'Delete') { e.preventDefault(); this.remove(btn.dataset.path!); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const all = [...el.list.querySelectorAll<HTMLButtonElement>('button[data-path]')];
        const i = all.indexOf(btn) + (e.key === 'ArrowDown' ? 1 : -1);
        all[Math.max(0, Math.min(all.length - 1, i))]?.focus();
      }
    });
    this.render();
  }

  private say(text: string) { this.el.message.textContent = text; }

  render(focusPath?: string) {
    const { list } = this.el;
    list.textContent = '';
    let lastDir: string | null = null;
    for (const path of this.project.paths) {
      const slash = path.lastIndexOf('/');
      const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
      if (dir && dir !== lastDir) {
        // Folder heading; the buttons carry the full path as their accessible name.
        const head = document.createElement('li');
        head.className = 'file-group';
        head.setAttribute('aria-hidden', 'true');
        head.textContent = dir;
        list.append(head);
      }
      lastDir = dir;
      const li = document.createElement('li');
      if (this.editing?.mode === 'rename' && this.editing.path === path) {
        li.append(this.nameField(path));
      } else {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `file${dir ? ' file-nested' : ''}${isJavaPath(path) ? '' : ' file-data'}`;
        b.dataset.path = path;
        b.textContent = path.slice(slash + 1);
        b.setAttribute('aria-label', path);
        b.title = path;
        if (path === this.project.activeFile) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', () => this.hooks.open(path));
        li.append(b);
      }
      list.append(li);
    }
    if (this.editing?.mode === 'new') {
      const li = document.createElement('li');
      li.append(this.nameField(this.suggestNewPath()));
      list.append(li);
    }
    const locked = this.hooks.locked();
    for (const b of [this.el.newButton, this.el.renameButton, this.el.deleteButton]) b.disabled = locked || this.editing !== null;
    this.el.deleteButton.disabled ||= this.project.paths.length <= 1;
    const field = list.querySelector<HTMLInputElement>('input');
    if (field) { field.focus(); const dot = field.value.lastIndexOf('.'); const slash = field.value.lastIndexOf('/') + 1; field.setSelectionRange(slash, dot > slash ? dot : field.value.length); }
    else if (focusPath) list.querySelector<HTMLButtonElement>(`button[data-path="${CSS.escape(focusPath)}"]`)?.focus();
  }

  private suggestNewPath() {
    const active = this.project.activeFile;
    const dir = active.includes('/') ? active.slice(0, active.lastIndexOf('/') + 1) : '';
    let n = 1;
    let p = `${dir}NewClass.java`;
    while (this.project.paths.some((q) => q.toLowerCase() === p.toLowerCase())) p = `${dir}NewClass${++n}.java`;
    return p;
  }

  private nameField(initial: string) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-name-input';
    input.value = initial;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', this.editing?.mode === 'new' ? 'New file path, for example example/Helper.java or data/scores.csv' : `New path for ${initial}`);
    input.setAttribute('aria-describedby', this.el.message.id);
    let done = false;
    const commit = () => {
      if (done) return;
      const value = input.value;
      try {
        const editing = this.editing;
        if (!editing) return;
        let target: string;
        if (editing.mode === 'new') {
          target = this.project.createFile(value);
          this.say(`Created ${target}`);
        } else {
          target = this.project.renameFile(editing.path, value);
          if (target !== editing.path) { this.hooks.renamed(editing.path, target); this.say(`Renamed to ${target}`); }
        }
        done = true;
        this.editing = null;
        this.render(target);
        this.hooks.open(target);
      } catch (err) {
        this.say((err as Error).message);
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    };
    const cancel = () => {
      if (done) return;
      done = true;
      const was = this.editing;
      this.editing = null;
      this.say('');
      this.render(was?.mode === 'rename' ? was.path : this.project.activeFile);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', () => { if (!done && input.getAttribute('aria-invalid') !== 'true') commit(); });
    return input;
  }

  beginNew() {
    if (this.hooks.locked()) return;
    this.editing = { mode: 'new' };
    this.say('');
    this.render();
  }

  beginRename(path: string) {
    if (this.hooks.locked() || !path) return;
    this.editing = { mode: 'rename', path };
    this.say('');
    this.render();
  }

  remove(path: string) {
    if (this.hooks.locked()) return;
    if (this.project.paths.length <= 1) { this.say('A project needs at least one file'); return; }
    if (!this.hooks.confirm(`Delete ${path}? This cannot be undone.`)) return;
    this.project.deleteFile(path);
    this.hooks.deleted(path);
    this.say(`Deleted ${path}`);
    this.render(this.project.activeFile);
    this.hooks.open(this.project.activeFile);
  }
}
