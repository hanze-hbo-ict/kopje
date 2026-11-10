// Diagnostic: what can be posted into the sandboxed runtime frame? Run with DIAG=1.
import { test } from '@playwright/test';
import { RUNTIME_BASE } from './runtime-path.mjs';
test('postMessage into sandboxed frame', async ({ page, browserName }) => {
  await page.goto('/');
  const r = await page.evaluate(async (src) => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts'); f.allow = 'cross-origin-isolated'; f.src = src;
    document.body.append(f);
    await new Promise((res) => f.onload = res);
    const out = {};
    const tryPost = (name, v) => { try { f.contentWindow.postMessage(v, '*'); out[name] = 'ok'; } catch (e) { out[name] = e.name + ': ' + e.message; } };
    tryPost('string', { s: 'x' });
    tryPost('arraybuffer', { b: new ArrayBuffer(16) });
    tryPost('uint8array', { b: new Uint8Array(16) });
    tryPost('fetched', { b: await (await fetch(location.origin + '/THIRD_PARTY_NOTICES.txt')).arrayBuffer() });
    tryPost('transfer', { b: new ArrayBuffer(16) });
    try { const b = new ArrayBuffer(16); f.contentWindow.postMessage({ b }, '*', [b]); out.transferList = 'ok'; } catch (e) { out.transferList = e.name; }
    return out;
  }, `${RUNTIME_BASE}/host/runtime.html`);
  console.log(browserName, JSON.stringify(r));
});
