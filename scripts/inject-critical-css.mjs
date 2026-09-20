/**
 * Inline the above-the-fold CSS so the first paint needs no stylesheet request.
 *
 * Why this is safe here, and why it is NOT the same thing as inlining the whole
 * file (which was measured as a regression earlier and reverted):
 *
 *   Inlining everything cost 33.7 KB of document weight, pushed LCP from 3.4 s
 *   to 4.5 s, and slowed the document itself from 79 ms to 387 ms. The problem
 *   was the SIZE, not the technique.
 *
 *   This script inlines a much smaller subset: the Tailwind preflight (which is
 *   required or the layout collapses), the base element rules, and only those
 *   utility classes that actually appear in the document's above-the-fold
 *   markup. The rest of the stylesheet still loads, but non-blockingly, so it
 *   is out of the critical path.
 *
 * The result is verified before it is written: if the inlined CSS exceeds the
 * budget, or if the expected classes are missing, the script leaves the HTML
 * alone and reports. A silent failure here means unstyled content, so it is
 * better to skip than to guess.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const BUDGET = 14 * 1024; // inlined CSS must stay under this, in bytes
const ABOVE_FOLD_CHARS = 6000; // markup prefix treated as above the fold

function findMainCss() {
  const dir = join(DIST, "_astro");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
  if (!files.length) return null;
  let best = null;
  let bestSize = -1;
  for (const f of files) {
    const { size } = statSync(join(dir, f));
    if (size > bestSize) {
      bestSize = size;
      best = f;
    }
  }
  return best;
}

/** Split a stylesheet into top-level rules, keeping at-rule blocks intact. */
function splitRules(css) {
  const rules = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        rules.push(css.slice(start, i + 1));
        start = i + 1;
      }
    }
  }
  if (start < css.length) rules.push(css.slice(start));
  return rules.filter((r) => r.trim());
}

/** Extract class tokens used in the first `limit` characters of body markup. */
function aboveFoldClasses(html, limit) {
  const body = html.indexOf("<body");
  const seg = body === -1 ? html.slice(0, limit) : html.slice(body, body + limit);
  const set = new Set();
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(seg))) {
    for (const c of m[1].split(/\s+/)) {
      if (c) set.add(c);
    }
  }
  return set;
}

/**
 * Subset a @media block, keeping only the rules whose classes are used above
 * the fold. Responsive utilities such as `sm:px-6` live here, and skipping the
 * whole block would leave the above-the-fold layout wrong at tablet widths and
 * up, so these must be carried over rather than dropped.
 */
function subsetMediaBlock(block, classes) {
  const open = block.indexOf("{");
  const close = block.lastIndexOf("}");
  if (open === -1 || close === -1 || close <= open) return block;
  const condition = block.slice(0, open + 1);
  const inner = block.slice(open + 1, close);
  const kept = [];
  for (const rule of splitRules(inner)) {
    const braceAt = rule.indexOf("{");
    if (braceAt === -1) continue;
    const sel = rule.slice(0, braceAt);
    if (isAlwaysNeeded(sel) || mentionsAboveFoldClass(sel, classes)) kept.push(rule);
  }
  return kept.length ? condition + kept.join("") + "}" : "";
}

/** True if this rule is needed for first paint regardless of markup. */
function isAlwaysNeeded(selector) {
  const s = selector.trim();
  // Preflight / normalize: universal, element, and attribute selectors.
  if (s.startsWith("*")) return true;
  if (s.startsWith(":")) return true; // :root, :before, ::backdrop
  if (s.startsWith("html") || s.startsWith("body")) return true;
  if (/^[a-z]+(\[[^\]]*\])?(:|$)/i.test(s) && !s.startsWith(".")) return true;
  // Custom properties and theme tokens.
  if (s.includes("--tw-")) return true;
  return false;
}

/**
 * A utility rule is needed if any of its classes appear above the fold.
 *
 * Tailwind escapes special characters in compiled selectors, so a rule for the
 * markup token `p-1.5` is written `.p-1\.5`, `min-h-[100dvh]` becomes
 * `.min-h-\[100dvh\]`, `bg-surface-50/80` becomes `.bg-surface-50\/80`, and
 * variant rules keep an escaped prefix like `.sm\:py-20`.
 *
 * The reliable direction is therefore: strip every backslash out of the
 * selector to recover the literal token, then compare that against the markup.
 * A variant rule `.sm\:py-20` also matches a bare `py-20` usage, because the
 * token's own utility is what carries the declarations.
 */
