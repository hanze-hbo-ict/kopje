import javax.tools.*;
import java.io.*;
import java.lang.reflect.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Kopje runtime driver — a single-use replacement for JavaBox's CompileServer.
 *
 * The class keeps the name {@code CompileServer} (default package) because the native
 * entry point (runtime/native/jvm-main.c, like upstream's) calls FindClass("CompileServer").
 * The runtime host installs it as /opt/javabox/CompileServer*.class before the JVM starts
 * (docs/architecture.md ADR-1).
 *
 * Lifecycle — exactly ONE compile-and-run per JVM:
 *   1. boot, warm up javac, emit {"t":"ready"} on the control channel
 *   2. read ONE line "KOPJE_GO <main.Class>\n" from stdin. Before this line the host
 *      never forwards user input, so the line cannot originate from the user.
 *   3. compile every *.java under the source root in one JavaCompiler task (in memory)
 *   4. emit {"t":"compiled",...} with structured diagnostics; stop on failure
 *   5. run main; from here on, stdin belongs entirely to the student program
 *   6. emit {"t":"exit","code":N}; the host then destroys the whole JVM context
 *
 * Channels:
 *   stdin  — an append-only MEMFS file (default /work/stdin) the host appends to; the
 *            GO line, then student input only. Byte 0x04 = EOF (the host strips control
 *            bytes from user input, so 0x04 is unambiguous). The prebuilt runtime's fd 0
 *            ring buffer cannot be polled (available() is always 0), so it is not used.
 *   stdout (fd 1) / stderr (fd 2) — student output only.
 *   control       — a write-only device (default /dev/jectl) carrying JSON lines.
 *                   Student code could in principle reach it via reflection; the
 *                   impact is limited to spoofing its own console status (documented).
 *
 * System properties:
 *   kopje.src      source root (default /work/src)
 *   kopje.ctl      control channel path (default /dev/jectl)
 *   kopje.stdin    input file (default /work/stdin); "-" = the process's fd 0 (host tests)
 *   kopje.poll     "true" (default): wait for input by polling available(), which makes
 *                     waiting-for-input observable.
 *   kopje.warmup   "false" disables the javac warm-up compile.
 *   kopje.stackKb  stack size of the thread that runs the student's main (default 320).
 *                     In the browser, HotSpot Zero uses one native WASM call per Java call,
 *                     and the browser's worker stack (~1 MB in Chromium) is far smaller than
 *                     a JVM's. 320 KB makes the JVM throw a normal StackOverflowError (~855
 *                     frames) before Chromium/Firefox hit their native limit; HotSpot rounds
 *                     to 64 KB, and 384 KB already exceeds Chromium's limit.
 */
public class CompileServer {
    static final int MAX_FILES = 200;
    static final long MAX_TOTAL_SOURCE_CHARS = 2_000_000;

    private static PrintStream ctl;

    // ── control channel ────────────────────────────────────────────────────────

    static synchronized void emit(String json) {
        ctl.print(json);
        ctl.print('\n');
        ctl.flush();
    }

    static String q(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    // ── in-memory compiler plumbing ───────────────────────────────────────────

    /** A source file identified by its project-relative path, e.g. "example/Main.java". */
    static final class MemorySource extends SimpleJavaFileObject {
        final String path;
        final String code;
        MemorySource(String path, String code) {
            super(URI.create("mem:///src/" + encodePath(path)), Kind.SOURCE);
            this.path = path;
            this.code = code;
        }
        @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return code; }
        @Override public String getName() { return path; }
    }

