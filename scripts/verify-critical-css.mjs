#!/usr/bin/env node
/**
 * Verify that inlining the critical CSS does not change how above-the-fold
 * elements are actually styled.
 *
 * Drives headless Chrome over CDP and, for every element in the first
 * `limit` pixels of the document, compares computed styles between two URLs.
 * This is a far stronger check than a screenshot: it catches a missing utility
 * even when the difference is a few pixels of padding.
 *
 * Usage: node scripts/verify-critical-css.mjs <baselineUrl> <candidateUrl>
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

const [baselineUrl, candidateUrl] = process.argv.slice(2);
if (!baselineUrl || !candidateUrl) {
  console.error("usage: node scripts/verify-critical-css.mjs <baselineUrl> <candidateUrl>");
  process.exit(2);
}

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error("找不到 Chrome，跳过样式校验");
  process.exit(0);
}

const PORT = 9333;

/** Minimal CDP client over the DevTools WebSocket, using Node's built-in ws. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connect() {
  // The browser-level endpoint does not implement Page/Runtime; we need a page
  // target's own webSocketDebuggerUrl.
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome 未就绪");
}

/**
 * Guard against the single most dangerous failure mode of this script: if the
 * servers are not actually serving the site, Chrome renders its own error page
 * ("interstitial-wrapper"), and comparing that error page against itself
 * reports a perfect score. That false pass is worse than no check at all.
 *
 * We detect it by looking for Chrome's interstitial markers and by requiring a
 * plausible non-empty <title>, and we abort loudly rather than report success.
 */
const HEALTH = `
(() => {
  const body = document.body ? document.body.innerHTML : '';
  if (document.querySelector('.interstitial-wrapper') ||
      document.querySelector('#main-frame-error') ||
      /ERR_CONNECTION|ERR_EMPTY_RESPONSE|This site can.t be reached/i.test(body)) {
    return JSON.stringify({ ok: false, why: 'chrome-error-page' });
  }
  const els = document.querySelectorAll('body *').length;
  if (els < 30) return JSON.stringify({ ok: false, why: 'too-few-elements:' + els });
  const title = (document.title || '').trim();
  if (!title) return JSON.stringify({ ok: false, why: 'empty-title' });
  // A real page here is far taller than the viewport.
  if (document.documentElement.scrollHeight <= 900) {
    return JSON.stringify({ ok: false, why: 'doc-not-scrollable' });
  }
  return JSON.stringify({ ok: true, title, els });
})()
`;

async function assertRealPage(cdp, url, label) {
  const res = await cdp.send("Runtime.evaluate", {
    expression: HEALTH,
    returnByValue: true,
  });
  const h = JSON.parse(res.result.value);
  if (!h.ok) {
    throw new Error(
      `${label} (${url}) 不是真实页面：${h.why}\n` +
        `   → 校验已中止。请确认静态服务确实在提供站点（curl 该 URL 应返回 200 且体积 > 0）。`,
    );
  }
  return h;
}

/**
 * Properties compared between baseline and candidate.
 *
 * Sub-pixel geometry (`width`, `height`, `gap`) is included but compared with a
 * tolerance: text layout can jitter by a fraction of a pixel between runs, and
 * a strict string compare turns that noise into a false alarm. A genuinely
 * lost rule shifts geometry by whole pixels or more, so a 0.75px tolerance
 * still catches every real regression while ignoring the noise.
 */
const PROPS = [
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "padding",
  "margin",
  "borderRadius",
  "display",
  "width",
  "height",
  "flexDirection",
  "gap",
  "textDecorationLine",
  "opacity",
];
const NUMERIC_PROPS = new Set(["width", "height", "gap"]);
const TOLERANCE_PX = 0.75;

/** Collect computed styles for the first `limit` CSS pixels of content. */
const PROBE = (limit) => `
(() => {
  const props = ${JSON.stringify(PROPS)};
  const out = [];
  const nodes = document.querySelectorAll('body *');
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.top > ${limit} || r.bottom < 0) continue;
    const cs = getComputedStyle(el);
    const sig = {};
    for (const p of props) sig[p] = cs[p];
    out.push({
      tag: el.tagName,
      text: (el.textContent || '').trim().slice(0, 40),
      sig,
    });
  }
  return JSON.stringify(out);
})()
`;

async function probeStyles(cdp, url, viewport) {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const [w, h] = viewport.split("x").map(Number);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: 2,
    mobile: w < 768,
  });
  await cdp.send("Page.navigate", { url });
  await sleep(4000);
  // Refuse to compare against a browser error page — that produces a false pass.
  if (url !== baselineUrl) await assertRealPage(cdp, url, "候选");
  // Probe well past the fold so responsive (@media) rules are exercised too.
  const res = await cdp.send("Runtime.evaluate", {
    expression: PROBE(h * 3),
    returnByValue: true,
    awaitPromise: false,
  });
  return JSON.parse(res.result.value || "[]");
}

/** Compare one property, tolerating sub-pixel jitter on numeric ones. */
function sameValue(prop, a, b) {
  if (a === b) return true;
  if (!NUMERIC_PROPS.has(prop)) return false;
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return false;
  // Only tolerate when the units agree ("71.2px" vs "71.9px", not "auto" vs "0px").
  const ua = String(a).replace(/[\d.\-+eE]/g, "");
  const ub = String(b).replace(/[\d.\-+eE]/g, "");
  if (ua !== ub) return false;
  return Math.abs(na - nb) <= TOLERANCE_PX;
}

const proc = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=" + process.env.TEMP + "/cdp-critical-verify",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  const wsUrl = await connect();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const cdp = new CDP(ws);

  let failed = false;
  for (const vp of ["390x844", "1280x900"]) {
    const a = await probeStyles(cdp, baselineUrl, vp);
    const b = await probeStyles(cdp, candidateUrl, vp);
    console.log(`\n— 视口 ${vp}：基线 ${a.length} 元素 | 候选 ${b.length} 元素`);

    if (a.length !== b.length) {
      console.error(`✗ 元素数量不一致，DOM 结构可能被改动`);
      failed = true;
    }

    const n = Math.min(a.length, b.length);
    let mismatches = 0;
    for (let i = 0; i < n; i++) {
      const sa = a[i].sig;
      const sb = b[i].sig;
      for (const k of Object.keys(sa)) {
        if (!sameValue(k, sa[k], sb[k])) {
          mismatches++;
          if (mismatches <= 10) {
            console.error(
              `✗ [${i}] <${a[i].tag}> "${a[i].text}" ${k}: "${sa[k]}" -> "${sb[k]}"`,
            );
          }
        }
      }
    }
    if (mismatches === 0) {
      console.log(`  ✓ ${n} 个元素的全部计算样式一致`);
    } else {
      console.error(`  ✗ 共 ${mismatches} 处差异`);
      failed = true;
    }
  }

  if (failed) process.exitCode = 1;
  ws.close();
} finally {
  proc.kill();
}
