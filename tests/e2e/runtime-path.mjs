// The content-versioned runtime location written by scripts/prepare-runtime.mjs.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../src/runtime/runtime-location.generated.ts', import.meta.url), 'utf8');
export const RUNTIME_VERSION = /RUNTIME_VERSION = '([0-9a-f]+)'/.exec(src)[1];
export const RUNTIME_BASE = `/runtime/${RUNTIME_VERSION}`;
