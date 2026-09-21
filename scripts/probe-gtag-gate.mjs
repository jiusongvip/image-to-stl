/**
 * Verify the gtag loader is interaction-only.
 *
 * Two assertions, both measured in a real Chrome via CDP:
 *   A. NEGATIVE: after `load` + several seconds of quiet idle, ZERO requests to
 *      googletagmanager.com may have been issued. This is the one that fails on
 *      the old build (which armed on load -> requestIdleCallback).
 *   B. POSITIVE: after a synthetic user gesture, the request MUST appear. Without
 *      this, assertion A would also pass on a page where gtag was simply broken.
 *
 * B is the negative control for A: it proves the tag would load if asked.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const URL_ = process.argv[2] || 'http://127.0.0.1:8099/';
const QUIET_MS = Number(process.argv[3] || 6000);

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--user-data-dir=' + process.env.TEMP + '\\gtag-gate-profile',
  'about:blank',
], { stdio: 'ignore' });

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      return await r.json();
    } catch { await sleep(250); }
  }
  throw new Error('Chrome did not expose CDP');
}

// ---- minimal RFC6455 client (Node's global WebSocket cannot complete Chrome's handshake here)
import net from 'node:net';
import crypto from 'node:crypto';

class WS {
  constructor(wsUrl) {
    const u = new URL(wsUrl);
    this.host = u.hostname; this.port = +u.port; this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0); this.waiters = new Map(); this.id = 0; this.handlers = new Map();
  }
  connect() {
    return new Promise((res, rej) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(this.port, this.host, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      this.sock.on('error', rej);
      let handshakeDone = false;
      this.sock.on('data', (d) => {
        if (!handshakeDone) {
          const s = d.toString('latin1');
          if (s.includes('\r\n\r\n')) {
            handshakeDone = true;
            const rest = Buffer.from(s.slice(s.indexOf('\r\n\r\n') + 4), 'latin1');
            if (rest.length) this.feed(rest);
            res();
          }
          return;
        }
        this.feed(d);
      });
    });
  }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if ((b0 & 0x0f) === 1) {
        let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (msg.id && this.waiters.has(msg.id)) { this.waiters.get(msg.id)(msg); this.waiters.delete(msg.id); }
        if (msg.method && this.handlers.has(msg.method)) this.handlers.get(msg.method)(msg.params);
      }
    }
  }
  send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4);
    let head;
    if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
    else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  on(method, fn) { this.handlers.set(method, fn); }
  call(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.waiters.set(id, res); this.send({ id, method, params }); });
  }
  close() { try { this.sock.destroy(); } catch {} }
}

try {
  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();

  const hits = [];
  ws.on('Network.requestWillBeSent', (p) => {
    if (/googletagmanager\.com|google-analytics\.com/.test(p.request.url)) hits.push({ url: p.request.url, t: Date.now() });
  });

  await ws.call('Network.enable');
  await ws.call('Page.enable');
  await ws.call('Runtime.enable');

  const t0 = Date.now();
  await ws.call('Page.navigate', { url: URL_ });
  await sleep(QUIET_MS);

  const before = hits.length;
  console.log(`\n=== A. NEGATIVE: ${QUIET_MS} ms after load, no interaction ===`);
  console.log(`   gtag/GA requests: ${before}  ${before === 0 ? '✓ (gate holds)' : '✗ GATE LEAKED'}`);
  hits.forEach((h) => console.log('     ', h.url));

  // ---- B. synthetic gesture: dispatch on the page, must open the gate
  await ws.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 200, button: 'left', clickCount: 1 });
  await ws.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 200, button: 'left', clickCount: 1 });
  await sleep(4000);

  const after = hits.length;
  console.log(`\n=== B. POSITIVE CONTROL: after a real pointerdown ===`);
  console.log(`   gtag/GA requests: ${after}  ${after > before ? '✓ (gate opens)' : '✗ GATE STUCK'}`);
  hits.slice(before).forEach((h) => console.log('     ', h.url));

  const pass = before === 0 && after > before;
  console.log(`\nRESULT: ${pass ? 'PASS' : 'FAIL'}\n`);
  process.exitCode = pass ? 0 : 1;
  ws.close();
} finally {
  chrome.kill();
}
