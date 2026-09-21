#!/usr/bin/env node
/**
 * Which weights does the fallback actually have, and how far off is it?
 *
 * Context: the hero badges use `font-medium` (w500) and the CTA buttons use
 * `font-semibold` (w600). global.css declares fallback faces for w400 and w700
 * only — there is no w500/w600 face. CSS font matching will pair a w500 request
 * against the nearest declared face, but a w500 fallback and a w500 Geist do
 * not have the same advance widths, so text re-wraps when Geist arrives.
 *
 * PSI 2026-09-21 named the shifting element as
 * div.mt-8.flex.flex-wrap.gap-3 (the CTA row, w600 text) with a shift up to
 * 0.2771 on desktop, and a SPAN inside div.mt-9 (the badges, w500 text).
 * Both weights are exactly the ones with no fallback face.
 *
 * This script measures the same string at every weight under:
 *   - the real Geist webfont
 *   - "Geist Fallback"
 * and reports the per-weight delta.
 *
 * Usage: node scripts/probe-fallback-weights.mjs <indexUrl>
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/probe-fallback-weights.mjs <indexUrl>");
  process.exit(2);
}

const PORT = 9281;
const PROFILE = `D:/tmp/fbw-probe-${randomBytes(4).toString("hex")}`;
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

async function waitForCdp(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = "unknown";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = await r.text();
      if (!t.trim()) { last = "空响应"; await sleep(300); continue; }
      const page = JSON.parse(t).find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      last = "无 page target";
    } catch (e) { last = e.message; }
    await sleep(300);
  }
  throw new Error(`CDP 未就绪（${last}）`);
}

/** Minimal RFC6455 client — Node's built-in WebSocket cannot handshake here. */
class RawWs {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.handlers = { message: [] };
    sock.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    sock.on("close", () => this.handlers.close?.forEach((f) => f()));
  }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  drain() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) { this.sock.end(); this.handlers.close?.forEach((f) => f()); return; }
      if (opcode === 0x9) { this.sendRaw(0xa, payload); continue; }
      if (opcode === 0x1) this.handlers.message.forEach((f) => f(payload.toString("utf8")));
    }
  }
  sendRaw(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  send(t) { this.sendRaw(0x1, Buffer.from(t, "utf8")); }
  close() { try { this.sock.destroy(); } catch {} }
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.on("message", (t) => {
      let m; try { m = JSON.parse(t); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        this.pending.delete(m.id); clearTimeout(timer);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); } }, 180000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connect(wsUrl) {
  const u = new URL(wsUrl);
  const key = randomBytes(16).toString("base64");
  const sock = net.connect(Number(u.port), u.hostname);
  await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
  sock.write(
    `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nUpgrade: websocket\r\n` +
    `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
    `Origin: http://${u.hostname}:${u.port}\r\n\r\n`,
  );
  const expect = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  let acc = Buffer.alloc(0);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("WS 握手超时")), 15000);
    sock.on("data", function onData(d) {
      acc = Buffer.concat([acc, d]);
      const i = acc.indexOf("\r\n\r\n");
      if (i === -1) return;
      sock.off("data", onData); clearTimeout(t);
      const head = acc.subarray(0, i).toString("latin1");
      if (!head.includes("101") || !head.includes(expect)) { rej(new Error(`WS 握手被拒: ${head.split("\r\n")[0]}`)); return; }
      sock.unshift(acc.subarray(i + 4));
      res();
    });
  });
  return new Cdp(new RawWs(sock));
}

/**
 * Measure a fixed string at each weight, in a given family.
 *
 * Uses a hidden <span> with white-space:nowrap so the width is the raw advance
 * of the whole string — no wrapping, no container influence.
 */
