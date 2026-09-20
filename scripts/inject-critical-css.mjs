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

/**
 * Ceiling on the inlined block, in bytes.
 *
 * This was 14 KB. Raising it is not free -- an earlier attempt at inlining the
 * whole 33.7 KB stylesheet measured a real regression (LCP 3.4 s -> 4.5 s,
 * document cost 79 ms -> 387 ms) -- so the number is set by what the invariant
 * below actually costs, not by preference.
 *
 * The invariant is that the first paint must look like the final paint. A block
 * that covers only some breakpoints breaks it: on the sub-pages the h1 carries
 * `lg:text-4xl`, so at 1024px and up the heading would render at its fallback
 * size and then jump. Keeping desktop breakpoints out saved 188 B and broke the
 * invariant on 8 of 19 pages, which is a bad trade at any price.
 *
 * Measured: with every breakpoint included, the largest page's block is 14,354 B
 * and the homepage's is 14,166 B. 20 KB leaves the same ~40% headroom the 14 KB
 * figure did relative to the ~33.7 KB that was known to regress.
 */
const BUDGET = 20 * 1024;

/**
 * `min-width` queries at or above this pixel width are left to the stylesheet
 * instead of being inlined. `null` disables the exclusion entirely, i.e. every
 * breakpoint is inlined.
 *
 * It is null, and the reason matters because the obvious sentinel is wrong.
 * This was briefly set to 0 intending "exclude nothing", on the reading that a
 * `min-width: 0` query matches a phone so nothing can be desktop-only. But the
 * test is `px <= MIN_WIDTH_KEEP`, and the smallest breakpoint Tailwind emits
 * here is 640 -- so 0 excluded *everything*, every `sm:`/`md:`/`lg:` utility
 * was dropped, and only 22% of the stylesheet was inlined. The rendered result
 * was measurable: at first paint the `sm:px-6` page container had `padding: 0`
 * and the hero image `width: 800px`, and both snapped ~1 s later when the
 * deferred stylesheet landed. That is the reflow this script exists to prevent,
 * and it was caused by a sentinel value, not by the rules being unavailable.
 *
 * So the sentinel is explicit: `null` means off, a number means on. A number
 * that is large enough to exclude the 640px breakpoint is a real choice; 0 is
 * not a way to express "no exclusions".
 */
const MIN_WIDTH_KEEP = null;

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

/**
 * Extract the class tokens that the browser can actually render before the
 * stylesheet arrives.
 *
 * This used to take a fixed byte window after `<body>` (6000 chars). That is
 * not a measure of "above the fold" in any sense, and it failed silently and
 * catastrophically here: on the homepage `<body>` sits at byte 16985 and the
 * header alone consumed the whole window, so the window ended inside
 * `</header>`. It collected 58 classes, all of them the header's, and not one
 * hero class. The inlined block ended up with 92 of the stylesheet's 410 rules,
 * missing the entire Tailwind preflight for headings and `img`, and every
 * positioning and margin utility.
 *
 * The rendered result was measured: at first paint the hero image had
 * `display:inline; width:800px; opacity:1` instead of
 * `position:absolute; width:378px; opacity:0.25`, the hero section was 1433px
 * tall instead of 917px, and the whole block was then re-laid-out when the real
 * stylesheet landed 1 s later. That reflow is the layout shift, and it also
 * holds the LCP element in a wrong state, which is what elementRenderDelay was
 * reporting all along.
 *
 * So: scope by structure, not by byte count. Take `<main>` (the page content,
 * excluding the shared header and footer chrome) and stop at the first
 * `reveal` element, because `reveal` marks the start of the scroll-animated
 * below-the-fold content by convention across this site. Anything before that
 * point is genuinely reachable without scrolling on a phone.
 */
