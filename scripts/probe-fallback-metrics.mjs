#!/usr/bin/env node
/**
 * Does the "Geist Fallback" face actually change text metrics?
 *
 * The homepage hero badge row re-wraps under 4x CPU throttle (Geist arrives at
 * ~6.2s, well after first paint). If the metric-override fallback faces work,
 * text measured in "Geist Fallback" should match text measured in "Geist"
 * almost exactly, and both should differ from raw system-ui.
 *
 * If geistFallback === systemOnly, the face is not being applied at all.
 * If geistFallback ≈ geist, the override is doing its job.
 *
 * Usage: node scripts/probe-fallback-metrics.mjs <indexUrl>
 */
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/probe-fallback-metrics.mjs <indexUrl>");
  process.exit(2);
}

const PORT = 9277;
const PROFILE = `D:/tmp/fallback-probe-${randomBytes(3).toString("hex")}`;
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

/** Minimal RFC6455 client — Node's WebSocket cannot complete Chrome's handshake here. */
class RawWs {
  constructor(u) {
    const a = new URL(u);
    this.host = a.hostname;
    this.port = Number(a.port || 80);
    this.path = a.pathname + a.search;
    this.buf = Buffer.alloc(0);
    this.id = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((res, rej) => {
      const key = randomBytes(16).toString("base64");
      this.sock = net.connect(this.port, this.host, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this.sock.on("error", rej);
      let done = false;
      this.sock.on("data", (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!done) {
          const i = this.buf.indexOf("\r\n\r\n");
          if (i === -1) return;
          done = true;
          this.buf = this.buf.subarray(i + 4);
          res();
        }
        this.drain();
      });
    });
  }
  drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      let len = this.buf[1] & 0x7f;
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
      const p = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      try {
        const m = JSON.parse(p.toString());
        if (m.id && this.pending.has(m.id)) {
          const { resolve, reject } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        }
      } catch {}
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    const body = Buffer.from(JSON.stringify({ id, method, params }));
    const mask = randomBytes(4);
    let h;
    if (body.length < 126) {
      h = Buffer.alloc(6);
      h[1] = 0x80 | body.length;
      mask.copy(h, 2);
    } else {
      h = Buffer.alloc(8);
      h[1] = 0x80 | 126;
      h.writeUInt16BE(body.length, 2);
      mask.copy(h, 4);
    }
    const m = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i++) m[i] = body[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([Buffer.from([0x81]), h.subarray(1), m]));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(method + " 超时"));
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

const MEASURE = `(() => {
  const mk = (fam, weight) => {
    const s = document.createElement('span');
    s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:16px;font-family:' + fam + ';font-weight:' + (weight||400);
    s.textContent = '100% Browser-Free \\u2014 No Uploads';
    document.body.appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return Math.round(w * 100) / 100;
  };
  const faces = [];
  if (document.fonts) for (const f of document.fonts) faces.push(f.family + ' w' + f.weight + ' ' + f.status);
  return JSON.stringify({
    geist400: mk('Geist'),
    geistStack400: mk('Geist,"Geist Fallback",system-ui,sans-serif'),
    geistFallback400: mk('"Geist Fallback"'),
    sys400: mk('system-ui'),
    geist700: mk('Geist', 700),
    geistFallback700: mk('"Geist Fallback"', 700),
    sys700: mk('system-ui', 700),
    faces,
  });
})()`;

const child = spawn(
  findChrome(),
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--headless=new",
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  let page;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const l = await r.json();
      page = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(250);
  }
  if (!page) throw new Error("CDP 未就绪");
  const ws = new RawWs(page.webSocketDebuggerUrl);
  await ws.connect();
  await ws.send("Page.enable");
  await ws.send("Runtime.enable");
  await ws.send("Emulation.setDeviceMetricsOverride", {
    width: 412, height: 823, deviceScaleFactor: 2, mobile: true,
  });
  await ws.send("Page.navigate", { url });
  await sleep(7000);
  const r = await ws.send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
  const d = JSON.parse(r.result.value);
  console.log("同一段文字在不同字体下的宽度 (px)");
  console.log(`  Geist 400                     ${d.geist400}`);
  console.log(`  Geist stack (真实用的栈) 400   ${d.geistStack400}`);
  console.log(`  "Geist Fallback" 400          ${d.geistFallback400}`);
  console.log(`  system-ui 400                 ${d.sys400}`);
  console.log();
  console.log(`  Geist 700                     ${d.geist700}`);
  console.log(`  "Geist Fallback" 700          ${d.geistFallback700}`);
  console.log(`  system-ui 700                 ${d.sys700}`);
  console.log();
  const near = (a, b) => Math.abs(a - b) <= 1.5;
  console.log("判定：");
  console.log(
    `  404: Fallback ≈ Geist ?      ${near(d.geistFallback400, d.geist400) ? "YES" : "NO"}  ` +
      `(差 ${(d.geistFallback400 - d.geist400).toFixed(2)}px)`,
  );
  console.log(
    `  Fallback ≈ system-ui ?       ${near(d.geistFallback400, d.sys400) ? "YES — face 没生效" : "NO — face 已生效"}`,
  );
  console.log();
  console.log("  fonts API:");
  for (const f of d.faces) console.log("    " + f);
  ws.close();
} finally {
  child.kill();
  await sleep(400);
  try {
    execFileSync("rm", ["-rf", PROFILE]);
  } catch {}
}
