#!/usr/bin/env node
/**
 * Does the metric override reproduce Geist's LINE-BOX height, not just its widths?
 *
 * The remaining desktop layout shift after the width work is:
 *   P.mt-6  top 430 -> 374   h 112 -> 112
 * i.e. a pure vertical translation with unchanged height, caused by something
 * ABOVE it getting shorter. The only candidate is the <h1>, which has two lines
 * whose height is driven by font ascent+descent (line-height is leading-[1.06],
 * so the used line box is still floored by the font's own metrics).
 *
 * Width matching is not enough: ascent-override / descent-override decide the
 * line box. This script renders one line of text in each family and compares
 * the rendered line-box height, so a wrong descent-override is visible directly.
 *
 * Usage: node scripts/probe-linebox.mjs <indexUrl>
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/probe-linebox.mjs <indexUrl>");
  process.exit(2);
}

const PORT = 9287;
const PROFILE = `D:/tmp/linebox-${randomBytes(4).toString("hex")}`;
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

/**
 * Compare the rendered LINE BOX for one line of text between Geist and the
 * fallback. Uses an inline-block-free measurement: a block whose height is
 * driven purely by the font's ascent+descent, at a large font-size so the
 * difference is not lost to rounding.
 */
const MEASURE = `
(async () => {
  const out = { families: {}, faces: [] };
  const SIZES = [16, 56];
  const mk = (fam, weight, size) => {
    const d = document.createElement('div');
    d.textContent = 'Hg';
    d.style.cssText =
      'position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;' +
      'font-size:' + size + 'px;font-family:' + fam + ';font-weight:' + weight + ';';
    document.body.appendChild(d);
    const r = d.getBoundingClientRect();
    const cs = getComputedStyle(d);
    d.remove();
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, lh: cs.lineHeight };
  };
  const fams = [['Geist', 400], ['Geist', 500], ['Geist', 600], ['Geist', 700],
                ['"Geist Fallback"', 400], ['"Geist Fallback"', 500],
                ['"Geist Fallback"', 600], ['"Geist Fallback"', 700],
                ['"Geist Mono"', 400], ['"Geist Mono Fallback"', 400]];
  const reqs = fams.map(([f, w]) =>
    document.fonts.load(w + ' 16px ' + f, 'Hg').catch(() => {}));
  await Promise.all(reqs);
  await document.fonts.ready;
  for (const [f, w] of fams) {
    for (const s of SIZES) {
      out.families[f.replace(/"/g, '') + '|' + w + '|' + s] = mk(f, w, s);
    }
  }
  document.fonts.forEach((x) => out.faces.push(x.family + ' w' + x.weight + ' ' + x.status));
  return JSON.stringify(out);
})()
`;

const chrome = findChrome();
if (existsSync(PROFILE)) {
  try {
    spawn("rm", ["-rf", PROFILE]);
  } catch {}
}
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

  console.log("=== 行盒宽度/高度（同一字符串 'Hg'）===");
  for (const size of [16, 56]) {
    console.log(`\n--- font-size ${size}px ---`);
    console.log("  weight | Geist w      | Fallback w   | Δw%    | Geist h | Fallback h | Δh");
    for (const w of [400, 500, 600, 700]) {
      const g = d.families["Geist|" + w + "|" + size];
      const f = d.families["Geist Fallback|" + w + "|" + size];
      if (!g || !f) continue;
      const dwp = ((f.w - g.w) / g.w) * 100;
      const dh = f.h - g.h;
      const flag = Math.abs(dwp) > 1.2 || Math.abs(dh) > 0.5 ? "  <--" : "";
      console.log(
        `  ${String(w).padEnd(6)} | ${String(g.w).padStart(12)} | ${String(f.w).padStart(12)} | ${(dwp >= 0 ? "+" : "") + dwp.toFixed(2).padStart(5)}% | ${String(g.h).padStart(7)} | ${String(f.h).padStart(10)} | ${(dh >= 0 ? "+" : "") + dh.toFixed(2)}${flag}`,
      );
    }
    const gm = d.families["Geist Mono|400|" + size];
    const mf = d.families["Geist Mono Fallback|400|" + size];
    if (gm && mf) {
      const dwp = ((mf.w - gm.w) / gm.w) * 100;
      const dh = mf.h - gm.h;
      console.log(
        `  mono400| ${String(gm.w).padStart(12)} | ${String(mf.w).padStart(12)} | ${(dwp >= 0 ? "+" : "") + dwp.toFixed(2).padStart(5)}% | ${String(gm.h).padStart(7)} | ${String(mf.h).padStart(10)} | ${(dh >= 0 ? "+" : "") + dh.toFixed(2)}`,
      );
    }
  }
  console.log("\n=== 已加载字面 ===");
  for (const f of d.faces) console.log("   " + f);
} finally {
  child.kill();
}