    static String encodePath(String path) {
        StringBuilder b = new StringBuilder();
        for (byte by : path.getBytes(StandardCharsets.UTF_8)) {
            int c = by & 0xff;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '/' || c == '.' || c == '_' || c == '-' || c == '$') b.append((char) c);
            else b.append(String.format("%%%02X", c));
        }
        return b.toString();
    }

    static final class MemoryClassFile extends SimpleJavaFileObject {
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        MemoryClassFile(String binaryName) {
            super(URI.create("mem:///out/" + binaryName.replace('.', '/') + Kind.CLASS.extension), Kind.CLASS);
        }
        @Override public OutputStream openOutputStream() { return bytes; }
    }

    /** Captures every generated class (incl. nested/anonymous) in memory; nothing hits disk. */
    static final class MemoryFileManager extends ForwardingJavaFileManager<StandardJavaFileManager> {
        final Map<String, MemoryClassFile> outputs = new LinkedHashMap<>();
        MemoryFileManager(StandardJavaFileManager fm) { super(fm); }
        @Override
        public JavaFileObject getJavaFileForOutput(Location location, String className,
                JavaFileObject.Kind kind, FileObject sibling) {
            MemoryClassFile f = new MemoryClassFile(className);
            outputs.put(className, f);
            return f;
        }
    }

    /** Child-first for student classes; everything else delegates to the platform loader,
     *  so student code cannot resolve this driver class by name. */
    static final class StudentClassLoader extends ClassLoader {
        private final Map<String, byte[]> classes;
        StudentClassLoader(Map<String, byte[]> classes) {
            // Unnamed on purpose: a named loader prefixes stack frames with "name//".
            super(ClassLoader.getPlatformClassLoader());
            this.classes = classes;
        }
        @Override protected Class<?> findClass(String name) throws ClassNotFoundException {
            byte[] b = classes.get(name);
            if (b == null) throw new ClassNotFoundException(name);
            return defineClass(name, b, 0, b.length);
        }
    }

    // ── stdin ──────────────────────────────────────────────────────────────────

    /**
     * Student-facing System.in. Reads the raw fd 0 one byte at a time and never
     * blocks inside the native ring-buffer read while it is empty (poll mode).
     * Emits stdin-wait / stdin-resume so the host can show an input state.
     */
    static final class ConsoleInput extends InputStream {
        private final FileInputStream raw;
        private final boolean poll;
        private final boolean events;
        private boolean eof;
        ConsoleInput(FileInputStream raw, boolean poll, boolean events) { this.raw = raw; this.poll = poll; this.events = events; }

        private void awaitData() throws IOException {
            if (!poll) return;
            if (raw.available() > 0) return;
            System.out.flush();
            System.err.flush();
            if (events) emit("{\"t\":\"stdin-wait\"}");
            try {
                while (raw.available() == 0) {
                    try { Thread.sleep(10); }
                    catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new InterruptedIOException(); }
                }
            } finally {
                if (events) emit("{\"t\":\"stdin-resume\"}");
            }
        }

        @Override public synchronized int read() throws IOException {
            if (eof) return -1;
            if (!poll) { System.out.flush(); System.err.flush(); }
            awaitData();
            int c = raw.read();
            if (c < 0 || c == 0x04) { eof = true; return -1; }
            return c;
        }

        @Override public synchronized int read(byte[] b, int off, int len) throws IOException {
            Objects.checkFromIndexSize(off, len, b.length);
            if (len == 0) return 0;
            int c = read();
            if (c < 0) return -1;
            b[off] = (byte) c;
            int n = 1;
            // Drain what is already buffered without blocking again.
            while (n < len && !eof && raw.available() > 0) {
                int d = raw.read();
                if (d < 0 || d == 0x04) { eof = true; break; }
                b[off + n++] = (byte) d;
            }
            return n;
        }

        @Override public int available() throws IOException { return eof ? 0 : raw.available(); }
    }

    /** Reads the GO line byte-by-byte so nothing after it is consumed. */
    static String readControlLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (;;) {
            int c = in.read();
            if (c < 0) return b.size() == 0 ? null : b.toString(StandardCharsets.UTF_8);
            if (c == '\n') return b.toString(StandardCharsets.UTF_8);
            if (b.size() > 1024) throw new IOException("control line too long");
            b.write(c);
        }
    }

    // ── sources ────────────────────────────────────────────────────────────────

    static List<MemorySource> loadSources(File root) throws IOException {
        List<MemorySource> out = new ArrayList<>();
        long[] total = {0};
        walk(root, "", out, total);
        out.sort(Comparator.comparing(s -> s.path));
        return out;
    }

    private static void walk(File dir, String rel, List<MemorySource> out, long[] total) throws IOException {
        File[] entries = dir.listFiles();
        if (entries == null) return;
        Arrays.sort(entries);
        for (File f : entries) {
            String name = f.getName();
            String path = rel.isEmpty() ? name : rel + "/" + name;
            if (f.isDirectory()) {
                walk(f, path, out, total);
            } else if (name.endsWith(".java")) {
                if (out.size() >= MAX_FILES) throw new IOException("too many source files (max " + MAX_FILES + ")");
                byte[] data;
                try (FileInputStream in = new FileInputStream(f)) { data = in.readAllBytes(); }
                String code = new String(data, StandardCharsets.UTF_8);
                total[0] += code.length();
                if (total[0] > MAX_TOTAL_SOURCE_CHARS) throw new IOException("project too large");
                out.add(new MemorySource(path, code));
            }
        }
    }

    // ── compile ────────────────────────────────────────────────────────────────

    static final class CompileOutcome {
        boolean ok;
        Map<String, byte[]> classes = new HashMap<>();
        StringBuilder diagnosticsJson = new StringBuilder("[");
        int errors;
    }

    static CompileOutcome compile(JavaCompiler compiler, List<MemorySource> sources) throws IOException {
        CompileOutcome r = new CompileOutcome();
        DiagnosticCollector<JavaFileObject> diag = new DiagnosticCollector<>();
        StandardJavaFileManager sfm = compiler.getStandardFileManager(diag, Locale.ROOT, StandardCharsets.UTF_8);
        try (MemoryFileManager mfm = new MemoryFileManager(sfm)) {
            List<String> options = Arrays.asList("-proc:none", "-implicit:none", "-g", "-encoding", "UTF-8", "-Xlint:none");
            StringWriter compilerOut = new StringWriter();
            JavaCompiler.CompilationTask task = compiler.getTask(compilerOut, mfm, diag, options, null, sources);
            task.setLocale(Locale.ROOT);
            r.ok = Boolean.TRUE.equals(task.call());
            boolean first = true;
            for (Diagnostic<? extends JavaFileObject> d : diag.getDiagnostics()) {
                String severity;
                switch (d.getKind()) {
                    case ERROR: severity = "error"; r.errors++; break;
                    case WARNING: case MANDATORY_WARNING: severity = "warning"; break;
                    default: continue; // NOTE / OTHER
                }
                String file = d.getSource() instanceof MemorySource ? ((MemorySource) d.getSource()).path : null;
                if (!first) r.diagnosticsJson.append(',');
                first = false;
                r.diagnosticsJson.append("{\"file\":").append(q(file))
                        .append(",\"line\":").append(d.getLineNumber() > 0 ? d.getLineNumber() : 0)
                        .append(",\"column\":").append(d.getColumnNumber() > 0 ? d.getColumnNumber() : 0)
                        .append(",\"severity\":").append(q(severity))
                        .append(",\"message\":").append(q(d.getMessage(Locale.ROOT)))
                        .append('}');
            }
            r.diagnosticsJson.append(']');
            if (r.ok) {
                for (Map.Entry<String, MemoryClassFile> e : mfm.outputs.entrySet()) {
                    r.classes.put(e.getKey(), e.getValue().bytes.toByteArray());
                }
            }
        }
        return r;
    }

    static void warmup(JavaCompiler compiler) {
        try {
            compile(compiler, Collections.singletonList(new MemorySource("_W.java",
                    "class _W { public static void main(String[] a) { System.out.print(\"\"); } }")));
        } catch (Throwable t) {
            emit("{\"t\":\"log\",\"message\":" + q("warmup failed: " + t) + "}");
        }
    }

    // ── System.exit observation ─────────────────────────────────────────────────

    /**
     * In the WASM JVM, System.exit never reaches Emscripten's onExit, so the host would
     * not learn that the program ended. JDK 21's Runtime.exit logs
     * "Runtime.exit() called with status: N" to System.Logger "java.lang.Runtime" at
     * DEBUG, synchronously and before shutdown; this handler turns that into an exit
     * event. On JDKs without that logging (e.g. host JDK 17) it simply never fires.
     */
    static final class ExitHandler extends java.util.logging.Handler {
        private static final java.util.regex.Pattern STATUS = java.util.regex.Pattern.compile("status: (-?\\d+)");
        @Override public void publish(java.util.logging.LogRecord r) {
            String msg = r.getMessage();
            if (msg == null || !msg.startsWith("Runtime.exit")) return;
            java.util.regex.Matcher m = STATUS.matcher(msg);
            if (!m.find()) return;
            System.out.flush();
            System.err.flush();
            emit("{\"t\":\"exit\",\"code\":" + Integer.parseInt(m.group(1)) + ",\"via\":\"System.exit\"}");
        }
        @Override public void flush() {}
        @Override public void close() {}
    }
    private static java.util.logging.Logger runtimeLogger;   // strong ref: JUL holds loggers weakly

    static void observeSystemExit() {
        try {
            runtimeLogger = java.util.logging.Logger.getLogger("java.lang.Runtime");
            runtimeLogger.setUseParentHandlers(false);
            runtimeLogger.setLevel(java.util.logging.Level.FINE);
            runtimeLogger.addHandler(new ExitHandler());
        } catch (Throwable t) {
            emit("{\"t\":\"log\",\"message\":" + q("System.exit observer unavailable: " + t) + "}");
        }
    }

    // ── run ────────────────────────────────────────────────────────────────────

    /** Remove driver/reflection frames below the student's main so traces look like `java Main`. */
    static void trimTrace(Throwable t, Set<Throwable> seen) {
        if (t == null || !seen.add(t)) return;
        StackTraceElement[] st = t.getStackTrace();
        int end = st.length;
        for (int i = 0; i < st.length; i++) {
            String c = st[i].getClassName();
            if (c.startsWith("jdk.internal.reflect.") || c.equals("java.lang.reflect.Method")
                    || c.startsWith("CompileServer")) { end = i; break; }
        }
        if (end < st.length) t.setStackTrace(Arrays.copyOf(st, end));
        trimTrace(t.getCause(), seen);
        for (Throwable s : t.getSuppressed()) trimTrace(s, seen);
    }

    static int run(Map<String, byte[]> classes, String mainClass) {
        StudentClassLoader loader = new StudentClassLoader(classes);
        Method main;
        try {
            Class<?> cls = Class.forName(mainClass, false, loader);
            main = cls.getMethod("main", String[].class);
            int mod = main.getModifiers();
            if (!Modifier.isStatic(mod) || main.getReturnType() != void.class) throw new NoSuchMethodException();
        } catch (ClassNotFoundException | NoClassDefFoundError e) {
            emit("{\"t\":\"error\",\"kind\":\"no-main-class\",\"message\":" + q("Main class not found: " + mainClass) + "}");
            return 1;
        } catch (NoSuchMethodException e) {
            emit("{\"t\":\"error\",\"kind\":\"no-main-method\",\"message\":"
                    + q(mainClass + " has no public static void main(String[] args)") + "}");
            return 1;
        }
        emit("{\"t\":\"running\"}");
        main.setAccessible(true);
        long stackBytes = Long.getLong("kopje.stackKb", 320L) * 1024;
        int[] code = {1};
        Thread runner = new Thread(null, () -> { code[0] = invokeMain(main, mainClass); }, "main", stackBytes);
        runner.setContextClassLoader(loader);
        runner.start();
        try {
            runner.join();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return code[0];
    }

    static int invokeMain(Method main, String mainClass) {
        try {
            main.invoke(null, (Object) new String[0]);
            return 0;
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            trimTrace(cause, Collections.newSetFromMap(new IdentityHashMap<>()));
            System.out.flush();
            System.err.print("Exception in thread \"main\" ");
            cause.printStackTrace(System.err);
            return 1;
        } catch (Throwable t) {
            System.out.flush();
            System.err.println("Could not start " + mainClass + ": " + t);
            return 1;
        } finally {
            System.out.flush();
            System.err.flush();
        }
    }

    // ── main ───────────────────────────────────────────────────────────────────

    public static void main(String[] args) throws Exception {
        String ctlPath = System.getProperty("kopje.ctl", "/dev/jectl");
        ctl = new PrintStream(new FileOutputStream(ctlPath), false, StandardCharsets.UTF_8);
        String srcRoot = System.getProperty("kopje.src", "/work/src");
        boolean poll = !"false".equals(System.getProperty("kopje.poll"));

        String stdinPath = System.getProperty("kopje.stdin", "/work/stdin");
        FileInputStream rawIn = "-".equals(stdinPath) ? new FileInputStream(FileDescriptor.in) : new FileInputStream(stdinPath);

        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            emit("{\"t\":\"fatal\",\"message\":\"No Java compiler available\"}");
            System.exit(70);
        }
        if (!"false".equals(System.getProperty("kopje.warmup"))) warmup(compiler);
        emit("{\"t\":\"ready\"}");

        String go = readControlLine(new ConsoleInput(rawIn, poll, false));
        if (go == null || !go.startsWith("KOPJE_GO ")) {
            emit("{\"t\":\"fatal\",\"message\":" + q("bad control line") + "}");
            System.exit(70);
        }
        String mainClass = go.substring("KOPJE_GO ".length()).trim();
        if (!mainClass.matches("[\\p{L}_$][\\p{L}\\p{N}_$]*(\\.[\\p{L}_$][\\p{L}\\p{N}_$]*)*")) {
            emit("{\"t\":\"error\",\"kind\":\"bad-main-class\",\"message\":" + q("Invalid main class name: " + mainClass) + "}");
            emit("{\"t\":\"exit\",\"code\":1}");
            System.exit(1);
        }

        emit("{\"t\":\"compiling\"}");
        CompileOutcome outcome;
        long t0 = System.nanoTime();
        try {
            List<MemorySource> sources = loadSources(new File(srcRoot));
            if (sources.isEmpty()) {
                emit("{\"t\":\"error\",\"kind\":\"no-sources\",\"message\":\"No .java files in project\"}");
                emit("{\"t\":\"exit\",\"code\":1}");
                System.exit(1);
            }
            outcome = compile(compiler, sources);
        } catch (Throwable t) {
            // Distinct from student compile errors: javac itself failed.
            StringWriter sw = new StringWriter();
            t.printStackTrace(new PrintWriter(sw));
            emit("{\"t\":\"compiler-crash\",\"message\":" + q(sw.toString()) + "}");
            emit("{\"t\":\"exit\",\"code\":70}");
            System.exit(70);
            return;
        }
        long ms = (System.nanoTime() - t0) / 1_000_000;
        emit("{\"t\":\"compiled\",\"ok\":" + outcome.ok + ",\"ms\":" + ms + ",\"classes\":" + outcome.classes.size()
                + ",\"diagnostics\":" + outcome.diagnosticsJson + "}");
        if (!outcome.ok) {
            emit("{\"t\":\"exit\",\"code\":1}");
            System.exit(1);
        }

        System.setIn(new ConsoleInput(rawIn, poll, true));
        observeSystemExit();
        int code = run(outcome.classes, mainClass);
        emit("{\"t\":\"exit\",\"code\":" + code + "}");
        System.exit(code);
    }
}
