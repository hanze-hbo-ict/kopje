// Editor appearance. Adapted from Klode (src/editor-theme.js, MIT, © 2026 Codeklad
// contributors): semantic tag groups mapped to app tokens, no upstream hex values.
import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword, tags.operatorKeyword], color: 'var(--syntax-keyword)' },
  { tag: [tags.number, tags.atom, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.string, tags.character, tags.regexp, tags.escape], color: 'var(--syntax-string)' },
  {
    tag: [
      tags.definition(tags.variableName), tags.definition(tags.propertyName),
      tags.function(tags.definition(tags.variableName)), tags.typeName, tags.namespace,
      tags.className, tags.special(tags.variableName),
    ],
    color: 'var(--syntax-name)',
  },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment, tags.meta, tags.annotation], color: 'var(--muted)' },
  { tag: tags.invalid, color: 'var(--error)' },
]);

export const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'var(--panel)', color: 'var(--ink)', fontFamily: 'inherit' },
  '&.cm-focused': { outline: 'none' }, // the padded outer #editor supplies focus
  '.cm-scroller': { fontFamily: 'var(--mono)', overflow: 'auto', lineHeight: '1.8' },
  '.cm-content': { padding: '12px 0' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': {
    backgroundColor: 'var(--gutter)', color: 'var(--muted)', borderRight: '1px solid var(--line)',
    paddingLeft: '6px', minWidth: '36px',
  },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '& .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '.cm-matchingBracket': { outline: '1px solid var(--accent)', outlineOffset: '-1px', borderRadius: '2px' },
  '.cm-nonmatchingBracket': {
    outline: '1px solid var(--error)', outlineOffset: '-1px',
    textDecoration: 'underline wavy var(--error)', borderRadius: '2px',
  },
  '.cm-diagnosticLine': { backgroundColor: 'var(--error-bg)' },
  '@media(max-width:740px)': { '&': { fontSize: '13px' } },
});

const light = EditorView.theme({}, { dark: false });
const dark = EditorView.theme({}, { dark: true });
export const themeMode = (mode: 'light' | 'dark') => (mode === 'dark' ? dark : light);
