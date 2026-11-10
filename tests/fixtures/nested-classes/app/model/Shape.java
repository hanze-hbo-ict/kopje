package app.model;

public interface Shape {
    enum Kind { CIRCLE, SQUARE }
    double area();
    record Circle(double r) implements Shape {
        public double area() { return Math.round(Math.PI * r * r * 100) / 100.0; }
    }
}