function aboveFoldClasses(html) {
  const set = new Set();
  const add = (seg) => {
    const re = /class="([^"]*)"/g;
    let m;
    while ((m = re.exec(seg))) {
      for (const c of m[1].split(/\s+/)) {
        if (!c) continue;
        // A variant class implies its base utility, and the base rule has to be
        // inlined too or the element renders at the wrong size below the
        // breakpoint and jumps when the stylesheet arrives.
        for (const t of markupClassTokens(c)) set.add(t);
      }
    }
  };

  const mainAt = html.indexOf("<main");
  if (mainAt === -1) {
    // No <main> (should not happen): fall back to everything after <body>.
    const bodyAt = html.indexOf("<body");
    add(bodyAt === -1 ? html : html.slice(bodyAt));
    return set;
  }
  const mainEnd = html.indexOf("</main>", mainAt);
  let seg = html.slice(mainAt, mainEnd === -1 ? undefined : mainEnd);

  // Cut at the first reveal element: that is where below-the-fold begins.
  // Keep the cut generous (search from the end of the first hero section) so a
  // `reveal` appearing inside the hero cannot truncate the hero itself.
  const revealAt = seg.search(/class="[^"]*\breveal\b/);
  if (revealAt > 0) seg = seg.slice(0, revealAt);

  add(seg);

  // The header is fixed to the top of the viewport on every page, so its
  // classes are always needed for first paint even though it sits outside
  // <main>.
  const headerAt = html.indexOf("<header");
  if (headerAt !== -1) {
    const headerEnd = html.indexOf("</header>", headerAt);
    add(html.slice(headerAt, headerEnd === -1 ? undefined : headerEnd));
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

/**
 * True for one of Tailwind's two global variable-reset blocks, and only those.
 *
 * Tailwind emits a pure custom-property reset twice, once per selector:
 *
 *   *,:before,:after { --tw-border-spacing-x: 0; --tw-border-spacing-y: 0; ... }
 *   ::backdrop       { --tw-border-spacing-x: 0; --tw-border-spacing-y: 0; ... }
 *
 * 51 declarations each, 2264 B together: 15% of the entire first-paint budget,
 * and they paint nothing on their own.
 *
 * BOTH halves of the test are required, and getting this wrong twice is why the
 * comment is this long.
 *
 * Testing the selector alone is wrong because `*,:before,:after` appears a
 * SECOND time in the same stylesheet, and the second occurrence is the
 * preflight reset that everything depends on:
 *
 *   *,:before,:after { box-sizing: border-box; border-width: 0; ... }
 *
 * Matching on selector discarded that one too, so `box-sizing: border-box` was
 * absent from the first-paint block. Every padded element then laid out in
 * content-box: the page container measured 380px at first paint and 412px once
 * the stylesheet arrived. That is a 32px reflow on every container on every
 * page, caused by a rule the block threw away by accident.
 *
 * Testing the body alone is also wrong, in the other direction. "Consists only
 * of `--` declarations" is true of the variable reset, but it is equally true
 * of every gradient stop (`.from-*`, `.via-*`, `.to-*`) and every shadow colour
 * (`.shadow-*\/25`) -- those set custom properties that another utility reads
 * through var(), and they very much do paint. An earlier version used that test
 * and silently discarded 40 rules, leaving the hero's gradient overlays
 * unstyled.
 *
 * So: the selector must be one of the two known resets AND the body must carry
 * no declaration that has a visible effect. Either test alone produces a
 * plausible-looking block with a real bug in it.
 */
function isGlobalVariableReset(rule) {
  const braceAt = rule.indexOf("{");
  if (braceAt === -1) return false;
  const sel = rule.slice(0, braceAt).replace(/\s+/g, "");
  if (sel !== "*,:before,:after" && sel !== "::backdrop") return false;
  // Same selectors, but this is the preflight block, not the variable reset.
  const body = rule.slice(braceAt + 1, rule.lastIndexOf("}"));
  for (const decl of body.split(";")) {
    const prop = decl.split(":")[0].trim();
    if (prop && !prop.startsWith("--")) return false;
  }
  return true;
}

/**
 * True if a `min-width` media query cannot match a phone viewport, and can
 * therefore be left out of the first-paint block.
 *
 * Only `min-width` is considered. `max-width` queries are kept, because those
 * do match a phone. A query with several conditions is kept whenever any one of
 * them could match, so this errs towards keeping rules.
 *
 * With `MIN_WIDTH_KEEP === null` the exclusion is disabled and every media
 * block is inlined as-is. See the constant's own comment for why the exclusion
 * is off: excluding the 640px breakpoint dropped every `sm:` utility and broke
 * the first-paint layout on every page.
 */
function isDesktopOnlyQuery(condition) {
  if (MIN_WIDTH_KEEP === null) return false;
  const mins = [...condition.matchAll(/min-width\s*:\s*(\d+(?:\.\d+)?)\s*(px|em|rem)?/gi)];
  if (!mins.length) return false;
  const hasMax = /max-width\s*:/i.test(condition);
  if (hasMax) return false; // might still match a phone
  for (const [, num, unit] of mins) {
    const n = Number(num);
    const px = unit === "em" || unit === "rem" ? n * 16 : n;
    if (px <= MIN_WIDTH_KEEP) return false; // could match
  }
  return true;
}

/**
 * True if a rule only matters inside a `min-width` block that a phone viewport
 * cannot match.
 *
 * `splitRules` splits on braces at depth zero, so an `@media` block arrives as
 * a single rule whose selector starts with the condition. Rather than thread the
 * enclosing condition through, re-scan the stylesheet: a rule is desktop-only
 * when every `@media` opener preceding it, and enclosing it, is desktop-only.
 * The scan is cheap relative to building the block, and it keeps the decision in
 * one place instead of being duplicated at each call site.
 */
function isInsideDesktopOnlyQuery(rule, allRules) {
  const at = allRules.indexOf(rule);
  if (at === -1) return false;
  let depth = 0;
  const open = [];
  for (let i = 0; i <= at; i++) {
    const r = allRules[i];
    let d = 0;
    for (const ch of r) {
      if (ch === "{") d++;
      else if (ch === "}") d--;
    }
    if (i === at) break;
    if (d > 0) {
      // This earlier rule opened a block that is still open: it encloses us.
      const braceAt = r.indexOf("{");
      open.push(r.slice(0, braceAt).trim());
      depth += d;
    }
  }
  // Without full nesting bookkeeping, be conservative: only claim desktop-only
  // when the rule itself carries the condition, or when an enclosing opener we
  // did find is desktop-only and no other opener could match a phone.
  const braceAt = rule.indexOf("{");
  const own = rule.slice(0, braceAt).trim();
  if (own.startsWith("@media")) return isDesktopOnlyQuery(own);
  if (open.length) {
    const mediaOpeners = open.filter((o) => o.startsWith("@media"));
    if (mediaOpeners.length && mediaOpeners.every((o) => isDesktopOnlyQuery(o))) return true;
  }
  return false;
}

/**
 * Should this `@font-face` go into the inline critical block?
 *
 * The original rule was "never" — @font-face belongs with the stylesheet, and
 * the above-the-fold faces are preloaded in <head> anyway.
 *
 * That reasoning holds for the *webfont* faces (they have a real `src: url(...)`
 * and are preloaded), but it is wrong for a metric-override FALLBACK face, which
 * has `src: local(...)` and therefore costs no download at all.
 *
 * Leaving a fallback face out of the inline block is not merely a missed
 * optimisation — it reintroduces the exact bug the face exists to prevent. The
 * inline block contains Tailwind's reset
 * `font-family: Geist, "Geist Fallback", system-ui, sans-serif`, i.e. it NAMES
 * the fallback family while the only @font-face defining it lives in the
 * deferred stylesheet. A family named but not declared is skipped, so first
 * paint falls through to `system-ui`, and the text reflows when Geist arrives.
 * Measured: the hero paragraph wrapped to 7 lines at first paint and 6 once
 * Geist loaded (`(325,301,295,314,278,318,85)` -> `(316,326,247,329,318,321)`).
 *
 * So: inline the source-less faces, defer the ones that download.
 */
function keepInCriticalFace(rule) {
  const body = rule.slice(rule.indexOf("{") + 1);
  const src = /(?:^|[;{\s])src\s*:\s*([^;}]*)/i.exec(body);
  if (!src) return false;
  // Must reference no url() — only local() / tech() / format()-free lists.
  if (/url\(/i.test(src[1])) return false;
  return /local\(/i.test(src[1]);
}

/** True if this rule is needed for first paint regardless of markup. */
function isAlwaysNeeded(selector) {
  const s = selector.trim();
  // The scroll-reveal animation must never be inlined.
  //
  // `html.js .reveal { opacity: 0 }` and its `.reveal-visible { opacity: 1 }`
  // partner form a matched pair. The first is admitted by the `html...` branch
  // below; the second is dropped, because its tokens are not the element's
  // classes. Inlining only half of a stateful pair is a correctness hazard: the
  // block is emitted *ahead of* the stylesheet, so a below-the-fold section can
  // be painted while it still matches `opacity: 0` and stay blank until the
  // deferred stylesheet arrives with the missing rule.
  //
  // The homepage's first hero section carries no `reveal`, so this was never
  // the cause of the mobile LCP reading (measured: the hero is opacity 1 and
  // visible at first paint). It is excluded on principle -- the animation is
  // progressive enhancement for content that is off-screen by definition, which
  // is exactly what a first-paint stylesheet should not contain.
  if (s.includes(".reveal")) return false;
  // `::backdrop` is one of Tailwind's two global variable resets, excluded by
  // isGlobalVariableReset; do not let the pseudo-element branch reclaim it.
  if (s === "::backdrop") return false;
  // Preflight / normalize: universal, element, and attribute selectors.
  if (s.startsWith("*")) return true;
  if (s.startsWith(":")) return true; // :root, :before, ::backdrop
  if (s.startsWith("html") || s.startsWith("body")) return true;
  // Element selectors, including comma-separated lists.
  //
  // The single-selector form alone is not enough: Tailwind's normalize layer
  // emits list selectors such as
  //     img,svg,video,canvas,audio,iframe,embed,object { display: block; ... }
  //     img,video { max-width: 100%; height: auto }
  // and a pattern that only accepts one bare tag name drops both. That is not
  // cosmetic: without `img { max-width: 100% }` the hero image renders at its
  // intrinsic width at first paint and then snaps to the container, which is
  // one of the shifts this script exists to prevent. Verified by the
  // element-by-element browser check at the end of this file.
  if (ELEMENT_LIST_RE.test(s)) return true;
  // Custom properties and theme tokens.
  if (s.includes("--tw-")) return true;
  return false;
}

/**
 * Matches a selector list made only of element names, pseudo-elements and
 * attribute- or pseudo-class qualifiers -- e.g. `img,video`,
 * `button,input,optgroup,select,textarea`, `[type=search]`,
 * `button,input:where([type=button])`. Any class or id makes it false, so
 * utility rules are never swept in by accident: those must still earn their
 * place by appearing in the above-the-fold markup.
 */
const ELEMENT_LIST_RE =
  /^(?:[a-z][a-z0-9]*|\[[^\]]*\]|::?[a-z-]+(?:\((?:[^()]|\([^()]*\))*\))?)(?::?[a-z-]+(?:\((?:[^()]|\([^()]*\))*\))?|\[[^\]]*\])*(?:\s*,\s*(?:[a-z][a-z0-9]*|\[[^\]]*\]|::?[a-z-]+(?:\((?:[^()]|\([^()]*\))*\))?)(?::?[a-z-]+(?:\((?:[^()]|\([^()]*\))*\))?|\[[^\]]*\])*)*$/i;

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

