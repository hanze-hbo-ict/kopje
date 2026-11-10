import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        System.out.print("Name? ");
        String name = in.nextLine();
        System.out.print("Age? ");
        String age = in.nextLine();
        System.out.println("Hello " + name + " (" + age + ")");
        System.out.println(in.hasNextLine() ? "more" : "EOF");
    }
}
