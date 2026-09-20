#!/usr/bin/env node
/**
 * Run PageSpeed Insights N times against a live URL and write each raw JSON
 * response to a file, for summarising with scripts/psi-report.mjs.
 *
 * Shells out to curl rather than using Node's fetch: in this environment Node's
 * fetch cannot reach the PSI API at all ("fetch failed", proxy or not), while
 * curl through the local proxy works reliably.
 *
 * Two details this gets right that a hand-rolled shell loop gets wrong:
 *
 *   1. Cache busting. PSI keys its cache on the URL, so repeating the same URL
 *      returns the SAME lighthouseResult byte-for-byte — same fetchTime, same
 *      benchmarkIndex, same metrics. Three such "runs" are one measurement.
 *      A random query parameter forces a genuinely fresh run.
 *
 *   2. Failure honesty. curl reporting `http=200` alongside an empty body is a
 *      real failure mode here, and it reads as success if you only check the
 *      status code. Every response is parsed and validated instead, and a run
 *      that produced no usable lighthouseResult is reported as failed rather
 *      than quietly counted.
 *
 * Usage:
 *   node scripts/psi-run.mjs <url> <mobile|desktop> <count> <outPrefix>
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";

const KEY = "AIzaSyAxr1EClLvilyZBsw1i_cmdYPDtS8MdIDQ";
const PROXY = "http://127.0.0.1:7897";

const [url, strategy, countArg, outPrefix] = process.argv.slice(2);
if (!url || !strategy || !countArg || !outPrefix) {
  console.error("usage: node scripts/psi-run.mjs <url> <mobile|desktop> <count> <outPrefix>");
  process.exit(2);
}
const strategyUpper = strategy.toUpperCase();
const count = Number(countArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchPsi(apiUrl) {
  // -o writes the body; we read it back so a zero-byte body is detectable.
  const tmp = `${outPrefix}.tmp`;
  try {
    execFileSync(
      "curl",
      [
        "-s",
        "-x", PROXY,
        "-m", "180",
        "--retry", "2",
        "--retry-delay", "3",
        "-o", tmp,
        "-w", "%{http_code}",
        apiUrl,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (!existsSync(tmp)) return { ok: false, why: "curl 未写出任何响应体" };
    const text = readFileSync(tmp, "utf8");
    unlinkSync(tmp);
    if (!text.trim()) return { ok: false, why: "响应体为空" };
    return { ok: true, text };
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    return { ok: false, why: `curl 失败: ${e.message.slice(0, 100)}` };
  }
}

async function runOnce(i) {
  const bust = `${url}${url.includes("?") ? "&" : "?"}psi=${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const api =
    `https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed` +
    `?url=${encodeURIComponent(bust)}&strategy=${strategyUpper}&key=${KEY}`;

  const res = fetchPsi(api);
  if (!res.ok) return res;

  let data;
  try {
    data = JSON.parse(res.text);
  } catch (e) {
    return { ok: false, why: `JSON 解析失败: ${e.message}` };
  }
  if (data.error) {
    return { ok: false, why: `API 错误 ${data.error.code}: ${data.error.message}` };
  }
  if (!data.lighthouseResult) return { ok: false, why: "缺少 lighthouseResult" };

  const file = `${outPrefix}-${i}.json`;
  writeFileSync(file, res.text);

  // Lighthouse reports two families of metric side by side, and on this site
  // they disagree wildly — that disagreement is the single most useful signal
  // in the payload, so surface it instead of hiding it behind one number:
  //
  //   metrics.firstContentfulPaint / speedIndex / largestContentfulPaint
  //     = what Lighthouse *scores*. On mobile here it is nearly constant
  //       (FCP ~1670, LCP ~2251) regardless of how fast the page really was.
  //   metrics.observedFirstContentfulPaint / ...LargestContentfulPaint
  //     = what the trace actually saw. This swings 255ms .. 2309ms.
  //
  // A large, variable (reported - observed) gap means the score is being
  // driven by the measurement apparatus, not by the page. Never quote the
  // reported number alone.
  const m = data.lighthouseResult.audits?.metrics?.details?.items?.[0] || {};
  return {
    ok: true,
    file,
    fetchTime: data.lighthouseResult.fetchTime,
    benchmark: data.lighthouseResult.environment?.benchmarkIndex,
    perf: Math.round((data.lighthouseResult.categories?.performance?.score ?? 0) * 100),
    lcp: data.lighthouseResult.audits?.["largest-contentful-paint"]?.numericValue / 1000,
    si: data.lighthouseResult.audits?.["speed-index"]?.numericValue / 1000,
    cls: data.lighthouseResult.audits?.["cumulative-layout-shift"]?.numericValue,
    reportedFcp: m.firstContentfulPaint,
    observedFcp: m.observedFirstContentfulPaint,
    reportedLcp: m.largestContentfulPaint,
    observedLcp: m.observedLargestContentfulPaint,
    ttfb: m.timeToFirstByte,
  };
}

const results = [];
for (let i = 1; i <= count; i++) {
  let r = { ok: false, why: "unknown" };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      r = await runOnce(i);
    } catch (e) {
      r = { ok: false, why: e.message };
    }
    if (r.ok) break;
    await sleep(3000);
  }
  results.push(r);
  console.log(
    r.ok
      ? `run ${i}: OK   Perf=${r.perf}  LCP=${r.lcp?.toFixed(2)}s  SI=${r.si?.toFixed(2)}s  CLS=${r.cls?.toFixed(3)}  bench=${r.benchmark}\n` +
        `           报告 FCP=${Math.round(r.reportedFcp)}ms LCP=${Math.round(r.reportedLcp)}ms` +
        `  |  实测 FCP=${Math.round(r.observedFcp)}ms LCP=${Math.round(r.observedLcp)}ms` +
        `  |  TTFB=${Math.round(r.ttfb)}ms`
      : `run ${i}: FAIL ${r.why}`,
  );
  if (i < count) await sleep(4000);
}

const ok = results.filter((r) => r.ok);
console.log(`\n成功 ${ok.length}/${count} 次`);
if (ok.length) {
  const stamps = new Set(ok.map((r) => r.fetchTime));
  const bench = ok.map((r) => r.benchmark);
  console.log(
    `fetchTime 去重后 ${stamps.size} 个 ${stamps.size < ok.length ? "⚠ 有重复 = 命中缓存，数据不可用" : "✓ 均为独立测量"}`,
  );
  console.log(
    `benchmarkIndex ${bench.join(" / ")} ${
      Math.max(...bench) / Math.min(...bench) > 1.25 ? "⚠ 机器负载波动大，低分可能是噪声" : "✓ 稳定"
    }`,
  );
  const perf = ok.map((r) => r.perf).sort((a, b) => a - b);
  console.log(`Perf 排序: ${perf.join(" / ")}   中位数 ${perf[Math.floor(perf.length / 2)]}`);

  // The reported/observed split. See runOnce() for what these two families are.
  const rFcp = ok.map((r) => r.reportedFcp);
  const oFcp = ok.map((r) => r.observedFcp);
  const rLcp = ok.map((r) => r.reportedLcp);
  const oLcp = ok.map((r) => r.observedLcp);
  const spread = (a) => Math.max(...a) - Math.min(...a);
  console.log(
    `\n报告值离散度  FCP 极差 ${Math.round(spread(rFcp))}ms  LCP 极差 ${Math.round(spread(rLcp))}ms`,
  );
  console.log(
    `实测值离散度  FCP 极差 ${Math.round(spread(oFcp))}ms  LCP 极差 ${Math.round(spread(oLcp))}ms`,
  );
  if (spread(rLcp) < spread(oLcp) / 2 && spread(oLcp) > 400) {
    console.log(
      `⚠ 报告值几乎不随真实速度变化，而实测值波动 ${Math.round(spread(oLcp))}ms。\n` +
        `  这表示分数主要由测量装置决定，不是页面缺陷。评分数字不可单独引用。`,
    );
  }
}
if (ok.length < count) process.exitCode = 1;
