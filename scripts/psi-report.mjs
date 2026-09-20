#!/usr/bin/env node
/**
 * Summarise PageSpeed Insights API responses for this site.
 *
 * Reports the headline metrics plus the audits we actually act on: the
 * render-blocking insight, the LCP phase breakdown, and the benchmark index
 * that tells us whether a score change came from the site or from the machine.
 *
 * Usage: node scripts/psi-report.mjs <file.json> [more.json ...]
 */
import { readFileSync } from "node:fs";

const fmt = (v, digits = 2) => (v === undefined || v === null ? "n/a" : Number(v).toFixed(digits));

function audit(lhr, id) {
  return lhr.audits?.[id]?.numericValue;
}

function score(lhr, id) {
  // Category scores live under lighthouseResult.categories, not audits.
  const s = lhr.categories?.[id]?.score;
  return s === undefined || s === null ? "n/a" : (s * 100).toFixed(0);
}

for (const file of process.argv.slice(2)) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`${file}: 无法解析 (${err.message})`);
    continue;
  }
  if (data.error) {
    console.log(`${file}: API 错误 ${data.error.code} ${data.error.message}`);
    continue;
  }
  const lhr = data.lighthouseResult;
  if (!lhr) {
    console.log(`${file}: 无 lighthouseResult`);
    continue;
  }

  console.log(`\n===== ${file} =====`);
  console.log(`strategy     : ${lhr.configSettings?.formFactor}`);
  console.log(`benchmarkIdx : ${lhr.environment?.benchmarkIndex}  (越低=机器越慢)`);
  console.log(
    `Perf ${score(lhr, "performance")} | FCP ${fmt(audit(lhr, "first-contentful-paint") / 1000)}s` +
      ` | LCP ${fmt(audit(lhr, "largest-contentful-paint") / 1000)}s` +
      ` | SI ${fmt(audit(lhr, "speed-index") / 1000)}s` +
      ` | TBT ${fmt(audit(lhr, "total-blocking-time"))}ms` +
      ` | CLS ${fmt(audit(lhr, "cumulative-layout-shift"), 3)}`,
  );

  // Render-blocking: the audit the critical-CSS work targets.
  //
  // In Lighthouse 13 this is `render-blocking-insight`, whose savings live in
  // `metricSavings` (not `numericValue`, which is null) and whose offending
  // resources are `details.items`. A passing audit therefore shows score 1,
  // zero savings, and an EMPTY items array — so report the item count too,
  // otherwise "0 ms" is indistinguishable from "audit did not run".
  const rb = lhr.audits?.["render-blocking-insight"] || lhr.audits?.["render-blocking-resources"];
  if (rb) {
    const savings = rb.metricSavings || {};
    const items = rb.details?.items || [];
    console.log(
      `\nrender-blocking: score=${rb.score ?? "n/a"} ` +
        `FCP 省 ${fmt(savings.FCP || 0, 0)} ms / LCP 省 ${fmt(savings.LCP || 0, 0)} ms ` +
        `| 阻塞资源 ${items.length} 个`,
    );
    for (const item of items) {
      console.log(`   - ${item.url}  ${item.totalBytes ?? "?"} B`);
    }
  }

  // LCP phase breakdown: the four sub-phases must add up to the headline LCP.
  const lb = lhr.audits?.["lcp-breakdown-insight"];
  const phases = lb?.details?.items?.[0]?.items;
  if (phases) {
    const names = ["TTFB", "资源加载延迟", "资源加载耗时", "元素渲染延迟"];
    let sum = 0;
    console.log(`\nLCP 分解 (总 ${fmt(audit(lhr, "largest-contentful-paint") / 1000)}s):`);
    phases.forEach((p, i) => {
      sum += p.duration || 0;
      console.log(`   ${names[i] || p.phase}: ${fmt(p.duration)} ms`);
    });
    console.log(`   四段之和 ${fmt(sum)} ms`);
  }

  // Cloudflare-injected third-party weight, so we can see it is not ours.
  const legacy = lhr.audits?.["legacy-javascript-insight"];
  const legacyItems = legacy?.details?.items || [];
  if (legacyItems.length) {
    let cf = 0;
    let other = 0;
    for (const it of legacyItems) {
      const url = it.url || "";
      const w = it.wastedBytes || 0;
      if (url.includes("cloudflareinsights") || url.includes("beacon.min.js")) cf += w;
      else other += w;
    }
    console.log(
      `\nlegacy JS: 合计 ${fmt((cf + other) / 1024)} KiB ` +
        `(Cloudflare 注入 ${fmt(cf / 1024)} KiB, 其他 ${fmt(other / 1024)} KiB)`,
    );
  }
}
