// Files written by the program (PLAN.md §16 F3): a bar at the bottom of the console that
// lists them with facts only, and a read-only viewer. Cleared when the next run starts;
// never stored. The project changes only when the student chooses "Add to project".
import type { OutputFile, RuntimeEvent } from '../runtime/runtime-protocol.ts';
import { describeFile, factsLine, hexDump, formatSize, type FileDescription } from './fileKind.ts';
import { normalizePath, isJavaPath } from '../project/paths.ts';

type FilesEvent = Extract<RuntimeEvent, { kind: 'files' }>;
const HEX_LIMIT = 64 * 1024;

export interface OutputFilesHooks {
  locked(): boolean;
  confirm(message: string): boolean;
  exists(path: string): boolean;
  /** @throws Error with a user-readable message */
  add(path: string, text: string): void;
  say(text: string): void;
}

interface Entry { file: OutputFile; bytes: Uint8Array; desc: FileDescription; facts: string }

export class OutputFiles {
  private readonly $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  private readonly bar = this.$('output-files');
  private readonly list = this.$<HTMLUListElement>('output-files-list');
  private readonly count = this.$('output-files-count');
  private readonly note = this.$('output-files-note');
  private readonly toggle = this.$<HTMLButtonElement>('output-files-toggle');
  private readonly dialog = this.$<HTMLDialogElement>('file-viewer');
  private readonly title = this.$('viewer-title');
  private readonly facts = this.$('viewer-facts');
  private readonly body = this.$('viewer-body');
  private readonly message = this.$('viewer-message');
  private readonly sourceBtn = this.$<HTMLButtonElement>('viewer-source');
  private readonly addBtn = this.$<HTMLButtonElement>('viewer-add');
  private readonly copyBtn = this.$<HTMLButtonElement>('viewer-copy');
  private readonly hooks: OutputFilesHooks;
  private entries: Entry[] = [];
  private current: Entry | null = null;
  private url = '';

