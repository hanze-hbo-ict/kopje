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
    args: '',
  };
}

