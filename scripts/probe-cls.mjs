#!/usr/bin/env node
/**
 * Deterministic local CLS probe.
 *
 * PSI gives CLS 0.000 on most runs and ~0.06-0.08 on a minority of them, which
 * is too noisy to attribute a cause from. This drives a real Chrome over CDP
 * against a locally served build, applies a *fixed* network profile, and reads
 * the layout-shift entries directly, so the same input gives the same answer.
 *
 * What it reports per run:
 *   - CLS and every shift, with the shifted element and its rect delta
 *   - when each font actually finished loading, relative to first paint
 *   - the offsetHeight of the key hero elements before/after
 *
 * Usage:
 *   node scripts/probe-cls.mjs <indexUrl> [runs]
 *
 * The point is attribution, not scoring: if a shift's element is the hero
 * <section> and the font timings line up, the font is the cause.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const [url, runsArg] = process.argv.slice(2);
if (!url) {
  console.error("usage: node scripts/probe-cls.mjs <indexUrl> [runs]");
  process.exit(2);
}
const RUNS = Number(runsArg || 3);
const PORT = 9251;
const PROFILE = "D:/tmp/cls-probe-profile";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error("找不到 Chrome");
}

async function waitForCdp(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "unknown";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const text = await r.text();
      // Chrome can serve an empty body briefly while it brings the target up.
      if (!text.trim()) {
        lastErr = "空响应体";
        await sleep(300);
        continue;
      }
      const list = JSON.parse(text);
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      lastErr = `无 page target（现有 ${list.length} 个）`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(300);
  }
  throw new Error(`CDP 未就绪（${lastErr}）`);
}

/**
 * Instrumentation injected before any page script runs.
 *
 * Reads PerformanceObserver layout-shift entries plus the font/paint timing we
 * need, and stashes the result on window for the harness to collect.
 */
const INSTRUMENT = `
(() => {
  window.__probe = { shifts: [], fonts: [], paints: [], marks: {} };

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        const sources = (e.sources || []).map((s) => {
          const n = s.node;
          return {
            tag: n ? n.tagName : null,
            cls: n ? (n.className || '').toString().slice(0, 90) : null,
            prevTop: s.previousRect ? Math.round(s.previousRect.top) : null,
            curTop: s.currentRect ? Math.round(s.currentRect.top) : null,
            prevH: s.previousRect ? Math.round(s.previousRect.height) : null,
            curH: s.currentRect ? Math.round(s.currentRect.height) : null,
          };
        });
        window.__probe.shifts.push({ startTime: Math.round(e.startTime), value: e.value, sources });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { window.__probe.shiftErr = String(e); }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__probe.fonts.push({ name: e.name.split('/').pop(), start: Math.round(e.startTime), end: Math.round(e.responseEnd) });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { window.__probe.fontErr = String(e); }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__probe.paints.push({ name: e.name, start: Math.round(e.startTime) });
      }
    }).observe({ type: 'paint', buffered: true });
  } catch (e) { window.__probe.paintErr = String(e); }
})();
`;

/** Collects the probe plus the geometry of the elements suspected of shifting. */
const COLLECT = `
(() => {
  const q = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top + scrollY), height: Math.round(r.height), width: Math.round(r.width) };
  };
  const fontsReady = document.fonts ? document.fonts.status : 'unknown';
  const loaded = [];
  if (document.fonts && document.fonts.forEach) {
    document.fonts.forEach((f) => loaded.push(f.family + ' ' + f.weight + ' ' + f.status));
  }
  return JSON.stringify({
    probe: window.__probe,
    fontsReady,
    loaded,
    geom: {
      heroSection: q('main section.relative'),
      badgeRow: q('main section.relative div.mt-9'),
      heroImg: q('main section.relative img.absolute'),
      scrollCue: q('main section.relative div.mt-12'),
    },
  });
})()
`;

/**
 * Minimal RFC6455 client.
 *
 * Node's built-in WebSocket cannot complete the handshake against Chrome in this
 * sandbox — the connection is accepted at TCP level and then reset, with no
 * useful error. A raw socket with the handshake written by hand works fine
 * (verified independently), so this speaks just enough of the protocol for CDP:
 * masked text frames out, unmasked text frames in, no fragmentation, no
 * extensions.
 */
