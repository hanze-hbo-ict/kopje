import { EditorState, Compartment, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration,
  type DecorationSet,
} from '@codemirror/view';
import { javaLanguage } from '@codemirror/lang-java';
import { syntaxHighlighting, indentOnInput, indentUnit, bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlighting, editorTheme, themeMode } from './editor-theme.ts';

/** Marks the line of the diagnostic the user jumped to; cleared on the next edit. */
const setMarkedLine = StateEffect.define<number | null>();
const markedLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setMarkedLine)) {
        if (e.value === null) return Decoration.none;
        const line = tr.state.doc.line(e.value);
        return Decoration.set([Decoration.line({ class: 'cm-diagnosticLine' }).range(line.from)]);
      }
    }
    return tr.docChanged ? Decoration.none : deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * One EditorView; one EditorState per file so undo history and selection survive
 * switching files. No completion (same policy as Klode).
 */
export class JavaEditor {
  private readonly view: EditorView;
  private readonly states = new Map<string, EditorState>();
  private readonly appearance = new Compartment();
  private mode: 'light' | 'dark' = 'light';
  private current = '';

  private readonly onChange: (path: string, text: string) => void;

  constructor(parent: HTMLElement, onChange: (path: string, text: string) => void) {
    this.onChange = onChange;
    // Mounted in an open shadow root so CodeMirror's styles use constructed stylesheets
    // instead of <style> elements, which the CSP (style-src 'self') blocks. App tokens
    // (CSS custom properties) inherit through the shadow boundary.
    const root = parent.shadowRoot ?? parent.attachShadow({ mode: 'open' });
    this.view = new EditorView({
      parent: root,
      root,
      dispatch: (tr) => {
        this.view.update([tr]);
        if (tr.docChanged) this.onChange(this.current, this.view.state.doc.toString());
      },
    });
  }

  private extensions(path: string): Extension[] {
    return [
      editorTheme,
      this.appearance.of(themeMode(this.mode)),
      javaLanguage,
      syntaxHighlighting(highlighting),
      indentOnInput(),
      indentUnit.of('    '),
      closeBrackets(),
      bracketMatching(),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      markedLine,
      keymap.of([indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({
        'aria-label': `${path} Java source`,
        spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off',
      }),
    ];
  }

  /** Show `path`. If `text` differs from the cached state (e.g. after restore), the cache is replaced. */
  open(path: string, text: string) {
    if (this.current) this.states.set(this.current, this.view.state);
    let state = this.states.get(path);
    if (!state || state.doc.toString() !== text) {
      state = EditorState.create({ doc: text, extensions: this.extensions(path) });
    } else {
      // Theme may have changed while this file was in the background.
      state = state.update({ effects: this.appearance.reconfigure(themeMode(this.mode)) }).state;
    }
    this.current = path;
    this.view.setState(state);
  }

  rename(from: string, to: string) {
    const st = from === this.current ? this.view.state : this.states.get(from);
    this.states.delete(from);
    if (!st) return;
    // aria-label is part of the extensions: rebuild with the same doc and selection.
    const next = EditorState.create({ doc: st.doc, selection: st.selection, extensions: this.extensions(to) });
    if (from === this.current) { this.current = to; this.view.setState(next); } else this.states.set(to, next);
  }

  forget(path: string) { this.states.delete(path); }

  get path() { return this.current; }
  focus() { this.view.focus(); }

  /** Place the cursor at a 1-based line/column and highlight that line. */
  goTo(line: number, column = 1) {
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    const pos = Math.min(l.from + Math.max(0, column - 1), l.to);
    this.view.dispatch({
      selection: { anchor: pos },
      effects: [EditorView.scrollIntoView(pos, { y: 'center' }), setMarkedLine.of(l.number)],
    });
    this.view.focus();
  }

  setTheme(mode: 'light' | 'dark') {
    this.mode = mode;
    this.view.dispatch({ effects: this.appearance.reconfigure(themeMode(mode)) });
  }
}
