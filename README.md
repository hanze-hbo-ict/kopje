# javaedit

Browser-only Java IDE for small multi-file assignments, on a hardened
[JavaBox](https://github.com/bmarti44/javabox) runtime. See `PLAN.md` for scope and phases.

**Status:** Phase 0 recon done, Phase 1 driver done and host-tested, and the Phase 2 runtime slice written.
The WASM runtime has not yet been exercised end-to-end (see `docs/baseline.md`).

## Layout

```
runtime/java/CompileServer.java  single-use JVM driver (multi-file compile, run, stdin, control channel)
runtime/host/                    disposable runtime iframe (boots JavaBox, bridges I/O)
runtime/engine/                  parent-side JavaEngine (run/stop/sendInput, timeouts, prewarm)
runtime/slice.html               Gate 2 test page
tests/fixtures/                  Java fixtures;  tests/unit, tests/host, tests/e2e
vendor/javabox                   upstream, pinned submodule
docs/                            baseline, architecture (ADRs + deviations), capability matrix, licensing
```

## Develop

```sh
git submodule update --init --recursive
mkdir -p runtime-prebuilt && for f in javabox-direct.mjs javabox-direct.wasm javabox-direct.data; do
  curl -fsSL -o runtime-prebuilt/$f https://javabox-demo.brian-fec.workers.dev/$f; done   # ~79 MB, dev only
npm test                      # unit + driver tests on a host JDK 17+
npm run build:runtime         # -> dist/
npm run serve                 # http://localhost:5173/slice.html  (COOP/COEP set)
npm i -D @playwright/test && npx playwright install && npm run test:e2e
```

The prebuilt runtime contains Doom assets and must not be redistributed by us; see `docs/licensing.md`.
