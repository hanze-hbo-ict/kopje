// Capability probes (plan §6.2 / §9). Records behaviour; asserts only "no egress" and "IDE survives".
import { test, expect } from '@playwright/test';

const PROBES = {
  socket: 'new java.net.Socket("127.0.0.1", 5391).close(); System.out.println("CONNECTED");',
  http: 'var c = (java.net.HttpURLConnection) new java.net.URL("http://127.0.0.1:5391/slice.html").openConnection(); System.out.println("HTTP " + c.getResponseCode());',
  dns: 'System.out.println("DNS " + java.net.InetAddress.getByName("example.com"));',
  fileOutside: 'System.out.println("READ " + new String(java.nio.file.Files.readAllBytes(java.nio.file.Path.of("/etc/passwd"))));',
  fileTraversal: 'System.out.println("READ " + new java.io.File("/work/src/../../opt/jdk/release").exists() + " " + java.util.Arrays.toString(new java.io.File("/").list()));',
  fileWrite: 'java.nio.file.Files.writeString(java.nio.file.Path.of("/tmp/x.txt"), "hi"); System.out.println("WROTE " + java.nio.file.Files.readString(java.nio.file.Path.of("/tmp/x.txt")));',
  process: 'Process p = new ProcessBuilder("ls").start(); System.out.println("PROC " + p.waitFor());',
  exec: 'Runtime.getRuntime().exec(new String[]{"sh","-c","id"}); System.out.println("EXEC");',
  loadLibrary: 'System.loadLibrary("evil"); System.out.println("LOADED");',
  load: 'System.load("/tmp/evil.so"); System.out.println("LOADED");',
};

for (const [name, body] of Object.entries(PROBES)) {
  test(`capability: ${name}`, async ({ page }) => {
    const sockets = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto('/slice.html');
    await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 60_000 });
    const before = requests.length;
    const src = `public class Main { public static void main(String[] a) throws Exception { ${body} } }`;
    const res = await page.evaluate((src) => new Promise((resolve) => {
      const ev = [];
      const timer = setTimeout(() => { window.engine.stop(); }, 30_000);
      window.engine.run({ 'Main.java': src }, 'Main', (e) => ev.push(e)).then((r) => {
        clearTimeout(timer);
        const pick = (k) => ev.filter((e) => e.kind === k).map((e) => e.text).join('');
        resolve({ result: r, stdout: pick('stdout'), stderr: pick('stderr').split('\n').slice(0, 3).join(' | '),
                  errors: ev.filter((e) => e.kind === 'error').map((e) => e.errorKind + ': ' + String(e.message).slice(0, 160)) });
      });
    }), src);
    const egress = requests.slice(before).filter((u) => !u.includes('/host/') && !u.endsWith('/slice.html'));
    console.log(JSON.stringify({ probe: name, ...res, websockets: sockets, otherRequests: egress }));
    expect(sockets, 'no WebSocket egress').toEqual([]);
    expect(await page.evaluate(() => 1 + 1)).toBe(2);   // IDE page still responsive
  });
}