  constructor(hooks: OutputFilesHooks) {
    this.hooks = hooks;
    this.toggle.addEventListener('click', () => this.setExpanded(this.toggle.getAttribute('aria-expanded') !== 'true'));
    this.list.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-index]');
      if (row) this.open(this.entries[Number(row.dataset.index)]);
    });
    this.$('viewer-close').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => this.release());
    this.copyBtn.addEventListener('click', () => void this.copy());
    this.addBtn.addEventListener('click', () => this.addToProject());
    this.sourceBtn.addEventListener('click', () => {
      const on = this.sourceBtn.getAttribute('aria-pressed') !== 'true';
      this.sourceBtn.setAttribute('aria-pressed', String(on));
      if (this.current) this.renderBody(this.current, on);
    });
  }

  /** Before the next run. */
  clear() {
    if (this.dialog.open) this.dialog.close();
    this.entries = [];
    this.list.textContent = '';
    this.bar.hidden = true;
  }

  show(ev: FilesEvent) {
    this.entries = ev.files.map((file) => {
      const bytes = new Uint8Array(file.bytes);
      const desc = describeFile(bytes, file.truncated);
      return { file, bytes, desc, facts: factsLine(desc, file.size, file) };
    });
    this.list.textContent = '';
    this.entries.forEach((entry, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'output-file';
      b.dataset.index = String(i);
      const name = document.createElement('span');
      name.className = 'output-file-name';
      name.textContent = entry.file.path;
      const facts = document.createElement('span');
      facts.className = 'output-file-facts';
      facts.textContent = entry.facts;
      b.append(name, facts);
      b.setAttribute('aria-label', `${entry.file.path}, ${entry.facts}`);
      li.append(b);
      this.list.append(li);
    });
    if (ev.more) {
      const li = document.createElement('li');
      li.className = 'output-files-more';
      li.textContent = `+ ${ev.more.toLocaleString('en')} more`;
      this.list.append(li);
    }
    this.count.textContent = (ev.files.length + ev.more).toLocaleString('en');
    this.note.textContent = ev.stopped ? ' · as they were when the program was stopped' : '';
    this.bar.hidden = false;
  }

  private setExpanded(on: boolean) {
    this.toggle.setAttribute('aria-expanded', String(on));
    this.toggle.setAttribute('aria-label', on ? 'Hide the file list' : 'Show the file list');
    this.toggle.dataset.tooltip = on ? 'Hide' : 'Show';
    this.list.hidden = !on;
  }

  // ── viewer ──────────────────────────────────────────────────────────────────
  private open(entry: Entry | undefined) {
    if (!entry) return;
    this.current = entry;
    const { desc, file } = entry;
    this.title.textContent = file.path;
    this.facts.textContent = desc.kind === 'binary' && entry.bytes.length > HEX_LIMIT
      ? `${entry.facts} · first ${formatSize(HEX_LIMIT)} shown` : entry.facts;
    this.message.textContent = '';
    const hasText = desc.text !== undefined;
    this.sourceBtn.hidden = desc.kind !== 'svg';
    this.sourceBtn.setAttribute('aria-pressed', 'false');
    this.copyBtn.hidden = !hasText;
    this.addBtn.hidden = !this.addablePath(entry);
    this.renderBody(entry, false);
    this.dialog.showModal();
    (this.copyBtn.hidden ? this.$('viewer-close') : this.copyBtn).focus();
  }

  private renderBody(entry: Entry, source: boolean) {
    this.release(false);
    this.body.textContent = '';
    const { desc, bytes } = entry;
    if (desc.kind === 'text' || desc.kind === 'empty' || (desc.kind === 'svg' && source)) {
      const t = document.createElement('textarea');
      t.className = 'viewer-text';
      t.readOnly = true;
      t.spellcheck = false;
      t.value = desc.text ?? '';
      t.placeholder = desc.kind === 'empty' ? 'Empty file' : '';
      t.setAttribute('aria-label', `Contents of ${entry.file.path}`);
      this.body.append(t);
    } else if (desc.kind === 'svg' || desc.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'viewer-image';
      img.alt = entry.file.path;
      img.src = this.blobUrl(bytes, desc.mime!);
      this.body.append(img);
    } else if (desc.kind === 'audio' || desc.kind === 'video') {
      const media = document.createElement(desc.kind);
      media.className = `viewer-${desc.kind}`;
      media.controls = true;
      media.setAttribute('controlslist', 'nodownload');
      media.src = this.blobUrl(bytes, desc.mime!);
      media.setAttribute('aria-label', entry.file.path);
      this.body.append(media);
    } else if (desc.kind === 'pdf' && navigator.pdfViewerEnabled) {
      // The browser's own PDF viewer. It can't be sandboxed (browsers refuse PDFs in
      // sandboxed frames); the blob's type is fixed to application/pdf, so it is never HTML.
      const frame = document.createElement('iframe');
      frame.className = 'viewer-pdf';
      frame.title = entry.file.path;
      frame.src = this.blobUrl(bytes, desc.mime!);
      this.body.append(frame);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'viewer-hex';
      pre.tabIndex = 0;
      pre.textContent = hexDump(bytes, HEX_LIMIT);
      pre.setAttribute('aria-label', `Bytes of ${entry.file.path}`);
      this.body.append(pre);
    }
  }

  private blobUrl(bytes: Uint8Array, type: string) {
    this.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    return this.url;
  }

  private release(all = true) {
    if (this.url) { URL.revokeObjectURL(this.url); this.url = ''; }
    if (all) { this.body.textContent = ''; this.current = null; }
  }

  /** The project path a file can be kept under: a whole text file in the working directory, not Java. */
  private addablePath(entry: Entry): string | null {
    if (entry.desc.text === undefined || entry.file.truncated || entry.file.path.startsWith('/')) return null;
    try {
      const p = normalizePath(entry.file.path);
      return isJavaPath(p) ? null : p;
    } catch {
      return null;
    }
  }

  private async copy() {
    const text = this.current?.desc.text;
    if (text === undefined) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      this.message.textContent = 'Copied.';
    } catch {
      const t = this.body.querySelector('textarea');
      if (!t) {
        if (this.current) this.renderBody(this.current, true);
        this.sourceBtn.setAttribute('aria-pressed', 'true');
      }
      const area = this.body.querySelector('textarea');
      this.message.textContent = 'Automatic copying is blocked in this browser. The text is selected: press Ctrl+C (⌘C on a Mac).';
      area?.focus();
      area?.select();
    }
  }

  private addToProject() {
    const entry = this.current;
    const path = entry && this.addablePath(entry);
    if (!entry || !path) return;
    if (this.hooks.locked()) { this.message.textContent = 'Wait until the program has finished.'; return; }
    if (this.hooks.exists(path) && !this.hooks.confirm(`Replace ${path} in the project with this file?`)) return;
    try {
      this.hooks.add(path, entry.desc.text!);
    } catch (e) {
      this.message.textContent = (e as Error).message;
      return;
    }
    this.dialog.close();
    this.hooks.say(`Added ${path} to the project.`);
  }
}