function classTokensIn(selector) {
  const tokens = new Set();
  const re = /\.((?:\\.|[^\s,{:>+~()[\]#])+)/g;
  let m;
  while ((m = re.exec(selector))) {
    const raw = m[1];
    const literal = raw.replace(/\\/g, ""); // p-1\.5 -> p-1.5
    tokens.add(literal);
    // Variant rules: sm:py-20 / dark:hover:bg-x -> also offer the tail.
    const tail = literal.slice(literal.lastIndexOf(":") + 1);
    if (tail && tail !== literal) tokens.add(tail);
  }
  return tokens;
}

function mentionsAboveFoldClass(selector, classes) {
  const tokens = classTokensIn(selector);
  if (!tokens.size) return false;
  for (const t of tokens) {
    if (classes.has(t)) return true;
    // Tailwind's escaped form of a token, for safety.
    if (classes.has(t.replace(/[:./[\]]/g, (c) => "\\" + c))) return true;
  }
  return false;
}

function main() {
  const cssName = findMainCss();
  if (!cssName) {
    console.error("✗ 找不到主样式表，跳过关键 CSS 内联");
    return;
  }
  const cssPath = join(DIST, "_astro", cssName);
  const css = readFileSync(cssPath, "utf8");

  const indexHtml = join(DIST, "index.html");
  if (!existsSync(indexHtml)) {
    console.error("✗ dist/index.html 不存在，跳过关键 CSS 内联");
    return;
  }
  const html = readFileSync(indexHtml, "utf8");
  const classes = aboveFoldClasses(html, ABOVE_FOLD_CHARS);
  if (classes.size < 20) {
    console.error(`✗ 首屏仅解析出 ${classes.size} 个 class，疑似解析异常，跳过`);
    return;
  }

  const rules = splitRules(css);
  const critical = [];
  for (const rule of rules) {
    const braceAt = rule.indexOf("{");
    if (braceAt === -1) continue;
    const selector = rule.slice(0, braceAt);
    // Keep @font-face out of the inline block: it belongs with the stylesheet,
    // and the two above-the-fold faces are already preloaded in <head>.
    if (selector.trim().startsWith("@font-face")) continue;
    if (selector.trim().startsWith("@keyframes")) {
      if (/reveal|fade|spin/.test(selector)) critical.push(rule);
      continue;
    }
    if (selector.trim().startsWith("@media")) {
      const sub = subsetMediaBlock(rule, classes);
      if (sub) critical.push(sub);
      continue;
    }
    if (isAlwaysNeeded(selector) || mentionsAboveFoldClass(selector, classes)) {
      critical.push(rule);
    }
  }

  const inlined = critical.join("");
  const bytes = Buffer.byteLength(inlined, "utf8");
  if (bytes === 0 || bytes > BUDGET) {
    console.error(`✗ 关键 CSS 体积异常（${bytes} B，预算 ${BUDGET} B），跳过内联`);
    return;
  }

  let rewritten = 0;
  for (const file of readdirSync(DIST, { recursive: true })) {
    const p = join(DIST, String(file));
    if (!p.endsWith(".html")) continue;
    let doc = readFileSync(p, "utf8");
    if (doc.includes("data-critical-css")) continue;

    // The stylesheet link stays, but stops blocking: media="print" until load.
    const linkRe = new RegExp(
      `<link rel="stylesheet" href="/_astro/${cssName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`,
    );
    if (!linkRe.test(doc)) continue;

    // This page's own above-the-fold classes, not the homepage's.
    const pageClasses = aboveFoldClasses(doc, ABOVE_FOLD_CHARS);
    const pageRules = [];
    for (const rule of rules) {
      const braceAt = rule.indexOf("{");
      if (braceAt === -1) continue;
      const selector = rule.slice(0, braceAt);
      if (selector.trim().startsWith("@font-face")) continue;
      if (selector.trim().startsWith("@keyframes")) continue;
      if (selector.trim().startsWith("@media")) {
        const sub = subsetMediaBlock(rule, pageClasses);
        if (sub) pageRules.push(sub);
        continue;
      }
      if (isAlwaysNeeded(selector) || mentionsAboveFoldClass(selector, pageClasses)) {
        pageRules.push(rule);
      }
    }
    const pageCss = pageRules.join("");
    if (Buffer.byteLength(pageCss, "utf8") > BUDGET) continue;

    // Coverage self-check: every utility class used above the fold (with its
    // variant prefix stripped) must have a matching rule in the inline block.
    // A miss here means visibly unstyled above-the-fold content, so refuse to
    // write the file rather than ship it.
    const covered = new Set();
    const collect = (ruleset) => {
      for (const rule of ruleset) {
        const braceAt = rule.indexOf("{");
        if (braceAt === -1) continue;
        const sel = rule.slice(0, braceAt);
        if (sel.trim().startsWith("@media")) {
          const o = rule.indexOf("{");
          const c = rule.lastIndexOf("}");
          if (o !== -1 && c > o) {
            collect(splitRules(rule.slice(o + 1, c)));
          }
          continue;
        }
        for (const t of classTokensIn(sel)) covered.add(t);
      }
    };
    collect(pageRules);
    const uncovered = [];
    for (const cls of pageClasses) {
      const tail = cls.slice(cls.lastIndexOf(":") + 1);
      // Ignore tokens with no utility rule at all (e.g. a class the site
      // defines in its own component CSS, which the full sheet still covers).
      const existsInFullSheet = rules.some((r) => {
        const b = r.indexOf("{");
        return b !== -1 && classTokensIn(r.slice(0, b)).has(tail);
      });
      if (!existsInFullSheet) continue;
      if (!covered.has(tail)) uncovered.push(cls);
    }
    if (uncovered.length > 0) {
      console.error(
        `✗ ${p} 首屏有 ${uncovered.length} 个 class 未被内联 CSS 覆盖，放弃改写：\n   ` +
          uncovered.slice(0, 12).join(", "),
      );
      continue;
    }

    doc = doc.replace(
      linkRe,
      `<noscript><link rel="stylesheet" href="/_astro/${cssName}"></noscript>` +
        `<style data-critical-css>${pageCss}</style>` +
        `<link rel="stylesheet" href="/_astro/${cssName}" media="print" onload="this.media='all'">`,
    );
    writeFileSync(p, doc);
    rewritten++;
  }

  console.log(
    `✓ 关键 CSS 已内联：首页 ${bytes} B（预算 ${BUDGET} B），改写 ${rewritten} 个 HTML`,
  );

  // Final self-check: no page may keep a render-blocking stylesheet, and every
  // page that got the inline block must still carry the <noscript> fallback so
  // a JS-disabled visitor is not left with an unstyled document.
  //
  // <noscript> contents are stripped before looking for blocking links: a
  // <link> inside <noscript> is inert when JS is on, so it is not blocking.
  // Without this distinction the check reports a false positive on the
  // fallback we just inserted.
  const problems = [];
  let pagesWithCritical = 0;
  for (const file of readdirSync(DIST, { recursive: true })) {
    const p = join(DIST, String(file));
    if (!p.endsWith(".html")) continue;
    const doc = readFileSync(p, "utf8");
    const hasCritical = doc.includes("data-critical-css");
    if (hasCritical) pagesWithCritical++;
    const stripped = doc.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
    const blocking = stripped.match(/<link rel="stylesheet"[^>]*>/g) || [];
    for (const tag of blocking) {
      if (!/media=["']print["']/.test(tag)) {
        problems.push(`${p}: 仍有阻塞样式表 ${tag}`);
      }
    }
    if (hasCritical && !/<noscript><link rel="stylesheet"/.test(doc)) {
      problems.push(`${p}: 缺 <noscript> 样式表回退`);
    }
  }

  if (problems.length) {
    console.error(`\n✗ 内联后自检未通过（${problems.length} 项）：`);
    for (const p of problems.slice(0, 10)) console.error(`   - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  自检通过：${pagesWithCritical} 个页面已内联，全站无阻塞样式表，回退齐全`);
}

main();
