#!/usr/bin/env node
/**
 * Why do the two probes disagree about WIDTH?
 *
 * probe-fallback-weights.mjs reports exactly 0.00% width difference for four
 * mono strings and ~0.05% for Geist, while probe-linebox.mjs reports +5.7% to
 * +8.4% for the short string "Hg". They use the same font-size, the same
 * nowrap/visibility:hidden technique and the same page, so the input string is
 * the only remaining variable.
 *
 * 0.00% on every string is itself suspicious — real font matching rarely lands
 * on exactly zero. This script measures several strings side by side, including
 * strings from both probes, to find out whether one of them is measuring
 * something other than what it thinks.
 *
 * Usage: node scripts/probe-string-diff.mjs <indexUrl>
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/probe-string-diff.mjs <indexUrl>");
  process.exit(2);
}

const PORT = 9295;
const PROFILE = `D:/tmp/strdiff-${randomBytes(4).toString("hex")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const c = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const p of c) if (existsSync(p)) return p;
  throw new Error("未找到 Chrome/Edge");
}

class RawWs {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.onmessage = null;
    sock.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
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
      if (this.onmessage) this.onmessage(payload.toString("utf8"));
    }
  }
  sendRaw(op, data) {
    const mask = randomBytes(4);
    const len = data.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, 0x80 | len]);
    else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  send(t) {
    this.sendRaw(0x1, Buffer.from(t, "utf8"));
  }
  close() {
    try {
      this.sock.destroy();
    } catch {}
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (t) => {
      let m;
      try {
        m = JSON.parse(t);
      } catch {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(timer);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 180000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connect(wsUrl) {
  const u = new URL(wsUrl);
  const key = randomBytes(16).toString("base64");
  const sock = net.connect(Number(u.port), u.hostname);
  await new Promise((res, rej) => {
    sock.once("connect", res);
    sock.once("error", rej);
  });
  sock.write(
    `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
      `Origin: http://${u.hostname}:${u.port}\r\n\r\n`,
  );
  const expect = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  let acc = Buffer.alloc(0);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("WS 握手超时")), 15000);
    sock.on("data", function onData(d) {
      acc = Buffer.concat([acc, d]);
      const i = acc.indexOf("\r\n\r\n");
      if (i === -1) return;
      sock.off("data", onData);
      clearTimeout(t);
      const head = acc.subarray(0, i).toString("latin1");
      if (!head.includes("101") || !head.includes(expect)) {
        rej(new Error(`WS 握手被拒: ${head.split("\r\n")[0]}`));
        return;
      }
      sock.unshift(acc.subarray(i + 4));
      res();
    });
  });
  return new Cdp(new RawWs(sock));
}

async function waitForCdp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("等待 CDP 超时");
}

const MEASURE = `
(async () => {
  // Both probes' strings, measured the same way in the same run.
  const STRINGS = {
    short_Hg:      'Hg',
    badge:         'Real-Time 3D Preview',
    cta:           'Start Converting',
    mono_step:     '01',
    mono_chip:     'JPG / JPEG',
  };
  const WEIGHTS = [400, 500, 600, 700];
  await Promise.all([
    document.fonts.load('400 16px "Geist"', 'Hg'),
    document.fonts.load('500 16px "Geist"', 'Hg'),
    document.fonts.load('600 16px "Geist"', 'Hg'),
    document.fonts.load('700 16px "Geist"', 'Hg'),
    document.fonts.load('400 16px "Geist Fallback"', 'Hg'),
    document.fonts.load('500 16px "Geist Fallback"', 'Hg'),
    document.fonts.load('600 16px "Geist Fallback"', 'Hg'),
    document.fonts.load('700 16px "Geist Fallback"', 'Hg'),
  ]);
  await document.fonts.ready;

  // Measure with BOTH techniques so any difference in the method shows up.
  const mkRect = (fam, weight, text) => {
    const s = document.createElement('span');
    s.textContent = text;
    s.style.cssText =
      'position:absolute;visibility:hidden;white-space:nowrap;font-size:16px;line-height:1;' +
      'font-family:' + fam + ';font-weight:' + weight + ';';
    document.body.appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return Math.round(w * 100) / 100;
  };
  const mkRange = (fam, weight, text) => {
    const s = document.createElement('span');
    s.textContent = text;
    s.style.cssText =
      'position:absolute;visibility:hidden;white-space:nowrap;font-size:16px;line-height:1;' +
      'font-family:' + fam + ';font-weight:' + weight + ';';
    document.body.appendChild(s);
    const r = document.createRange();
    r.selectNodeContents(s);
    const w = r.getBoundingClientRect().width;
    s.remove();
    return Math.round(w * 100) / 100;
  };

  const out = { rect: {}, range: {} };
  for (const [k, text] of Object.entries(STRINGS)) {
    for (const w of WEIGHTS) {
      out.rect[k + '|' + w] = [mkRect('Geist', w, text), mkRect('"Geist Fallback"', w, text)];
      out.range[k + '|' + w] = [mkRange('Geist', w, text), mkRange('"Geist Fallback"', w, text)];
    }
  }
  out.faces = [];
  document.fonts.forEach((f) => out.faces.push(f.family + ' w' + f.weight + ' ' + f.status));
  return JSON.stringify(out);
})()
`;

const chrome = findChrome();
spawn("mkdir", ["-p", PROFILE]);

const child = spawn(
  chrome,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1350,940",
    "--remote-allow-origins=*",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  await waitForCdp();
  await sleep(2000);
  const ws = await connect(await waitForCdp());
  await ws.send("Page.enable");
  await ws.send("Runtime.enable");
  await ws.send("Emulation.setDeviceMetricsOverride", {
    width: 1350,
    height: 940,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await ws.send("Page.navigate", { url: url + (url.includes("?") ? "&" : "?") + "cb=1" });
  await sleep(6000);

  const r = await ws.send("Runtime.evaluate", {
    expression: MEASURE,
    returnByValue: true,
    awaitPromise: true,
  });
  const d = JSON.parse(r.result.value);

  const names = {
    short_Hg: "Hg",
    badge: "Real-Time 3D Preview",
    cta: "Start Converting",
    mono_step: "01",
    mono_chip: "JPG / JPEG",
  };
  for (const method of ["rect", "range"]) {
    console.log(`\n=== 测量方式: ${method === "rect" ? "getBoundingClientRect" : "Range.getBoundingClientRect"} ===`);
    console.log("  字符串                  | w400 Δ% | w500 Δ% | w600 Δ% | w700 Δ%");
    for (const k of Object.keys(names)) {
      const cells = [400, 500, 600, 700].map((w) => {
        const [g, f] = d[method][k + "|" + w];
        const pct = g ? ((f - g) / g) * 100 : 0;
        return (pct >= 0 ? "+" : "") + pct.toFixed(2);
      });
      console.log(`  ${names[k].padEnd(22)} | ${cells.map((c) => c.padStart(7)).join(" | ")}`);
    }
  }
  console.log("\n=== 已加载字面 ===");
  for (const f of d.faces) console.log("   " + f);
} finally {
  child.kill();
}
