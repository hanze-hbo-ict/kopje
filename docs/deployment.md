# Deployment checklist

`dist/` is the whole deployment: a static site with no backend. These steps cover PLAN.md
§13 S5/S8 and §14 (exam use).

## Hosting requirements

Recommended: **Cloudflare Pages** (free tier: unlimited bandwidth; it applies `dist/_headers`).
Its limits that matter: 25 MiB per file (the largest file is the ~10 MB `javabox-direct.data.gz`;
`verify:dist` enforces the limit) and 20,000 files per site. GitHub Pages cannot set response
headers, so Java cannot start there.

- [ ] **Own HTTPS origin** (dedicated host or subdomain, e.g. `java.example.org`). Don't
  share an origin with other apps: anything that ever ran script on this origin could reach
  their cookies and storage (S5). The IDE sets no cookies; keep it that way.
- [ ] The host applies **`dist/_headers`** (Netlify, Cloudflare Pages) or equivalent rules
  from `security-headers.mjs`:
  - every response: COOP `same-origin`, COEP `require-corp`, the CSP,
    `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
    `Permissions-Policy`
  - `/assets/*`, `/runtime/*`: `Cache-Control: public, max-age=31536000, immutable`
  - `/runtime/*` additionally: `Cross-Origin-Resource-Policy: cross-origin`,
    `Access-Control-Allow-Origin: *` and a second CSP `connect-src 'none'` (the sandboxed
    runtime frame has an opaque origin; ADR-10); `/`, `/index.html`, `/assets/*`:
    `Cross-Origin-Resource-Policy: same-origin`
  - `/`, `/index.html`: `Cache-Control: no-cache`
  Without COOP/COEP, Java can't start (no `SharedArrayBuffer`).
- [ ] MIME types: `.wasm` `application/wasm`, `.mjs`/`.js` JavaScript, `.gz` served as-is
  (**no** `Content-Encoding: gzip`; the runtime decompresses these files itself).
- [ ] For exams: put the origin on the exam network's whitelist. All requests go to this one
  origin; nothing loads from a CDN.

## Build and deploy with GitHub Actions

`.github/workflows/deploy.yml` does everything below on an Ubuntu runner, cross-linking the
macOS class library (ADR-8, docs/runtime-build.md), with Emscripten pinned through emsdk, and deploys `dist/` with
Wrangler on every push to `main`. The built runtime is cached on its inputs (JavaBox commit,
build scripts, `runtime/native/`, emsdk version), so only a runtime change rebuilds it.

Setup, once:
1. Create a Cloudflare Pages project (Direct Upload) named `kopje`, or set the repository
   variable `CLOUDFLARE_PAGES_PROJECT`. Production branch: `main`. Give it its own custom domain.
2. Add repository secrets `CLOUDFLARE_API_TOKEN` (permission *Cloudflare Pages: Edit*) and
   `CLOUDFLARE_ACCOUNT_ID`. Without them the workflow builds and uploads `dist` as an artifact
   only.
3. CI's Emscripten (emsdk) is a different build from Homebrew's, so its `.wasm` (and the
   `.mjs`) may not match a `runtime.lock.json` made locally; the `.data` (class library)
   should. Run the workflow manually with **update lock**; it
   uploads the new `runtime.lock.json` as an artifact without deploying. Review and commit it.
   Do the same after any deliberate runtime change.
   The lock then pins **CI's** build, which is the one that deploys. A runtime built locally
   (Homebrew emcc, different build paths) gets a different `.wasm`/`.mjs` and no longer passes
   `verify:dist`; its `.data` (class library) should still match. Deploy through CI.

## Build and verify locally

```sh
git submodule update --init --recursive
npm ci
scripts/build-runtime-source.sh --modules minimal     # see docs/runtime-build.md
npm run build                                         # production: no test pages
npm run verify:dist                                   # must print "verify: OK"
```

`verify:dist` fails when:
- an npm dependency is not pinned exactly, or the lockfile is missing (S8);
- `dist/_headers` lacks the security or cache headers;
- `dist/slice.html` (test page) is present (S6);
- a runtime file differs from its recorded SHA-256 (`runtime.json`);
- the runtime is not a Kopje source build: the upstream prebuilt contains GPL Doom code
  and must never be deployed;
- a raw `.wasm`/`.data` is shipped, a `.gz` does not decompress to the recorded content, or a
  runtime file exceeds 25 MiB (Cloudflare Pages' limit);
- the runtime differs from **`runtime.lock.json`** (pinned on the uncompressed content). After a deliberate runtime change
  (new JavaBox pin, module set, JVM options), review the diff and update the lock with
  `node scripts/verify.mjs dist --lock`, then commit it.

Run the tests before a release:

```sh
npm test                      # unit + driver on a host JDK
npm run test:e2e              # test build + all e2e suites in Chromium, Firefox, WebKit
```

## After deploying

- [ ] Headers on the live site (replace the host):
  ```sh
  curl -sI https://java.example.org/ | grep -iE 'cross-origin|content-security|cache-control|x-frame'
  V=$(grep -o "runtime/[0-9a-f]*" dist/assets/index-*.js | head -1)
  curl -sI "https://java.example.org/$V/javabox/javabox-direct.data.gz" | grep -iE 'cache-control|content-type|content-encoding'
  ```
  Expect COOP/COEP and the CSP everywhere, `immutable` on the runtime file, `no-cache` on `/`,
  and no `Content-Encoding` on `.gz` files.
- [ ] Open the site, run the example project (two inputs), press Stop during input, run again.
- [ ] Copy all → paste into the target platform (e.g. ans.app) and check the text is exact.
- [ ] Record the deployed commit, `runtime.lock.json` and the date.

## Updating JavaBox

1. Bump the `vendor/javabox` submodule to the new commit.
2. Diff upstream `build/jvm-main.c` against `runtime/native/jvm-main.c`, and upstream
   `build/link-direct-wasm.sh` against the link step in `scripts/build-runtime-source.sh`;
   port relevant changes.
3. Check the OpenJDK update version (`make/conf/version-numbers.conf`) and adjust the
   Temurin version and checksum in `scripts/build-runtime-source.sh` to match.
4. Rebuild, run all tests, `npm run verify:dist`, update `runtime.lock.json` deliberately.
