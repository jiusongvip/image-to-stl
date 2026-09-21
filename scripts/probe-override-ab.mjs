#!/usr/bin/env node
/**
 * Controlled A/B: what does ascent/descent-override ACTUALLY do to the line box?
 *
 * The previous solve produced ascent-override ~57%, which is far outside the
 * sane range and would clip descenders — a sign the underlying model is wrong.
 * Rather than reason further, inject three @font-face variants for the same
 * family into a page and measure the resulting line-box height for each:
 *
 *   A: no override at all               -> the raw system-font metrics
 *   B: the CURRENT override (85.26/87.66)
 *   C: a deliberately extreme override  -> proves the property is being applied
 *
 * With those three numbers the relationship is determined empirically instead
 * of assumed, and the correct value can be read off rather than derived.
 *
 * Usage: node scripts/probe-override-ab.mjs <indexUrl>
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/probe-override-ab.mjs <indexUrl>");
  process.exit(2);
}

const PORT = 9291;
const PROFILE = `D:/tmp/ovr-${randomBytes(4).toString("hex")}`;
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
 * Build four variants of the SAME underlying local font, each under its own
 * family name so they cannot collide, then measure one line in each.
 */
const MEASURE = `
(async () => {
  const SIZES = [16, 56, 100];
  const VARIANTS = [
    ['V_None', ''],
    ['V_Cur',  'ascent-override:85.26%;descent-override:87.66%;'],
    ['V_Big',  'ascent-override:100%;descent-override:100%;'],
    ['V_Sum170','ascent-override:85%;descent-override:85%;'],
  ];
  const style = document.createElement('style');
  let css = '';
  for (const [fam, ovr] of VARIANTS) {
    css += '@font-face{font-family:' + fam + ';src:local("Segoe UI"),local("Arial");font-weight:400;' + ovr + '}';
  }
  style.textContent = css;
  document.head.appendChild(style);

  const mk = (fam, size) => {
    const d = document.createElement('div');
    d.textContent = 'Hgy';
    d.style.cssText =
      'position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;' +
      'font-size:' + size + 'px;font-family:' + fam + ';font-weight:400;';
    document.body.appendChild(d);
    const r = d.getBoundingClientRect();
    d.remove();
    return Math.round(r.height * 100) / 100;
  };

  // Real Geist for the target, loaded explicitly.
  await document.fonts.load('400 16px "Geist"', 'Hgy');
  await document.fonts.load('700 16px "Geist"', 'Hgy');
  await document.fonts.ready;

  const out = { variants: {}, geist: {}, mono: {} };
  for (const size of SIZES) {
    for (const [fam] of VARIANTS) out.variants[fam + '|' + size] = mk(fam, size);
    out.geist['Geist400|' + size] = mk('Geist', size);
  }
  // Mono target (Geist Mono) at the two sizes.
  out.mono['GeistMono|56'] = mk('"Geist Mono"', 56);
  out.mono['GeistMono|100'] = mk('"Geist Mono"', 100);
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

  console.log("=== 行盒高度：override 受控 A/B（同为本机 Segoe UI）===");
  console.log("  size  | V_None(无override) | V_Cur(85.26/87.66) | V_Big(100/100) | V_Sum170(85/85) | Geist400");
  for (const size of [16, 56, 100]) {
    const row = ["V_None", "V_Cur", "V_Big", "V_Sum170"].map((f) => d.variants[f + "|" + size]);
    const g = d.geist["Geist400|" + size];
    console.log(
      `  ${String(size).padEnd(5)} | ${String(row[0]).padStart(18)} | ${String(row[1]).padStart(18)} | ${String(row[2]).padStart(14)} | ${String(row[3]).padStart(15)} | ${String(g).padStart(8)}`,
    );
  }
  console.log("\n  比值（高度 / font-size）：");
  for (const size of [16, 56, 100]) {
    const row = ["V_None", "V_Cur", "V_Big", "V_Sum170"].map((f) =>
      (d.variants[f + "|" + size] / size).toFixed(4),
    );
    const g = (d.geist["Geist400|" + size] / size).toFixed(4);
    console.log(
      `  ${String(size).padEnd(5)} | ${row[0].padStart(18)} | ${row[1].padStart(18)} | ${row[2].padStart(14)} | ${row[3].padStart(15)} | ${g.padStart(8)}`,
    );
  }
  console.log("\n  Geist Mono 目标：56px ->", d.mono["GeistMono|56"], " 100px ->", d.mono["GeistMono|100"]);
  console.log("  Geist Mono 比值：", (d.mono["GeistMono|56"] / 56).toFixed(4), (d.mono["GeistMono|100"] / 100).toFixed(4));
} finally {
  child.kill();
}
