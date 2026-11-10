export interface JavaProject {
  /** project-relative path -> source text */
  files: Record<string, string>;
  /** fully qualified, e.g. example.Main */
  mainClass: string;
  activeFile: string;
}

export type ThemeChoice = 'system' | 'light' | 'dark';

export interface UiState {
  theme: ThemeChoice;
}

export function templateProject(): JavaProject {
  return {
    files: {
      'example/Main.java': `package example;

import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        Calculator calculator = new Calculator();

        System.out.print("First number: ");
        int a = Integer.parseInt(in.nextLine().trim());
        System.out.print("Second number: ");
        int b = Integer.parseInt(in.nextLine().trim());

        System.out.println(a + " + " + b + " = " + calculator.add(a, b));
    }
}
`,
      'example/Calculator.java': `package example;

public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }
}
`,
    },
    mainClass: 'example.Main',
    activeFile: 'example/Main.java',
  };
}

/** Source for a new file at `path`, with a package declaration matching its folder. */
export function newFileSource(path: string): string {
  const parts = path.replace(/\.java$/, '').split('/');
  const name = parts.pop()!;
  const pkg = parts.join('.');
  return `${pkg ? `package ${pkg};\n\n` : ''}public class ${name} {\n\n}\n`;
}

/** Heuristic for ordering the main-class menu only; the selection itself stays explicit. */
export function looksLikeMain(source: string): boolean {
  return /\bstatic\s+(?:public\s+)?void\s+main\s*\(/.test(source) || /\bpublic\s+static\s+void\s+main\s*\(/.test(source);
}