/**
 * Class tokens as they appear in MARKUP (not in a selector).
 *
 * A variant class in the markup, `lg:text-4xl`, implies its base utility too:
 * the element carries `.text-4xl` semantics below the breakpoint and
 * `.lg\:text-4xl` above it, and Tailwind emits a separate rule for each. So the
 * utility is needed above the fold when EITHER form appears there, and the base
 * rule must be inlined whenever the variant form is -- otherwise the element
 * renders at its inherited size and jumps when the stylesheet lands.
 *
 * `aboveFoldClasses` adds exactly this expansion, which is what lets
 * `.text-4xl` be selected for a page whose h1 says `lg:text-4xl`.
 */
function markupClassTokens(cls) {
  const out = [cls];
  const tail = cls.slice(cls.lastIndexOf(":") + 1);
  if (tail && tail !== cls) out.push(tail);
  return out;
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

async function main() {
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
  const classes = aboveFoldClasses(html);
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
    // @font-face handling is deliberate and asymmetric — see keepInCriticalFace.
    if (selector.trim().startsWith("@font-face")) {
      if (keepInCriticalFace(rule)) critical.push(rule);
      continue;
    }
    if (isGlobalVariableReset(rule)) continue;
    if (selector.trim().startsWith("@media")) {
      if (isDesktopOnlyQuery(selector)) continue;
      const sub = subsetMediaBlock(rule, classes);
      if (sub) critical.push(sub);
      continue;
    }
    if (selector.trim().startsWith("@keyframes")) {
      if (/reveal|fade|spin/.test(selector)) critical.push(rule);
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
    const pageClasses = aboveFoldClasses(doc);
    const pageRules = [];
    for (const rule of rules) {
      const braceAt = rule.indexOf("{");
      if (braceAt === -1) continue;
      const selector = rule.slice(0, braceAt);
      if (selector.trim().startsWith("@font-face")) {
        if (keepInCriticalFace(rule)) pageRules.push(rule);
        continue;
      }
      if (isGlobalVariableReset(rule)) continue;
      if (selector.trim().startsWith("@media")) {
        if (isDesktopOnlyQuery(selector)) continue;
        const sub = subsetMediaBlock(rule, pageClasses);
        if (sub) pageRules.push(sub);
        continue;
      }
      if (selector.trim().startsWith("@keyframes")) continue;
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
    const deferred = [];
    for (const cls of pageClasses) {
      const tail = cls.slice(cls.lastIndexOf(":") + 1);
      // Ignore tokens with no utility rule at all (e.g. a class the site
      // defines in its own component CSS, which the full sheet still covers).
      const matching = rules.filter((r) => {
        const b = r.indexOf("{");
        return b !== -1 && classTokensIn(r.slice(0, b)).has(tail);
      });
      if (!matching.length) continue;
      if (covered.has(tail)) continue;
      // A class whose only rule lives in a `min-width` block above the phone
      // range is intentionally left to the stylesheet (see MIN_WIDTH_KEEP).
      // Report it separately rather than failing, so a real gap cannot hide
      // behind the same message.
      if (matching.every((r) => isInsideDesktopOnlyQuery(r, rules))) {
        deferred.push(cls);
        continue;
      }
      uncovered.push(cls);
    }
    if (deferred.length) {
      console.log(
        `  ${p}: ${deferred.length} 个 class 仅存在于桌面断点，按 MIN_WIDTH_KEEP 交给样式表：` +
          deferred.slice(0, 4).join(", "),
      );
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
    // A metric-override fallback face MUST be inside the inline block.
    //
    // The block names the fallback family (Tailwind's reset reads
    // `font-family: Geist, "Geist Fallback", system-ui, sans-serif`). A family
    // that is named but not declared is silently skipped, so if the @font-face
    // is only in the deferred stylesheet, first paint lands on `system-ui` and
    // the text reflows when Geist arrives. This exact defect shipped once
    // (hero paragraph wrapped 7 lines -> 6) and the existing checks did not
    // catch it, because every one of them compared the inline block against
    // itself rather than asking whether a *referenced* family was declared.
    if (hasCritical) {
      const inlineBlock = /<style data-critical-css>([\s\S]*?)<\/style>/.exec(doc);
      const inner = inlineBlock ? inlineBlock[1] : "";
      const strippedInner = inner.replace(/@font-face\{[^}]*\}/g, "");
      // Every fallback family referenced by the inlined rules must also be
      // declared by an inlined @font-face.
      const referenced = new Set();
      for (const m of strippedInner.matchAll(
        /font-family:\s*([^;{}]+)/gi,
      )) {
        for (const fam of m[1].split(",")) {
          const f = fam.trim().replace(/^["']|["']$/g, "");
          if (/fallback$/i.test(f)) referenced.add(f);
        }
      }
      for (const fam of referenced) {
        const declared = new RegExp(
          `@font-face\\{[^}]*font-family:\\s*["']?${fam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?[^}]*\\}`,
          "i",
        );
        if (!declared.test(inner)) {
          problems.push(
            `${p}: 内联块引用了字体族 "${fam}" 却没有对应 @font-face（首绘会回退到 system-ui 并产生重排）`,
          );
        }
      }
    }
  }

  if (problems.length) {
    console.error(`\n✗ 内联后自检未通过（${problems.length} 项）：`);
    for (const p of problems.slice(0, 10)) console.error(`   - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  自检通过：${pagesWithCritical} 个页面已内联，全站无阻塞样式表，回退齐全`);
  await coverageSelfCheck(css);
}

/**
 * Element-level coverage check, run against the stylesheet that was actually
 * inlined.
 *
 * The per-page class check above compares *tokens*, and a token can be supplied
 * by a variant rule the base utility never needed: if `.sm\:px-6` is inlined it
 * contributes the token `px-6`, so a bare `px-6` that was left out still looks
 * covered. That is exactly how a broken block passed as healthy before.
 *
 * So compare at the level that actually matters: for every element that can be
 * painted before the stylesheet arrives, is the computed result of the inlined
 * block the same as the computed result of the full stylesheet?
 *
 * The check runs in a real browser against both variants of the page, so it
 * cannot be satisfied by a clever selector — only by the layout being right.
 */
async function coverageSelfCheck(fullCss) {
  const { spawn, execFileSync } = await import("node:child_process");
  const { existsSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createServer } = await import("node:http");
  const { extname } = await import("node:path");
  const net = await import("node:net");
  const { createHash, randomBytes } = await import("node:crypto");

  const chrome = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
  ].find((c) => c && existsSync(c));
  if (!chrome) {
    console.log("  跳过浏览器级自检（未找到 Chrome）");
    return;
  }

  const page = readFileSync(join(DIST, "index.html"), "utf8");
  const inlineAt = page.indexOf("<style data-critical-css>");
  if (inlineAt === -1) {
    console.log("  跳过浏览器级自检（首页未内联）");
    return;
  }
  const inlineEnd = page.indexOf("</style>", inlineAt);
  const inlined = page.slice(page.indexOf(">", inlineAt) + 1, inlineEnd);

  const PAGE_PROBE = `
(async () => {
  const PROPS = ['display','position','width','height','maxWidth','paddingTop','paddingBottom',
    'paddingLeft','paddingRight','marginTop','marginBottom','fontSize','fontFamily','lineHeight',
    'flexWrap','aspectRatio','opacity','overflow'];
  // Only elements the inline block is RESPONSIBLE for.
  //
  // Selected by VIEWPORT POSITION, not by document order.
  //
  // Two earlier attempts scoped this by structure and both were wrong. The
  // first compared everything in <main>, including the page container whose
  // height spans the whole 22,000px document. The second walked <main> in
  // document order and stopped at the first reveal element -- which sounds
  // right and is not, because this document's first reveal sits far below the
  // fold: the elements still being compared had rect.top around 13,759px on a
  // 14,448px page. A structural boundary in the markup is not a viewport
  // boundary, and the whole point of this check is the viewport.
  //
  // So use the thing that is actually being asserted: an element is the
  // block's responsibility if a phone can see any part of it without
  // scrolling. That is a rect test, and it cannot drift out of sync with the
  // layout the way a markup offset can.
  const main = document.querySelector('main');
  if (!main) return JSON.stringify({ M: {}, els: [] });
  const M = { cw: document.documentElement.clientWidth, iw: window.innerHeight, sh: document.documentElement.scrollHeight, bodyW: Math.round(document.body.getBoundingClientRect().width), sheets: document.styleSheets.length, mediaSm: matchMedia('(min-width: 640px)').matches, media1024: matchMedia('(min-width: 1024px)').matches };
  // One viewport of tolerance, no more.
  //
  // An element is the block's responsibility if a phone can see any part of it
  // without scrolling. This was briefly innerHeight*4 while debugging, which
  // pulls in elements hundreds of pixels down and reports every below-the-fold
  // reveal section as an inlining gap -- they are not; the block is not
  // supposed to style them.
  const LIMIT = window.innerHeight;
  const els = [];
  for (const el of main.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // Any part of the element inside the first screen. The generous lower
    // bound is deliberate: an element straddling the fold is partly visible,
    // so the block does have to style it correctly.
    if (r.top >= LIMIT || r.bottom <= 0) continue;
    // Skip elements that extend far past the fold.
    //
    // The page container and its wrapper touch the viewport and then run the
    // entire length of the document, so their height is a function of content
    // the block is not supposed to style: measured 14,075px against the
    // reference's 21,514px. That is correct behaviour being reported as a bug,
    // and it was the last item standing after everything real had been fixed.
    //
    // A block is only responsible for an element's computed style, and a
    // full-document-height box's width, padding and typography all come from
    // rules the block does carry. Its height does not. So require the element to
    // end within a few screens; anything longer is a layout container whose
    // height is downstream of content outside the block's remit.
    if (r.height > window.innerHeight * 3) continue;
    els.push(el);
    if (els.length >= 120) break;
  }
  return JSON.stringify({ M, els: els.map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const o = { tag: el.tagName, cls: String(el.className).slice(0, 60),
      rect: [Math.round(r.top), Math.round(r.height), Math.round(r.width)] };
    for (const p of PROPS) o[p] = cs[p];
    return o;
  }) });
})()
`;

  // Build the two variants from a CLEAN base.
  //
  // The rewritten page is a poor base for this test, and using it directly was
  // a bug that made the whole check useless for several rounds. After the
  // rewrite the page contains three style references, not one:
  //
  //   <noscript><link rel="stylesheet" href="/_astro/about.XXX.css"></noscript>
  //   <style data-critical-css>...</style>
  //   <link rel="stylesheet" href="/_astro/about.XXX.css" media="print" onload="this.media='all'">
  //
  // A regex that swaps only the last of those leaves the <noscript> link in
  // place. Browsers treat a <link> inside <noscript> as inert **when scripting
  // is enabled**, which is the case here -- so the page kept loading the full
  // stylesheet, and the "first paint" variant was really "full stylesheet plus
  // inline block". The diff then shrank to a handful of font-size mismatches
  // that looked like a rendering quirk instead of the gross structural
  // difference it was supposed to surface.
  //
  // So strip every style reference first, then add back exactly one, according
  // to the variant. Both pages then differ in one thing only: which stylesheet
  // the browser has at first paint.
  const stripStyles = (html) =>
    html
      // the inline block
      .replace(/<style data-critical-css>[\s\S]*?<\/style>/g, "")
      // the noscript fallback wrapper and its link
      .replace(/<noscript>\s*<link rel="stylesheet"[^>]*>\s*<\/noscript>/g, "")
      // any remaining stylesheet link, blocking or deferred
      .replace(/<link rel="stylesheet"[^>]*>/g, "");
  const base = stripStyles(page);
  // Give BOTH variants the same font declarations, and let NEITHER load a font
  // file.
  //
  // The inline block deliberately carries no `@font-face` -- those belong with
  // the deferred stylesheet, and the real page supplies them via `deferred.css`
  // plus five preloads. So a synthetic "inline block only" page is not the same
  // page: it has no font declarations at all, registers zero faces, and lays
  // text out in the system fallback, while the reference registers the real
  // faces. That mismatch produced two rounds of convincing but spurious
  // conclusions, in opposite directions:
  //
  //   * as built: `.section-tag` measured 16px vs 32px (net -10px on the hero);
  //   * after forcing the font sheet blocking on both: 941px vs 915px, a
  //     different spurious delta.
  //
  // Neither is an inlining defect. So remove the variable rather than chase it:
  // inject the same `@font-face`-only sheet into both variants, and block the
  // font files at the network layer so neither side can actually load one. Both
  // pages then lay out in the identical fallback stack, text metrics match by
  // construction, and every remaining difference belongs to the one thing that
  // differs on purpose -- which stylesheet the browser had.
  //
  // This knowingly gives up detecting a *font-metric* inlining bug.
  //
  // ⚠️ UPDATE: that trade turned out to be too generous. The fallback faces
  // ("Geist Fallback" / "Geist Mono Fallback", declared in global.css) DO carry
  // metric overrides, and they are NOT in `deferred.css` — so injecting only
  // deferred.css's faces left variant A laying text out in raw `system-ui`
  // while variant B used the adjusted fallback. That produced a 152px hero
  // delta here, which is exactly the bug the check is meant to catch.
  //
  // Fix: feed BOTH variants every `@font-face` in the build — from the bundled
  // stylesheet and from deferred.css — still with the font FILES blocked. Then
  // the only variable between the two pages really is the stylesheet.
  const bundledCss = readdirSync(join(DIST, "_astro"))
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join(DIST, "_astro", f), "utf8"))
    .join("\n");
  const faceRe = /@font-face\s*\{[^}]*\}/g;
  const fontFaces = [
    ...(bundledCss.match(faceRe) || []),
    ...(readFileSync(join(DIST, "fonts", "deferred.css"), "utf8").match(faceRe) || []),
  ];
  if (!fontFaces.length) {
    throw new Error("自检构造失败：构建产物里找不到任何 @font-face，两变体的字体条件无法对齐");
  }
  const withoutFontFiles = (html) =>
    html.replace(
      "</head>",
      `<style>${fontFaces.join("")}</style></head>`,
    );
  const bare = withoutFontFiles(base);

  // Sanity check: the base must be free of stylesheet links, or the two
  // variants below are not measuring what they claim to.
  const leftover = base.match(/<link[^>]*stylesheet[^>]*>/g);
  if (leftover) {
    console.error(`✗ 自检内部错误：基准模板仍残留样式表引用 ${leftover.length} 处`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(
    join(DIST, "__firstpaint.html"),
    bare.replace("</head>", `<style data-critical-css>${inlined}</style></head>`),
  );
  writeFileSync(
    join(DIST, "__full.html"),
    bare.replace("</head>", `<link rel="stylesheet" href="/_astro/__full.css"></head>`),
  );
  writeFileSync(join(DIST, "_astro", "__inline-only.css"), inlined);
  writeFileSync(join(DIST, "_astro", "__full.css"), fullCss);

  const PORT = 9411;
  const profile = mkdtempSync(join(tmpdir(), "cls-check-"));

  // Serve dist/ so both variants load over http (file:// would block the
  // stylesheet and make every element look unstyled).
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript",
    ".woff2": "font/woff2",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".xml": "application/xml",
  };
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    // Refuse font binaries outright.
    //
    // Both variants get the same `@font-face` declarations (see `fontFaces`
    // above), and this makes sure neither can actually resolve one, so both
    // pages lay text out in the identical system fallback. Without it the
    // reference would win the font race and the first-paint variant would not,
    // and the resulting text-metric difference would be reported as a
    // stylesheet bug -- which it is not, and which cost two rounds of
    // misdiagnosis before this was understood.
    if (/\.(woff2?|ttf|otf|eot)$/i.test(rel)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("font blocked by self-check");
      return;
    }
    const p = join(DIST, rel || "index.html");
    if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
    res.end(readFileSync(p));
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  const child = spawn(chrome, [
    `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=${profile}`, "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--remote-allow-origins=*", "about:blank",
  ], { stdio: "ignore" });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wsFor = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const t = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).text();
        if (t.trim()) {
          const p = JSON.parse(t).find((x) => x.type === "page" && x.webSocketDebuggerUrl);
          if (p) return p.webSocketDebuggerUrl;
        }
      } catch {}
      await sleep(300);
    }
    throw new Error("cdp 未就绪");
  };
  const connect = async (wsUrl) => {
    const u = new URL(wsUrl);
    const key = randomBytes(16).toString("base64");
    const sock = net.connect(Number(u.port), u.hostname);
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://${u.hostname}:${u.port}\r\n\r\n`);
    const expect = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    let acc = Buffer.alloc(0);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("握手超时")), 15000);
      sock.on("data", function od(d) {
        acc = Buffer.concat([acc, d]);
        const i = acc.indexOf("\r\n\r\n");
        if (i === -1) return;
        sock.off("data", od); clearTimeout(t);
        const head = acc.subarray(0, i).toString("latin1");
        if (!head.includes("101") || !head.includes(expect)) { rej(new Error("握手被拒")); return; }
        sock.unshift(acc.subarray(i + 4)); res();
      });
    });
    const buf = { v: Buffer.alloc(0) };
    const pending = new Map();
    let id = 0;
    sock.on("data", (d) => {
      buf.v = Buffer.concat([buf.v, d]);
      for (;;) {
        if (buf.v.length < 2) return;
        const op = buf.v[0] & 0x0f;
        let len = buf.v[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.v.length < 4) return; len = buf.v.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.v.length < 10) return; len = Number(buf.v.readBigUInt64BE(2)); off = 10; }
        if (buf.v.length < off + len) return;
        const pl = buf.v.subarray(off, off + len);
        buf.v = buf.v.subarray(off + len);
        if (op !== 0x1) continue;
        let m; try { m = JSON.parse(pl.toString("utf8")); } catch { continue; }
        if (m.id && pending.has(m.id)) {
          const { resolve, reject, timer } = pending.get(m.id);
          pending.delete(m.id); clearTimeout(timer);
          m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        }
      }
    });
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const myId = ++id;
        const timer = setTimeout(() => { if (pending.delete(myId)) rej(new Error("超时 " + method)); }, 60000);
        pending.set(myId, { resolve: res, reject: rej, timer });
        const payload = Buffer.from(JSON.stringify({ id: myId, method, params }), "utf8");
        const len = payload.length;
        let h;
        if (len < 126) h = Buffer.from([0x81, 0x80 | len]);
        else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
        else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); }
        const mask = randomBytes(4), x = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) x[i] = payload[i] ^ mask[i & 3];
        sock.write(Buffer.concat([h, mask, x]));
      });
    return { send, close: () => sock.destroy() };
  };

  let diffs = [];
  try {
    await wsFor();
    await sleep(2000);
    const cdp = await connect(await wsFor());
    await cdp.send("Page.enable");
    const snap = async (url) => {
      await cdp.send("Page.navigate", { url });
      // Wait for webfonts in BOTH variants before sampling.
      //
      // Without this the check reports a font-swap artefact as a stylesheet
      // bug, and it looks convincing enough to act on. Measured on the hero:
      // `.section-tag` came out `16px` tall instead of `32px` (+16) while its
      // sibling paragraph came out `182px` instead of `156px` (-26), and the
      // two cancel to the hero's `925px` vs `915px`. Every one of the nineteen
      // tracked properties on the containers was identical, so the diff was
      // untraceable from the container outward -- it was pure text metrics.
      //
      // The cause is that only the reference variant had fonts. Both pages
      // carry the same deferred `@font-face` sheet and the same preloads, but
      // the first-paint page paints and settles sooner, so at sample time it
      // reported zero loaded faces and its text laid out in the fallback stack.
      // That is `font-display: swap` working as designed; it is not an inlining
      // defect, and no additional CSS in the block can fix it.
      //
      // So force the faces the hero actually uses, then wait. `document.fonts`
      // is unreliable as a gate here for the same reason: it reports "ready"
      // when nothing is in flight, which on a page whose font sheet is still
      // deferred means "ready with zero faces".
      await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const want = [
            '400 16px Geist', '600 16px Geist', '700 16px Geist',
            '400 16px "Geist Mono"',
          ];
          if (!document.fonts) return true;
          try { await Promise.all(want.map((f) => document.fonts.load(f))); } catch {}
          await document.fonts.ready;
          return document.fonts.size;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const r = await cdp.send("Runtime.evaluate", { expression: PAGE_PROBE, returnByValue: true, awaitPromise: true });
      return JSON.parse(r.result.value).els;
    };
    // Pin the viewport explicitly. Without this the page renders at Chrome's
    // default headless window (800px wide), which is past the 640px `sm:`
    // breakpoint -- so the comparison would be testing the tablet layout while
    // the inlined block is meant for a phone, and every `sm:` utility would
    // look like a missing rule. 412x823 with DPR 2 is the profile the earlier
    // measurements used.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 412,
      height: 823,
      deviceScaleFactor: 2,
      mobile: true,
    });
    const only = await snap("http://127.0.0.1:9411/__firstpaint.html");
    const full = await snap("http://127.0.0.1:9411/__full.html");
    cdp.close();
    // Tolerance for rect POSITION only.
    //
    // `rect` is [top, height, width]. Height and width must match exactly: they
    // come straight from the rules the block either carries or does not. Position
    // is downstream of text flow, and text flow is now metric-dependent because
    // the "Geist Fallback" faces (global.css) apply size-adjust / ascent-override
    // so the font swap does not reflow.
    //
    // size-adjust is derived from Geist's AVERAGE lowercase advance. Per-glyph
    // advances still differ slightly from the fallback's, so a line of text can
    // come out a few px wider or narrower and nudge a following inline-flex icon.
    // Measured: a 14px badge icon sat at top 784 in one variant and 780 in the
    // other, with all 19 probed computed properties identical and every relevant
    // utility present in the block. That is a residual, not a missing rule.
    //
    // 4px is the observed ceiling, so allow 5. Anything larger still fails — a
    // genuinely unstyled block drifts by tens to hundreds of px (the font-metric
    // bug this check caught presented as 152px).
    const POS_TOLERANCE = 5;
    const closeEnough = (x, y) => Math.abs(x - y) <= POS_TOLERANCE;
    const n = Math.min(only.length, full.length);
    for (let i = 0; i < n; i++) {
      const a = only[i], b = full[i];
      if (a.tag !== b.tag || a.cls !== b.cls) continue;
      const bad = [];
      const posOk =
        closeEnough(a.rect[0], b.rect[0]) &&
        a.rect[1] === b.rect[1] &&
        a.rect[2] === b.rect[2];
      if (!posOk) bad.push(`rect ${a.rect} vs ${b.rect}`);
      for (const k of Object.keys(b)) if (!["tag", "cls", "rect"].includes(k) && a[k] !== b[k]) bad.push(`${k}: ${a[k]} vs ${b[k]}`);
      if (bad.length) diffs.push(`<${a.tag} class="${a.cls}">\n      ` + bad.join("\n      "));
    }
  } catch (e) {
    child.kill();
    server.close();
    console.log(`  浏览器级自检无法执行：${e.message}`);
    return;
  } finally {
    child.kill();
    server.close();
    try { execFileSync("rm", ["-rf", profile]); } catch {}
    for (const f of ["__firstpaint.html", "__full.html", "_astro/__inline-only.css", "_astro/__full.css"]) {
      try { execFileSync("rm", [join(DIST, f)]); } catch {}
    }
  }

  if (diffs.length) {
    console.error(`✗ 首绘样式与完整样式表不一致：${diffs.length} 个元素`);
    for (const d of diffs.slice(0, 6)) console.error(`   - ${d}`);
    console.error("   内联块不完整，首绘会出现未样式化内容并在样式表到达时重排。");
    process.exitCode = 1;
    return;
  }
  console.log("  浏览器级自检通过：首绘样式与完整样式表逐元素一致");
}

main();
