// 构建后处理：把主样式表的 <link rel="preload" as="style"> 提升到 <head> 开头。
//
// 背景（2026-09-18 实测）：
// Astro 把编译后的 CSS <link> 放在 <head> 末尾，而它前面有一个约 5.6 KB 的
// 内联 JSON-LD schema 块。结果是浏览器必须先下载并解析约 9.5 KB HTML，
// 才开始请求这个 7 KB 的 CSS —— 移动端实测被记为 154 ms 渲染阻塞时间
// （`render-blocking-insight` 给出「Est savings of 410 ms」）。
//
// 做法：在 <head> 的极早位置插入一个 preload，**必须排在 JSON-LD 之前**。
// 之后浏览器解析到真正的 <link rel="stylesheet"> 时会复用同一响应，
// 不会重复下载。
//
// 为什么需要脚本而不是直接写在 BaseLayout.astro 里：
// CSS 文件名带构建哈希（如 about.CI1600t9.css），每次构建都会变。
// 硬编码会在某次内容改动后静默失效。本脚本在构建完成后读取真实文件名再注入。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const MARKER = "data-css-preload";

/** 找出 dist/_astro 下唯一的入口 CSS 文件（站点只有一个）。 */
function findMainCss() {
  const astroDir = join(DIST, "_astro");
  if (!existsSync(astroDir)) return null;
  const files = readdirSync(astroDir).filter((f) => f.endsWith(".css"));
  if (!files.length) return null;
  // 若未来出现多个，取体积最大的那个（即全站主样式表）
  let best = null;
  let bestSize = -1;
  for (const f of files) {
    const { size } = statSync(join(astroDir, f));
    if (size > bestSize) {
      bestSize = size;
      best = f;
    }
  }
  return best;
}

/** 递归收集所有 HTML 文件。 */
function collectHtml(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectHtml(p, out);
    else if (entry.name.endsWith(".html")) out.push(p);
  }
  return out;
}

const cssName = findMainCss();
if (!cssName) {
  console.warn("⚠ inject-css-preload: 未找到入口 CSS，跳过");
  process.exit(0);
}

const preloadTag = `<link rel="preload" as="style" href="/_astro/${cssName}" ${MARKER}>`;
const charsetAnchor = '<meta charset="UTF-8">';
const charsetAnchorAlt = '<meta charset="UTF-8" />';

/**
 * 把 JSON-LD 结构化数据块移到 </head> 之前。
 *
 * 背景：SeoHead 把约 5.6 KB 的 schema 内联在 <head> 中段（实测字节 4429–10067），
 * 而浏览器需要的 <link rel="stylesheet"> 排在它后面。移动端模拟慢速 4G 下，
 * 文档 21 KB 要传 219 ms，schema 占其中 27% —— 它把 CSS 的发现时间整体推后。
 *
 * schema 本身不需要在解析早期可见（爬虫读完整份 HTML），移到最后不影响 SEO，
 * 但能让样式表在更早的字节位置出现。
 *
 * @returns {string} 处理后的 HTML
 */
function hoistJsonLdToEnd(html) {
  const re = /<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g;
  const blocks = html.match(re);
  if (!blocks || !blocks.length) return html;

  const headEnd = html.lastIndexOf("</head>");
  if (headEnd === -1) return html;

  // 逐个移除，再统一插入到 </head> 前
  let stripped = html;
  for (const b of blocks) {
    stripped = stripped.replace(b, "");
  }
  const insertAt = stripped.lastIndexOf("</head>");
  return (
    stripped.slice(0, insertAt) +
    blocks.join("") +
    stripped.slice(insertAt)
  );
}

let patched = 0;
let already = 0;
let hoisted = 0;

for (const file of collectHtml(DIST)) {
  let html = readFileSync(file, "utf8");

  if (html.includes(MARKER)) {
    // 已注入（例如重复构建），先移除旧的再重新注入，保证哈希最新
    html = html.replace(new RegExp(`<link[^>]*${MARKER}[^>]*>`, "g"), "");
  }

  // 先把 schema 移到 </head> 前，再插 preload（否则 preload 会被算进 schema 之后）
  const before = html.indexOf('type="application/ld+json"');
  html = hoistJsonLdToEnd(html);
  const afterHoist = html.indexOf('type="application/ld+json"');
  if (before !== -1 && afterHoist !== before) hoisted++;

  // 插入点：<meta charset> 之后、一切其它内容之前。
  // charset 必须留在前 1024 字节内，所以不能用它当锚点之前的位置。
  let idx = html.indexOf(charsetAnchor);
  let len = charsetAnchor.length;
  if (idx === -1) {
    idx = html.indexOf(charsetAnchorAlt);
    len = charsetAnchorAlt.length;
  }
  if (idx === -1) {
    console.warn(`  ! ${file}: 未找到 <meta charset>，跳过`);
    continue;
  }

  // charset 紧跟 viewport，把 preload 放在 viewport 之后更符合常规顺序。
  const after = idx + len;
  const viewportIdx = html.indexOf('<meta name="viewport"', after);
  const insertAt = viewportIdx !== -1 && viewportIdx < after + 400
    ? html.indexOf(">", viewportIdx) + 1
    : after;

  if (html.includes(MARKER)) already++;
  html = html.slice(0, insertAt) + preloadTag + html.slice(insertAt);
  writeFileSync(file, html);
  patched++;
}

console.log(`✓ 主样式表 preload 已注入：${cssName}（${patched} 个 HTML）`);
console.log(`✓ JSON-LD schema 已移至 </head> 前（${hoisted} 个 HTML）`);

// 自校验：确认注入点确实早于 JSON-LD，且 charset 仍在前 1024 字节内
const sample = join(DIST, "index.html");
if (existsSync(sample)) {
  const d = readFileSync(sample, "utf8");
  const pre = d.indexOf(MARKER);
  const jsonld = d.indexOf('type="application/ld+json"');
  const charset = d.indexOf("charset=");
  const stylesheet = d.indexOf('rel="stylesheet"');
  const ok =
    pre !== -1 &&
    pre < jsonld &&
    pre < stylesheet &&
    charset < 1024;
  if (!ok) {
    console.error(
      `✗ 校验失败：preload@${pre} jsonld@${jsonld} stylesheet@${stylesheet} charset@${charset}`
    );
    process.exit(1);
  }
  console.log(
    `  校验通过：preload@${pre} < JSON-LD@${jsonld}，stylesheet@${stylesheet}，charset@${charset}(<1024)`
  );
}
