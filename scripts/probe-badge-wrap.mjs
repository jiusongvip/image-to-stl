#!/usr/bin/env node
/**
 * Attributing the hero badge-row shift.
 *
 * The CLS probe reports a shift of 0.0093-0.0208 on the homepage, concentrated
 * on `.mt-9.flex.flex-wrap.gap-2` (the four hero badges) whose height oscillates
 * 56 -> 82 -> 66. Two shifts in OPPOSITE directions is not the signature of a
 * font swap (which happens once, when the face arrives).
 *
 * This script answers the question directly:
 *   - when did each font actually finish loading?
 *   - what was the badge row's height at those moments?
 *   - does the badge row wrap differently before/after `document.fonts.ready`?
 *
 * Usage: node scripts/probe-badge-wrap.mjs <indexUrl>
 */
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/probe-badge-wrap.mjs <indexUrl>");
  process.exit(2);
}

const PORT = 9271;
const PROFILE = `D:/tmp/badge-probe-${randomBytes(4).toString("hex")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const c = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
  ];
  for (const p of c) if (p && existsSync(p)) return p;
  throw new Error("找不到 Chrome");
}

async function waitForCdp(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    if (Date.now() > deadline) throw new Error("CDP 未就绪");
    await sleep(200);
  }
}

/** Minimal RFC6455 client — Node's built-in WebSocket cannot complete Chrome's handshake here. */
class RawWs {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = Number(u.port || 80);
    this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.id = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      this.sock = net.connect(this.port, this.host, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this.sock.on("error", reject);
      let handshakeDone = false;
      this.sock.on("data", (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!handshakeDone) {
          const i = this.buf.indexOf("\r\n\r\n");
          if (i === -1) return;
          handshakeDone = true;
          this.buf = this.buf.subarray(i + 4);
          resolve();
        }
        this.drain();
      });
    });
  }
  drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      try {
        const msg = JSON.parse(payload.toString("utf8"));
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
      } catch {}
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    const body = Buffer.from(JSON.stringify({ id, method, params }));
    const mask = randomBytes(4);
    let header;
    if (body.length < 126) {
      header = Buffer.alloc(6);
      header[1] = 0x80 | body.length;
      mask.copy(header, 2);
    } else {
      header = Buffer.alloc(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
      mask.copy(header, 4);
    }
    const masked = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([Buffer.from([0x81]), header.subarray(1), masked]));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 60000);
    });
  }
  close() {
    try {
      this.sock?.destroy();
    } catch {}
  }
}

const INSTRUMENT = `
(() => {
  window.__b = { samples: [], fonts: [], shifts: [] };

  const badge = () => document.querySelector('.mt-9.flex.flex-wrap.gap-2');

  // Line boxes of the hero paragraph. Range.getClientRects() returns one rect per
  // line box, so this is the true line count — not an inference from height.
  const paraLines = () => {
    const p = document.querySelector('main section.relative p.mt-6');
    if (!p) return null;
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let n = null;
    while ((n = w.nextNode())) if (n.textContent.trim()) break;
    if (!n) return null;
    const r = document.createRange();
    r.selectNodeContents(n);
    const rects = [...r.getClientRects()];
    return { lines: rects.length, widths: rects.map((o) => Math.round(o.width)) };
  };

  const snap = (label) => {
    const b = badge();
    const pl = paraLines();
    if (!b) { window.__b.samples.push({ t: Math.round(performance.now()), label, missing: true }); return; }
    const r = b.getBoundingClientRect();
    const kids = [...b.children].map((c) => Math.round(c.getBoundingClientRect().width));
    window.__b.samples.push({
      t: Math.round(performance.now()), label,
      h: Math.round(r.height), w: Math.round(r.width), kidWidths: kids,
      rows: new Set([...b.children].map((c) => Math.round(c.getBoundingClientRect().top))).size,
      paraLines: pl ? pl.lines : null,
      paraWidths: pl ? pl.widths : null,
      fontsReady: document.fonts ? document.fonts.status : 'n/a',
    });
  };

  snap('sync');

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__b.shifts.push({
          t: Math.round(e.startTime), v: e.value,
          src: (e.sources || []).map((s) => ({
            tag: s.node ? s.node.tagName : null,
            cls: s.node ? String(s.node.className).slice(0, 60) : null,
            pTop: s.previousRect ? Math.round(s.previousRect.top) : null,
            cTop: s.currentRect ? Math.round(s.currentRect.top) : null,
            pH: s.previousRect ? Math.round(s.previousRect.height) : null,
            cH: s.currentRect ? Math.round(s.currentRect.height) : null,
          })),
        });
        snap('after-shift');
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { window.__b.e1 = String(e); }

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        const n = e.name.split('/').pop();
        if (/woff2?\$/.test(n)) window.__b.fonts.push({ end: Math.round(e.responseEnd), name: n });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { window.__b.e2 = String(e); }

  // Sample across the load, and once fonts are ready.
  let n = 0;
  const iv = setInterval(() => { snap('t+' + (n++ * 250)); if (n > 24) clearInterval(iv); }, 250);
  if (document.fonts) {
    document.fonts.ready.then(() => snap('fonts-ready'));
    ['400 16px Geist', '700 16px Geist', '400 16px "Geist Mono"', '400 16px "Geist Fallback"']
      .forEach((f) => { try { document.fonts.load(f).then(() => snap('loaded ' + f)); } catch {} });
  }
})();
`;

const chrome = findChrome();
const child = spawn(chrome, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--window-size=412,823",
  "about:blank",
], { stdio: "ignore" });

try {
  const page = await waitForCdp(PORT);
  const ws = new RawWs(page.webSocketDebuggerUrl);
  await ws.connect();
  await ws.send("Page.enable");
  await ws.send("Runtime.enable");
  await ws.send("Emulation.setDeviceMetricsOverride", {
    width: 412, height: 823, deviceScaleFactor: 2, mobile: true,
  });

  // 4x CPU throttle + slow network: the condition under which PSI sees this.
  await ws.send("Network.enable");
  await ws.send("Network.emulateNetworkConditions", {
    offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8,
  });
  await ws.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  await ws.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  await ws.send("Page.navigate", { url });
  await sleep(9000);

  const r = await ws.send("Runtime.evaluate", {
    expression: "JSON.stringify(window.__b)", returnByValue: true,
  });
  const data = JSON.parse(r.result.value);

  console.log("=== 字体完成加载 ===");
  for (const f of data.fonts) console.log(`  ${String(f.end).padStart(6)}ms  ${f.name}`);

  console.log("\n=== badge 行几何随时间 ===");
  for (const s of data.samples) {
    if (s.missing) { console.log(`  ${String(s.t).padStart(6)}ms  ${s.label}  <缺失>`); continue; }
    console.log(
      `  ${String(s.t).padStart(6)}ms  ${s.label.padEnd(22)} h=${String(s.h).padStart(3)} ` +
      `rows=${s.rows}  kidW=[${s.kidWidths.join(", ")}]`,
    );
    // The paragraphs line count is the whole question: a 182->156 change is a
    // lost line at leading-relaxed, so print the real line count and each
    // line's measured width, not just the block height.
    if (s.paraLines != null) {
      console.log(
        `             hero <p> lines=${s.paraLines}  widths=[${s.paraWidths.join(", ")}]  ` +
        `fonts=${s.fontsReady}`,
      );
    }
  }

  console.log("\n=== layout-shift ===");
  for (const s of data.shifts) {
    console.log(`  t=${s.t}ms  v=${s.v.toFixed(4)}`);
    for (const x of s.src) {
      console.log(`     ${(x.tag || "?").padEnd(5)} ${String(x.cls).slice(0, 46).padEnd(46)} top ${x.pTop}->${x.cTop}  h ${x.pH}->${x.cH}`);
    }
  }

  ws.close();
} finally {
  child.kill();
  await sleep(500);
  try { execFileSync("rm", ["-rf", PROFILE]); } catch {}
}
