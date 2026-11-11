import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.*;

/** Probes common file operations; each line is "name: OK" or "name: FAIL <exception>". */
public class Main {
    interface Op { String run() throws Exception; }

    static void check(String name, Op op) {
        try {
            String r = op.run();
            System.out.println(name + ": OK" + (r == null || r.isEmpty() ? "" : " " + r));
        } catch (Throwable t) {
            System.out.println(name + ": FAIL " + t);
        }
    }

    public static void main(String[] args) {
        File dir = new File("/tmp/io");
        check("io.mkdirs", () -> String.valueOf(dir.mkdirs() || dir.isDirectory()));
        check("io.FileWriter", () -> { try (FileWriter w = new FileWriter("/tmp/io/a.txt")) { w.write("hello\ncafé €\n"); } return ""; });
        check("io.append", () -> { try (FileWriter w = new FileWriter("/tmp/io/a.txt", true)) { w.write("third\n"); } return ""; });
        check("io.BufferedReader", () -> { try (BufferedReader r = new BufferedReader(new FileReader("/tmp/io/a.txt", StandardCharsets.UTF_8))) { return r.lines().collect(Collectors.joining("|")); } });
        check("io.Scanner(File)", () -> { try (Scanner s = new Scanner(new File("/tmp/io/a.txt"), StandardCharsets.UTF_8)) { return s.nextLine(); } });
        check("io.PrintWriter", () -> { try (PrintWriter p = new PrintWriter("/tmp/io/b.txt", StandardCharsets.UTF_8)) { p.printf("%d %s%n", 42, "x"); } return ""; });
        check("io.length", () -> String.valueOf(new File("/tmp/io/b.txt").length()));
        check("io.list", () -> String.join(",", new TreeSet<>(Arrays.asList(dir.list()))));
        check("io.renameTo", () -> String.valueOf(new File("/tmp/io/b.txt").renameTo(new File("/tmp/io/c.txt"))));
        check("io.delete", () -> String.valueOf(new File("/tmp/io/c.txt").delete()));
        check("io.relative", () -> { try (FileWriter w = new FileWriter("rel.txt")) { w.write("r"); } return new File("rel.txt").getAbsolutePath(); });
        // Relative paths must land where getAbsolutePath says (process cwd = user.dir).
        check("io.relative lands in user.dir", () -> String.valueOf(new File("/root/rel.txt").exists()));

        Path n = Paths.get("/tmp/nio");
        check("nio.createDirectories", () -> Files.createDirectories(n).toString());
        check("nio.writeString", () -> Files.writeString(n.resolve("x.txt"), "één\ntwee\n").toString());
        check("nio.readString", () -> Files.readString(n.resolve("x.txt")).replace("\n", "|"));
        check("nio.readAllLines", () -> Files.readAllLines(n.resolve("x.txt")).toString());
        check("nio.lines", () -> { try (Stream<String> s = Files.lines(n.resolve("x.txt"))) { return String.valueOf(s.count()); } });
        check("nio.write APPEND", () -> Files.write(n.resolve("x.txt"), List.of("drie"), StandardOpenOption.APPEND).toString());
        check("nio.newBufferedWriter", () -> { try (BufferedWriter w = Files.newBufferedWriter(n.resolve("y.txt"))) { w.write("y"); } return ""; });
        check("nio.size", () -> String.valueOf(Files.size(n.resolve("x.txt"))));
        check("nio.exists", () -> Files.exists(n.resolve("x.txt")) + " " + Files.exists(n.resolve("nope")));
        check("nio.isDirectory", () -> String.valueOf(Files.isDirectory(n)));
        check("nio.createFile", () -> Files.createFile(n.resolve("new.txt")).toString());
        check("nio.createFile exists", () -> { try { Files.createFile(n.resolve("new.txt")); return "no exception"; } catch (FileAlreadyExistsException e) { return "FileAlreadyExistsException"; } });
        check("nio.notFound", () -> { try { Files.readString(n.resolve("missing.txt")); return "no exception"; } catch (NoSuchFileException e) { return "NoSuchFileException"; } });
        check("nio.list", () -> { try (Stream<Path> s = Files.list(n)) { return s.map(p -> p.getFileName().toString()).sorted().collect(Collectors.joining(",")); } });
        check("nio.walk", () -> { try (Stream<Path> s = Files.walk(Paths.get("/tmp"))) { return String.valueOf(s.filter(Files::isRegularFile).count()); } });
        check("nio.copy", () -> Files.copy(n.resolve("x.txt"), n.resolve("copy.txt")).toString());
        check("nio.copy REPLACE", () -> Files.copy(n.resolve("y.txt"), n.resolve("copy.txt"), StandardCopyOption.REPLACE_EXISTING).toString());
        check("nio.move", () -> Files.move(n.resolve("copy.txt"), n.resolve("moved.txt")).toString());
        check("nio.delete", () -> { Files.delete(n.resolve("moved.txt")); return String.valueOf(Files.exists(n.resolve("moved.txt"))); });
        check("nio.deleteIfExists", () -> String.valueOf(Files.deleteIfExists(n.resolve("moved.txt"))));
        check("nio.dirNotEmpty", () -> { try { Files.delete(n); return "no exception"; } catch (DirectoryNotEmptyException e) { return "DirectoryNotEmptyException"; } });
        check("nio.getLastModifiedTime", () -> Files.getLastModifiedTime(n.resolve("x.txt")).toMillis() > 0 ? "" : "zero");
        check("nio.readAttributes", () -> String.valueOf(Files.readAttributes(n.resolve("x.txt"), "size").get("size")));
        check("nio.createTempFile", () -> Files.createTempFile("t", ".txt").getParent().toString());
        check("nio.relative", () -> Files.writeString(Path.of("relnio.txt"), "r").toAbsolutePath().toString());
        check("nio.newDirectoryStream", () -> { try (DirectoryStream<Path> ds = Files.newDirectoryStream(n, "*.txt")) { List<String> l = new ArrayList<>(); for (Path p : ds) l.add(p.getFileName().toString()); Collections.sort(l); return l.toString(); } });
        check("nio.unicodeName", () -> Files.writeString(n.resolve("naïve-ü.txt"), "u").getFileName().toString());
        check("nio.copy ATTRIBUTES", () -> Files.copy(n.resolve("x.txt"), n.resolve("attrs.txt"), StandardCopyOption.COPY_ATTRIBUTES).toString());
        check("nio.move REPLACE", () -> Files.move(n.resolve("attrs.txt"), n.resolve("y.txt"), StandardCopyOption.REPLACE_EXISTING).toString());
        check("nio.listUnicode", () -> { try (Stream<Path> s = Files.list(n)) { return s.map(p -> p.getFileName().toString()).filter(f -> !f.isEmpty() && f.charAt(0) == 'n').sorted().collect(Collectors.joining(",")); } });
        check("nio.copyDirTree", () -> { Path d = Files.createDirectories(Paths.get("/tmp/tree/a/b")); Files.writeString(d.resolve("f.txt"), "f"); try (Stream<Path> s = Files.walk(Paths.get("/tmp/tree"))) { return String.valueOf(s.count()); } });
        check("nio.outsideRoot", () -> { try { Files.readString(Path.of("/etc/passwd")); return "readable"; } catch (NoSuchFileException e) { return "NoSuchFileException"; } });
    }
}
