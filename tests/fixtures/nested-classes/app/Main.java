package app;

import app.model.Shape;
import java.util.function.Supplier;

public class Main {
    static class Inner { String hi() { return "inner"; } }
    public static void main(String[] args) {
        Supplier<String> anon = new Supplier<>() { public String get() { return "anon"; } };
        Runnable lambda = () -> System.out.println("lambda");
        System.out.println(new Inner().hi() + " " + anon.get() + " " + Shape.Kind.CIRCLE + " " + new Shape.Circle(2).area());
        lambda.run();
    }
}