const MEASURE = `
(async () => {
  const TEXT = 'Real-Time 3D Preview';
  const TEXT2 = 'Start Converting';
  const TEXT3 = '01';
  // Mono is used well beyond the 01-04 step labels: the format chips render
  // "JPG / JPEG", "PNG", "SVG", "WebP" at font-medium, and a font-mono
  // uppercase header sits above the gallery. A two-character "01" is far too
  // narrow to discriminate between faces, so measure realistic strings too.
  const MONO_TEXTS = {
    step: '01',
    chip: 'JPG / JPEG',
    header: 'FILE FORMATS',
    nums: '04 03 02 01',
  };
  const FAMILIES = ['Geist', '"Geist Fallback"', 'system-ui'];
  const MONO = ['"Geist Mono"', '"Geist Mono Fallback"', 'ui-monospace'];
  const WEIGHTS = [400, 500, 600, 700];
  const mk = (fam, weight, text) => {
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
  const out = { badge: {}, cta: {}, mono: {}, monoLong: {}, faces: [], loaded: {}, diag: {} };

  // CRITICAL: force every face we intend to measure to actually load first.
  //
  // Without this the probe silently compares a system font to itself: an
  // unloaded webfont and the metric-override fallback both resolve to the same
  // installed face, so every delta reads exactly 0.00 and the run looks like a
  // perfect pass. That is a false pass, and it is the single easiest way to be
  // misled by this script. document.fonts.load() drives the fetch; awaiting
  // it makes the measurement deterministic instead of racing page paint.
  const reqs = [];
  for (const fam of FAMILIES.concat(MONO)) {
    for (const wt of [400, 500, 600, 700]) reqs.push([fam.replace(/"/g, ''), wt]);
  }
  await Promise.all(
    reqs.map(([fam, wt]) =>
      document.fonts.load(wt + ' 16px "' + fam + '"', 'Real-Time 3D Preview 01')
        .then((fs) => { out.loaded[fam + '|' + wt] = fs.length; })
        .catch(() => { out.loaded[fam + '|' + wt] = -1; }),
    ),
  );
  await document.fonts.ready;

  for (const fam of FAMILIES) {
    for (const wt of WEIGHTS) {
      out.badge[fam + '|' + wt] = mk(fam, wt, TEXT);
      out.cta[fam + '|' + wt] = mk(fam, wt, TEXT2);
    }
  }
  // Mono is used at w400 (scroll cue), w500 (format chips, font-medium) and
  // w600 (01-04 step labels, font-semibold). Measure all three against several
  // realistic strings, because a single narrow string can make every weight look
  // identical and hide a wrong size-adjust.
  for (const fam of MONO) {
    for (const wt of [400, 500, 600]) {
      out.mono[fam + '|' + wt] = mk(fam, wt, TEXT3);
      for (const [k, s] of Object.entries(MONO_TEXTS)) {
        out.monoLong[fam + '|' + wt + '|' + k] = mk(fam, wt, s);
      }
    }
  }
  if (document.fonts) {
    document.fonts.forEach((f) => out.faces.push(f.family + ' w' + f.weight + ' ' + f.status));
  }
  out.status = document.fonts ? document.fonts.status : 'n/a';

  // Independent sanity check that does NOT depend on the widths above:
  // render the same string twice, once with the webfont and once with the
  // declared fallback family, and compare against a third render in a
  // deliberately absent family (which must fall through to the system default).
  // If "Geist" is indistinguishable from the absent family, the webfont did not
  // load and every number in this report is meaningless.
  out.diag.geist = mk('Geist', 400, TEXT);
  out.diag.absent = mk('"NoSuchFamilyXYZ"', 400, TEXT);
  out.diag.fallback = mk('"Geist Fallback"', 400, TEXT);
  out.diag.systemui = mk('system-ui', 400, TEXT);
  return JSON.stringify(out);
})()
`;

// Node-side copy of the mono strings measured inside the page, so the output
// formatter can label the rows. Must stay in sync with MONO_TEXTS in MEASURE.
const MONO_TEXTS = { step: "01", chip: "JPG / JPEG", header: "FILE FORMATS", nums: "04 03 02 01" };

const chrome = findChrome();
if (existsSync(PROFILE)) { try { spawn("rm", ["-rf", PROFILE]); } catch {} }
spawn("mkdir", ["-p", PROFILE]);

const child = spawn(chrome, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--window-size=412,823",
  "--remote-allow-origins=*",
  "about:blank",
], { stdio: "ignore" });

