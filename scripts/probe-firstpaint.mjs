#!/usr/bin/env node
/**
 * First-paint layout error probe.
 *
 * The bug this exists to quantify: `scripts/inject-critical-css.mjs` inlined a
 * block that covered only 22% of the stylesheet, so the hero was laid out in a
 * *wrong state* at first paint and then reflowed when the real sheet arrived.
 * LCP is attributed to the element's final paint, so LCP waited for the
 * correction -- that was the entire 2000ms+ elementRenderDelay.
 *
 * This probe measures that directly and deterministically:
 *
 *   1. Navigate with a fixed 4x CPU throttle, no cache.
 *   2. Poll `getBoundingClientRect()` of the LCP-ish elements every ~50ms from
 *      inside the page, recording (top, height, width) plus which stylesheets
 *      are present at each sample.
 *   3. Report the *maximum deviation* between any sample and the final settled
 *      geometry, and the timestamp of the last sample that differed.
 *
 * A correct build reports deviation ~= 0 and `lastDiffering` before first paint.
 * A broken build reports hundreds of px and `lastDiffering` seconds later.
 *
 * Usage:
 *   node scripts/probe-firstpaint.mjs <indexUrl> [runs]
 *
 * Env:
 *   FP_CPU=1   disable CPU throttling (for interactive debugging)
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";

const [url, runsArg] = process.argv.slice(2);
if (!url) {
  console.error("usage: node scripts/probe-firstpaint.mjs <indexUrl> [runs]");
  process.exit(2);
}
const RUNS = Number(runsArg || 3);

/* ------------------------------------------------------------------ Chrome */

function findChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Users/jiusongPC11/AppData/Local/Google/Chrome/Application/chrome.exe",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("chrome not found");
}

/* ------------------------------------------------------- raw RFC6455 client */

