export interface JavaProject {
  /** project-relative path -> source text */
  files: Record<string, string>;
  /** fully qualified, e.g. example.Main */
  mainClass: string;
  activeFile: string;
  /** Program arguments as typed on the console's command line (see args.ts). */
  args: string;
  /** Files of the last full import (Import → Replace); Reset goes back to these. Absent: the template. */
  baseline?: Record<string, string>;
}

export type ThemeChoice = 'system' | 'light' | 'dark';

export interface UiState {
  theme: ThemeChoice;
}

/** A new project: one empty-ish file, no main method yet (Run then names the class Main). */
export function templateProject(): JavaProject {
  return {
    files: { 'Main.java': '// Write your Java code here\n' },
    mainClass: '',
    activeFile: 'Main.java',
    args: '',
  };
}