try {
  await waitForCdp();
  await sleep(2000);
  const ws = await connect(await waitForCdp());
  await ws.send("Page.enable");
  await ws.send("Runtime.enable");
  await ws.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 823, deviceScaleFactor: 2, mobile: true });
  await ws.send("Page.navigate", { url: url + (url.includes("?") ? "&" : "?") + "cb=1" });
  await sleep(6000);

  const r = await ws.send("Runtime.evaluate", {
    expression: MEASURE,
    returnByValue: true,
    awaitPromise: true,
  });
  const d = JSON.parse(r.result.value);

  for (const [label, key, ref] of [["badge 文本 (font-medium=w500)", "badge", "Real-Time 3D Preview"], ["CTA 文本 (font-semibold=w600)", "cta", "Start Converting"]]) {
    console.log(`\n=== ${label} — "${ref}" ===`);
    console.log("  weight | Geist    | Geist Fallback | 差值    | 差%   | system-ui");
    for (const wt of [400, 500, 600, 700]) {
      const g = d[key]["Geist|" + wt];
      const f = d[key]['"Geist Fallback"|' + wt];
      const s = d[key]["system-ui|" + wt];
      const delta = (f - g);
      const pct = g ? (delta / g) * 100 : 0;
      const flag = Math.abs(pct) > 1.2 ? "  <-- 偏大" : "";
      console.log(
        `  ${String(wt).padEnd(6)} | ${String(g).padStart(8)} | ${String(f).padStart(14)} | ${(delta>=0?"+":"")+delta.toFixed(2).padStart(6)} | ${pct.toFixed(2).padStart(5)}% | ${String(s).padStart(9)}${flag}`,
      );
    }
  }
  console.log('\n=== mono 文本 ("01") ===');
  console.log("  weight | Geist Mono | Geist Mono Fallback | 差值    | 差%   | ui-monospace");
  for (const wt of [400, 500, 600]) {
    const g = d.mono['"Geist Mono"|' + wt];
    const f = d.mono['"Geist Mono Fallback"|' + wt];
    const s = d.mono["ui-monospace|" + wt];
    const delta = f - g;
    const pct = g ? (delta / g) * 100 : 0;
    const flag = Math.abs(pct) > 1.2 ? "  <-- 偏大" : "";
    console.log(
      `  ${String(wt).padEnd(6)} | ${String(g).padStart(10)} | ${String(f).padStart(19)} | ${(delta >= 0 ? "+" : "") + delta.toFixed(2).padStart(6)} | ${pct.toFixed(2).padStart(5)}% | ${String(s).padStart(11)}${flag}`,
    );
  }
  console.log("\n=== mono 长字符串（真实用法）===");
  console.log("  weight | string        | Geist Mono | Fallback | 差%");
  for (const wt of [400, 500, 600]) {
    for (const k of Object.keys(MONO_TEXTS)) {
      const g = d.monoLong['"Geist Mono"|' + wt + '|' + k];
      const f = d.monoLong['"Geist Mono Fallback"|' + wt + '|' + k];
      const pct = g ? ((f - g) / g) * 100 : 0;
      const flag = Math.abs(pct) > 1.2 ? "  <-- 偏大" : "";
      console.log(
        `  ${String(wt).padEnd(6)} | ${k.padEnd(13)} | ${String(g).padStart(10)} | ${String(f).padStart(8)} | ${pct.toFixed(2).padStart(5)}%${flag}`,
      );
    }
  }

  console.log("\n=== 加载断言（防止「假通过」）===");
  const notLoaded = Object.entries(d.loaded).filter(([, n]) => n <= 0);
  console.log("  已请求字面数: " + Object.keys(d.loaded).length + "，未加载: " + notLoaded.length);
  if (notLoaded.length) {
    for (const [k, n] of notLoaded) console.log("    ✗ " + k + " -> " + n);
  }
  const g = d.diag.geist, ab = d.diag.absent, fb = d.diag.fallback, su = d.diag.systemui;
  console.log("  Geist=" + g + "  NoSuchFamily=" + ab + "  GeistFallback=" + fb + "  system-ui=" + su);
  const webfontAbsent = Math.abs(g - ab) < 0.01;
  const fallbackMatchesSystem = Math.abs(fb - su) < 0.01;
  if (webfontAbsent) {
    console.log("  ✗✗ 致命：Geist 与「不存在的族」宽度完全相同 → webfont 根本没加载，本报告全部作废");
  } else {
    console.log("  ✓ Geist 与不存在的族不同（差 " + (g - ab).toFixed(2) + "px）→ webfont 确实参与排版");
  }
  if (fallbackMatchesSystem) {
    console.log("  ⚠ 注意：Geist Fallback 与 system-ui 宽度相同 —— 确认这是本机实测结果而非未生效");
  }
  console.log("  document.fonts.status = " + d.status);
  const allZero = Object.keys(d.badge).every((k) => Math.abs(d.badge[k] - d.badge[k.replace(/^[^|]+\|/, "Geist|")]) < 0.01);
  console.log("\n=== 已注册字面 ===");
  for (const f of d.faces) console.log("   " + f);
  if (webfontAbsent) process.exitCode = 1;
} finally {
  child.kill();
}