class RawWs {
  constructor(url) {
    this.url = url;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  static async connect(url) {
    const ws = new RawWs(url);
    const u = new URL(url);
    const key = randomBytes(16).toString("base64");
    ws.sock = net.connect(Number(u.port), u.hostname);
    await new Promise((res, rej) => {
      ws.sock.once("connect", res);
      ws.sock.once("error", rej);
    });
    ws.sock.write(
      `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.hostname}:${u.port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await new Promise((res, rej) => {
      const onData = (d) => {
        const s = d.toString("latin1");
        if (s.includes("\r\n\r\n")) {
          ws.sock.off("data", onData);
          if (!s.startsWith("HTTP/1.1 101")) return rej(new Error("handshake failed: " + s.split("\r\n")[0]));
          const rest = d.subarray(s.indexOf("\r\n\r\n") + 4);
          if (rest.length) ws.#feed(rest);
          res();
        }
      };
      ws.sock.on("data", onData);
      ws.sock.once("error", rej);
    });
    ws.sock.on("data", (d) => ws.#feed(d));
    ws.sock.on("close", () => (ws.closed = true));
    ws.sock.on("error", () => (ws.closed = true));
    return ws;
  }

  #feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      let mask;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return;
      let payload = Buffer.from(b.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);
      if (op === 0x1 || op === 0x0) this.#message(payload.toString("utf8"));
      else if (op === 0x8) {
        this.closed = true;
        this.sock.end();
      }
      if (fin && op === 0x8) return;
    }
  }

  #message(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    }
  }

  #frame(payload) {
    const data = Buffer.from(payload, "utf8");
    const mask = randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x81, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  }

  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((res, rej) => {
      if (this.closed) return rej(new Error("socket closed"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      this.sock.write(this.#frame(JSON.stringify({ id, method, params })));
    });
  }

  close() {
    try {
      this.sock.end();
    } catch {}
  }
}

/* ------------------------------------------------------------------- probe */

// Runs inside the page: sample the geometry of the hero elements from the very
// first moment the DOM exists, and note when each stylesheet shows up.
const SAMPLER = `
(() => {
  window.__fp = { samples: [], err: null };
  const pick = () => {
    const main = document.querySelector('main');
    const hero = main && main.querySelector('section');
    const img = main && main.querySelector('img');
    const h1 = main && main.querySelector('h1');
    const wrap = main && main.firstElementChild;
    const g = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        t: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),
        d: cs.display, p: cs.position, mw: cs.maxWidth, op: cs.opacity,
      };
    };
    return {
      ts: Math.round(performance.now()),
      sheets: document.styleSheets.length,
      hasMain: !!main,
      hero: g(hero), img: g(img), h1: g(h1), wrap: g(wrap),
    };
  };
  // requestAnimationFrame is starved under 4x CPU throttling in headless, so
  // sample on a timer instead. The point is coverage of the whole load, not
  // frame alignment.
  const iv = setInterval(() => {
    try {
      window.__fp.samples.push(pick());
      if (window.__fp.samples.length >= 600) clearInterval(iv);
    } catch (e) { window.__fp.err = String(e); }
  }, 40);
  window.__fp.tick = pick;
})();
`;

const READ = "JSON.stringify(window.__fp || { samples: [] })";

async function launch() {
  const profile = `D:/tmp/fp-profile-${Date.now()}`;
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-features=Translate,BackForwardCache",
      "--window-size=412,823",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const port = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("chrome did not start")), 30000);
    const onData = (d) => {
      const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(d.toString());
      if (m) {
        clearTimeout(to);
        chrome.stderr.off("data", onData);
        res(Number(m[1]));
      }
    };
    chrome.stderr.on("data", onData);
    chrome.once("exit", () => rej(new Error("chrome exited early")));
  });
  return { chrome, port, profile };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oneRun(port, index, target) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const cdp = await RawWs.connect(page.webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 412, height: 823, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.FP_CPU || 4) });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SAMPLER });

  const nav = await cdp.send("Page.navigate", { url: `${target}?run=${index}` });
  if (!nav || nav.errorText) throw new Error(`navigate failed: ${nav && nav.errorText}`);

  // Never trust an empty reading before proving the probe actually landed on
  // the target. A hard-coded URL in an earlier revision sent Chrome to
  // about:blank and every run reported "NO DATA" as if the page were empty.
  await sleep(1200);
  const where = await cdp.send("Runtime.evaluate", {
    expression:
      "location.href + ' | main=' + !!document.querySelector('main') + ' | probe=' + !!window.__fp",
    returnByValue: true,
  });
  const landed = String(where.result.value);
  if (!landed.includes("main=true") || !landed.includes("probe=true")) {
    throw new Error(`probe did not land on the target page: ${landed}`);
  }

  // Let the page settle well past any late stylesheet / font arrival.
  await sleep(9000);

  const r = await cdp.send("Runtime.evaluate", {
    expression: READ, returnByValue: true, awaitPromise: true,
  });
  cdp.close();
  return JSON.parse(r.result.value);
}

function analyse(data) {
  const s = data.samples.filter((x) => x.hero && x.wrap);
  if (!s.length) return null;
  const last = s[s.length - 1];

  // Ignore samples taken before the element had any geometry at all -- that is
  // "not laid out yet", not "laid out wrongly".
  const laid = s.filter((x) => x.hero.h > 0 && x.wrap.w > 0);
  if (!laid.length) return null;

  let maxDev = 0;
  let devDetail = null;
  let lastDiffering = 0;
  let firstCorrect = null;
  let styleWrong = 0;

  // A geometry delta can come from two places, and only one is the bug this
  // measures. Layout-property loss (display / position / max-width / opacity)
  // is the critical-CSS bug. Height drift from late image decode or font swap
  // is normal and must NOT be counted against the build.
  const STYLE_KEYS = [
    ["d", "display"], ["p", "position"], ["mw", "maxWidth"], ["op", "opacity"],
  ];

  for (const x of laid) {
    const dh = Math.abs(x.hero.h - last.hero.h);
    const dw = Math.abs(x.wrap.w - last.wrap.w);
    const di = x.img && last.img ? Math.abs(x.img.w - last.img.w) : 0;
    const d = Math.max(dh, dw, di);

    let mismatch = null;
    if (x.img && last.img) {
      for (const [k, label] of STYLE_KEYS) {
        if (String(x.img[k]) !== String(last.img[k])) mismatch = `img.${label}: ${x.img[k]} -> ${last.img[k]}`;
      }
    }
    if (x.hero.d !== last.hero.d) mismatch = `hero.display: ${x.hero.d} -> ${last.hero.d}`;
    if (x.hero.p !== last.hero.p) mismatch = `hero.position: ${x.hero.p} -> ${last.hero.p}`;
    if (x.h1 && last.h1 && Math.abs(x.h1.w - last.h1.w) > 8) {
      mismatch = `h1.width: ${x.h1.w} -> ${last.h1.w}`;
    }
    if (mismatch) styleWrong++;

    if (d > maxDev) {
      maxDev = d;
      devDetail = {
        ts: x.ts, heroH: x.hero.h, finalHeroH: last.hero.h,
        wrapW: x.wrap.w, finalWrapW: last.wrap.w, imgW: x.img && x.img.w,
        mismatch,
      };
    }
    if (d > 4 || mismatch) lastDiffering = x.ts;
    if (d <= 4 && !mismatch && firstCorrect === null && x.ts > 100) firstCorrect = x.ts;
  }

  return {
    samples: s.length,
    maxDeviationPx: maxDev,
    styleWrongSamples: styleWrong,
    devDetail,
    lastDifferingTs: lastDiffering,
    firstCorrectTs: firstCorrect,
    settled: { heroH: last.hero.h, wrapW: last.wrap.w, imgW: last.img && last.img.w, sheets: last.sheets },
  };
}

/* -------------------------------------------------------------------- main */

const { chrome, port, profile } = await launch();
const results = [];
try {
  for (let i = 0; i < RUNS; i++) {
    const raw = await oneRun(port, i, url);
    const a = analyse(raw);
    results.push(a);
    console.log(`run ${i + 1}:`, a ? JSON.stringify(a) : "NO DATA");
  }
} finally {
  try {
    chrome.kill();
  } catch {}
  // Use Node's own rm rather than shelling out. `cmd /c rmdir` silently fails
  // here -- Git-Bash hands cmd a forward-slash path it cannot resolve -- and
  // the Chrome profiles accumulate in D:/tmp. fs.rmSync has no such problem.
  //
  // The short wait matters: Chrome releases its handles on the profile a beat
  // after the process is signalled, and rmSync gives up silently if a file is
  // still locked. maxRetries alone is not enough because the default retry
  // delay is shorter than the handle release.
  await sleep(800);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

const ok = results.filter(Boolean);
if (ok.length) {
  const avgStyle = Math.round(ok.reduce((a, b) => a + b.styleWrongSamples, 0) / ok.length);
  const avgDev = Math.round(ok.reduce((a, b) => a + b.maxDeviationPx, 0) / ok.length);
  const firstMismatch = ok.map((r) => r.devDetail && r.devDetail.mismatch).find(Boolean);
  console.log("");
  console.log(`== 首绘布局误差（${ok.length} 次） ==`);
  console.log(`  样式属性错位的采样数  平均 ${avgStyle}   ${avgStyle === 0 ? "✓ 首绘样式即正确" : "✗ 首绘有样式属性是错的（关键 CSS 缺失）"}`);
  console.log(`  最大几何偏差          平均 ${avgDev} px`);
  if (firstMismatch) console.log(`  首个错位示例          ${firstMismatch}`);
  console.log(
    avgStyle === 0
      ? "  → 通过：首绘渲染状态与完整样式表一致，LCP 不必等回流"
      : "  → 不通过：首绘渲染在错误状态，LCP 在等样式到达后的修正",
  );
}
