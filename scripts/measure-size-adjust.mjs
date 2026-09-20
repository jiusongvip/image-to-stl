#!/usr/bin/env node
/**
 * Measures the size-adjust value empirically, in the browser.
 *
 * Computing size-adjust from font files is fragile: `local("Segoe UI")` does not
 * necessarily resolve to the Segoe UI whose metrics we read from disk (headless
 * Chrome on Windows resolved it to a narrower face, 244.6px vs system-ui's
 * 264.3px for the same string). And the direction of the ratio is easy to invert.
 *
 * So measure instead of deriving: render the same string in the target family
 * and in the fallback family, and take target / fallback. That ratio is the
 * size-adjust that makes the two occupy the same width.
 *
 * Usage: node scripts/measure-size-adjust.mjs <indexUrl>
 *   Reads the target families and the `local()` candidates from src/styles/global.css.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/measure-size-adjust.mjs <indexUrl>");
  process.exit(2);
}

const PORT = 9281;
const PROFILE = `D:/tmp/sizeadjust-${randomBytes(3).toString("hex")}`;
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
      h[1] = 0x80 | body.length;
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

/**
 * A representative slice of the site's own copy, plus the full lowercase
 * alphabet so the number is not tuned to one sentence.
 */
const SAMPLES = [
  "abcdefghijklmnopqrstuvwxyz",
  "100% Browser-Based - No Uploads",
  "Export: STL + OBJ + GLB",
  "No Registration Required",
  "Real-Time 3D Preview",
  "Convert Image to STL Online -",
];

const measure = (target, fallback, weight) => `(() => {
  const samples = ${JSON.stringify(SAMPLES)};
  const mk = (fam) => {
    let total = 0;
    for (const text of samples) {
      const s = document.createElement('span');
      s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:100px;font-family:' + fam + ';font-weight:' + ${weight};
      s.textContent = text;
      document.body.appendChild(s);
      total += s.getBoundingClientRect().width;
      s.remove();
    }
    return total;
  };
  const t = mk(${JSON.stringify(target)});
  const f = mk(${JSON.stringify(fallback)});
  return JSON.stringify({ target: t, fallback: f, ratio: t / f, weight: ${weight} });
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

  // Load the target faces explicitly so they are available for measurement.
  await ws.send("Runtime.evaluate", {
    expression: `(async () => {
      const want = ['400 100px Geist','700 100px Geist','400 100px "Geist Mono"'];
      try { await Promise.all(want.map(f => document.fonts.load(f))); } catch {}
      await document.fonts.ready; return document.fonts.size;
    })()`,
    awaitPromise: true, returnByValue: true,
  });

  const cases = [
    { label: "Geist 400 / system-ui", target: "Geist", fallback: "system-ui", weight: 400 },
    { label: "Geist 400 / Segoe UI",  target: "Geist", fallback: '"Segoe UI"', weight: 400 },
    { label: "Geist 400 / Arial",     target: "Geist", fallback: "Arial", weight: 400 },
    { label: "Geist 700 / system-ui", target: "Geist", fallback: "system-ui", weight: 700 },
    { label: "Geist 700 / Segoe UI",  target: "Geist", fallback: '"Segoe UI"', weight: 700 },
    { label: "Geist Mono 400 / system-ui", target: '"Geist Mono"', fallback: "system-ui", weight: 400 },
    { label: "Geist Mono 400 / ui-monospace", target: '"Geist Mono"', fallback: "ui-monospace", weight: 400 },
  ];

  // The authoritative measurement.
  //
  // A @font-face with `src: local(...)` plus `size-adjust` composes: the browser
  // resolves local() to a REAL face, then scales it. So the ratio we need is
  // target / (that local face), NOT target / system-ui — they are different
  // fonts (measured 244.6px vs 264.3px for the same string), and using the
  // wrong denominator is what produced a value 12% off.
  //
  // We cannot read which local() face won. So solve for it: render the string
  // with the CURRENT size-adjust, and back out the base width
  // (measured / currentAdjust). Then the correct size-adjust is
  // target / base. This is self-calibrating and does not care which face won.
  const CURRENT = { "400": 97.19, "700": 97.43, mono: 115.61 };
  const solve = (target, family, weight, currentPct) => `(() => {
    const samples = ${JSON.stringify(SAMPLES)};
    const mk = (fam, wt) => {
      let total = 0;
      for (const text of samples) {
        const s = document.createElement('span');
        s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:100px;font-family:' + fam + ';font-weight:' + wt;
        s.textContent = text;
        document.body.appendChild(s);
        total += s.getBoundingClientRect().width;
        s.remove();
      }
      return total;
    };
    const t = mk(${JSON.stringify(target)}, ${weight});
    const m = mk(${JSON.stringify(family)}, ${weight});
    const base = m / (${currentPct} / 100);
    return JSON.stringify({
      target: t, measured: m, base,
      basePct: base / t * 100,
      needed: t / base * 100,
    });
  })()`;

  console.log("以 100px 字号测量同一组文案的总宽（6 个样本）\n");
  console.log("  — 直接比值（分母是 system-ui，仅供参考，不是要填的值）—");
  for (const c of cases) {
    const r = await ws.send("Runtime.evaluate", {
      expression: measure(c.target, c.fallback, c.weight),
      returnByValue: true,
    });
    const d = JSON.parse(r.result.value);
    console.log(
      `  ${c.label.padEnd(34)} target=${d.target.toFixed(1).padStart(8)}  ` +
        `fallback=${d.fallback.toFixed(1).padStart(8)}  ` +
        `ratio=${(d.ratio * 100).toFixed(2)}%`,
    );
  }

  console.log("\n  — 自校准求解（分母是 local() 实际选中的字体）—");
  const sol = [
    { label: "Geist Fallback w400", target: "Geist", family: '"Geist Fallback"', weight: 400, cur: CURRENT["400"] },
    { label: "Geist Fallback w700", target: "Geist", family: '"Geist Fallback"', weight: 700, cur: CURRENT["700"] },
    { label: "Geist Mono Fallback", target: '"Geist Mono"', family: '"Geist Mono Fallback"', weight: 400, cur: CURRENT.mono },
  ];
  const out = {};
  for (const s of sol) {
    const r = await ws.send("Runtime.evaluate", {
      expression: solve(s.target, s.family, s.weight, s.cur),
      returnByValue: true,
    });
    const d = JSON.parse(r.result.value);
    out[s.label] = d;
    console.log(
      `  ${s.label.padEnd(22)} target=${d.target.toFixed(1).padStart(8)}  ` +
        `当前实测=${d.measured.toFixed(1).padStart(8)}  ` +
        `反推 base=${d.base.toFixed(1).padStart(8)}  ` +
        `=> 应设 size-adjust: ${d.needed.toFixed(2)}%`,
    );
  }
  console.log("\n  粘贴进 src/styles/global.css 的值：");
  console.log(`    Geist Fallback w400  : ${out["Geist Fallback w400"].needed.toFixed(2)}%`);
  console.log(`    Geist Fallback w700  : ${out["Geist Fallback w700"].needed.toFixed(2)}%`);
  console.log(`    Geist Mono Fallback  : ${out["Geist Mono Fallback"].needed.toFixed(2)}%`);
  console.log(
    "\n  提示：改完 CSS 重建后再跑一次，needed 应稳定收敛到同一个值；" +
      "若两轮不一致说明 local() 解析到了不同字体。",
  );
  ws.close();
} finally {
  child.kill();
  await sleep(400);
  try {
    execFileSync("rm", ["-rf", PROFILE]);
  } catch {}
}
