// The former starter project (two files in package example, reading two numbers), kept as a
// fixture for tests that need a runnable multi-file project with input.
export function exampleProject() {
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

/** Start the page with the example project, as if the tab had been reloaded with it. */
export async function useExampleProject(page) {
  await page.addInitScript((project) => {
    const key = 'kopje:session:v1';
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({ v: 1, project, ui: { theme: 'system' } }));
  }, exampleProject());
}
