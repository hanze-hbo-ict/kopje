# Deployment checklist

`dist/` is the whole deployment: a static site with no backend. These steps cover PLAN.md
§13 S5/S8 and §14 (exam use).

## Hosting requirements

- [ ] **Own HTTPS origin** (dedicated host or subdomain, e.g. `java.example.org`). Don't
  share an origin with other apps: anything that ever ran script on this origin could reach
  their cookies and storage (S5). The IDE sets no cookies; keep it that way.
- [ ] The host applies **`dist/_headers`** (Netlify, Cloudflare Pages) or equivalent rules
  from `security-headers.mjs`:
  - every response: COOP `same-origin`, COEP `require-corp`, CORP `same-origin`, the CSP,
    `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
    `Permissions-Policy`
  - `/assets/*`, `/runtime/*`: `Cache-Control: public, max-age=31536000, immutable`
  - `/`, `/index.html`: `Cache-Control: no-cache`
  Without COOP/COEP, Java can't start (no `SharedArrayBuffer`).
- [ ] MIME types: `.wasm` `application/wasm`, `.mjs`/`.js` JavaScript, `.gz` served as-is
  (**no** `Content-Encoding: gzip`; the runtime decompresses these files itself).
- [ ] For exams: put the origin on the exam network's whitelist. All requests go to this one
  origin; nothing loads from a CDN.

## Build and verify

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
- the runtime is not a javaedit source build: the upstream prebuilt contains GPL Doom code
  and must never be deployed;
- the runtime differs from **`runtime.lock.json`**. After a deliberate runtime change
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