class RawWs {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.handlers = { message: [] };
    sock.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    sock.on("close", () => this.handlers.close?.forEach((f) => f()));
  }
  on(ev, fn) {
    (this.handlers[ev] ||= []).push(fn);
    return this;
  }
  drain() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > 64n * 1024n * 1024n) throw new Error("帧过大");
        len = Number(big);
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x8) {
        this.sock.end();
        this.handlers.close?.forEach((f) => f());
        return;
      }
      if (opcode === 0x9) {
        this.sendRaw(0xa, payload);
        continue;
      }
      if (opcode === 0x1) {
        const text = payload.toString("utf8");
        this.handlers.message.forEach((f) => f(text));
      }
    }
  }
  sendRaw(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  send(text) {
    this.sendRaw(0x1, Buffer.from(text, "utf8"));
  }
  close() {
    try { this.sock.destroy(); } catch {}
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on("message", (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
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
    `GET ${u.pathname} HTTP/1.1\r\n` +
      `Host: ${u.hostname}:${u.port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
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
      const rest = acc.subarray(i + 4).toString("latin1");
      if (!head.includes("101") || !head.includes(expect)) {
        rej(new Error(`WS 握手被拒: ${head.split("\r\n")[0]}\n${head}\n--- body ---\n${rest.slice(0, 500)}`));
        return;
      }
      // Anything past the header block is the first frame.
      sock.unshift(acc.subarray(i + 4));
      res();
    });
  });
  return new Cdp(new RawWs(sock));
}

const chrome = findChrome();
if (existsSync(PROFILE)) {
  try { execFileSync("rm", ["-rf", PROFILE]); } catch {}
}
mkdirSync(PROFILE, { recursive: true });

// Chrome must outlive the shell that spawned it, and it needs a page target to
// attach to. Launch on about:blank and navigate later over CDP: if Chrome is
// given the real URL up front, attaching while that load is in flight makes it
// answer the WS handshake with a bare 500.
const child = spawn(
  chrome,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--window-size=412,823",
    "--remote-allow-origins=*",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"], detached: false },
);
child.stderr.on("data", (d) => {
  const s = String(d);
  if (/error|fail/i.test(s) && !/DevTools listening/i.test(s)) {
    process.stderr.write(`[chrome] ${s}`);
  }
});

const results = [];
try {
  await waitForCdp(PORT);
  // Chrome answers the WS handshake with a bare 500 if you attach while the
  // initial page load is still in flight. Give it a moment to settle first —
  // this is the difference between a clean 101 and an opaque failure.
  await sleep(2000);

  for (let run = 1; run <= RUNS; run++) {
    // Re-resolve every run: closing a page target invalidates its id, so a URL
    // captured once will fail with "No such target id" on the second run.
    const page = await waitForCdp(PORT);
    const cdp = await connect(page);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Network.enable");

      // A fixed, harsh profile so each run is comparable. Mobile 4G-ish with a
      // slow CPU, which is where the shift shows up.
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 412,
        height: 823,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });

      const bust = `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}${run}`;
      await cdp.send("Page.navigate", { url: bust });

      // Let fonts settle and any late shifts land.
      await sleep(6000);

      const raw = await cdp.send("Runtime.evaluate", {
        expression: COLLECT,
        returnByValue: true,
        awaitPromise: false,
      });
      const parsed = JSON.parse(raw.result.value);
      parsed.run = run;
      results.push(parsed);
    } catch (e) {
      results.push({ run, error: String(e) });
    } finally {
      // Do not Page.close: that destroys the target and the next run cannot
      // reattach. Navigating away is enough to reset the document.
      try { await cdp.send("Emulation.clearDeviceMetricsOverride"); } catch {}
      try { cdp.ws.close(); } catch {}
    }
    await sleep(500);
  }
} finally {
  child.kill();
}

let cls = 0;
for (const r of results) {
  console.log(`\n===== run ${r.run} =====`);
  if (r.error) {
    console.log("  ERROR:", r.error);
    continue;
  }
  const shifts = r.probe.shifts || [];
  const total = shifts.reduce((s, x) => s + x.value, 0);
  const fcp = (r.probe.paints || []).find((p) => p.name === "first-contentful-paint");
  const fonts = r.probe.fonts || [];
  const lastFont = fonts.reduce((m, f) => Math.max(m, f.end), 0);

  console.log(`  CLS = ${total.toFixed(4)}   (${shifts.length} 次移位)`);
  console.log(`  FCP = ${fcp ? fcp.start : "n/a"} ms   |  最后一个字体完成 = ${lastFont} ms`);
  console.log(`  document.fonts.status = ${r.fontsReady}`);
  console.log(`  几何:`, JSON.stringify(r.geom));

  for (const s of shifts) {
    console.log(`   shift t=${s.startTime}ms  value=${s.value.toFixed(5)}`);
    for (const src of s.sources) {
      console.log(
        `      <${src.tag}> top ${src.prevTop}->${src.curTop}  h ${src.prevH}->${src.curH}  .${(src.cls || "").slice(0, 60)}`,
      );
    }
  }
  console.log("  字体到达时间:");
  for (const f of fonts) console.log(`      ${String(f.end).padStart(5)} ms  ${f.name}`);
  console.log("  已加载字面:");
  for (const l of r.loaded) console.log(`      ${l}`);
}
writeFileSync("D:/tmp/cls-probe-result.json", JSON.stringify(results, null, 2));
console.log("\n原始结果已写出: D:/tmp/cls-probe-result.json");
