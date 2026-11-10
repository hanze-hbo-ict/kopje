# javaedit

A browser-only Java IDE for small multi-file assignments: Klode's look and interaction, with
packages, several files, interactive `Scanner` input and a reliable Stop. Java runs in a
WebAssembly OpenJDK 21 (via [JavaBox](https://github.com/bmarti44/javabox)) that is compiled
and destroyed per run. No backend, no accounts, nothing stored outside the tab.

See `PLAN.md` for scope and `docs/` for design and evidence:

| Doc | Contents |
|---|---|
| `docs/architecture.md` | topology, ADRs, deviation log |
| `docs/baseline.md` | upstream recon, measurements, test results |
| `docs/capability-matrix.md` | what student code can and cannot do, with tests |
| `docs/limitations.md` | known gaps |
| `docs/runtime-build.md` | reproducible source build of the runtime |
| `docs/klode-ui-reference.md` | UI reference and Java adaptations |
| `docs/licensing.md` | licence audit and distribution plan |

## Quick start

```sh
git submodule update --init --recursive
npm install
scripts/build-runtime-source.sh --modules minimal   # ~4 min; needs emcc, autotools, GNU grep
npm run build                                       # -> dist/
npm run serve                                       # http://127.0.0.1:5391/
```

The page must be served with the headers in `security-headers.mjs`: COOP/COEP for
`SharedArrayBuffer`, plus the CSP and framing headers. `scripts/serve.mjs` and `vite preview`
apply them, and the build writes `dist/_headers` for Netlify/Cloudflare-style hosts. Any
static host that can set those headers works; `dist/` is the whole deployment. Production
builds contain no test pages; `npm run build:test` adds `slice.html` for the e2e suite.

## Tests

```sh
npm test                               # unit (paths) + driver on a host JDK 17+
npx playwright install                 # once
npm run test:e2e                       # test build + Gate 2 slice, Gate 4 IDE, security, probes; 3 browsers
```

## Layout

```
index.html, src/          IDE (Vite + TypeScript + CodeMirror 6)
  project/                model, ProjectManager, sessionStorage adapter, path rules
  editor/ console/ ui/    CodeMirror wrapper, console transcript, file list, theme
  runtime/                JavaEngine API, JavaBoxEngine (disposable iframe per run), protocol
public/runtime/host/      runtime iframe (boots JavaBox, bridges stdin/stdout/stderr/control)
runtime/java/             single-use JVM driver (multi-file javac, run, stdin, exit)
slice.html                minimal engine test page
scripts/                  runtime source build, prepare-runtime, static server
tests/                    unit, host (driver on local JDK), e2e (Playwright), fixtures
vendor/javabox            upstream, pinned submodule
```

Development with `npm run dev` works for UI changes, but the Vite dev server serves the
runtime very slowly. Use the production build for runtime work.
