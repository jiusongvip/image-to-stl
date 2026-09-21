#!/usr/bin/env node
/**
 * Negative control for the inline-critical-css font-family assertion.
 *
 * Reads a built page and, for every font family named by the inlined rules,
 * reports whether an inlined @font-face declares it. Run against a page built
 * BEFORE the keepInCriticalFace fix, it must report Geist / Geist Mono as
 * undeclared. Run against a page built AFTER, it must report all green.
 *
 * Usage: node scripts/check-inline-font-faces.mjs [dist/index.html]
 */
import { readFileSync } from "node:fs";

const file = process.argv[2] || "dist/index.html";
const doc = readFileSync(file, "utf8");
const block = /<style data-critical-css>([\s\S]*?)<\/style>/.exec(doc);
if (!block) {
  console.error("✗ 未找到内联关键 CSS 块");
  process.exit(1);
}
const inner = block[1];
const stripped = inner.replace(/@font-face\{[^}]*\}/g, "");

const KEYWORDS =
  /^(system-ui|ui-\w+|sans-serif|serif|monospace|inherit|initial|unset|math|emoji|fangsong)$/i;

const referenced = new Set();
for (const m of stripped.matchAll(/font-family:\s*([^;{}]+)/gi)) {
  for (const fam of m[1].split(",")) {
    const f = fam.trim().replace(/^["']|["']$/g, "");
    if (!f || KEYWORDS.test(f)) continue;
    referenced.add(f);
  }
}

const faces = [...inner.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]);
const declaredFamilies = new Set(
  faces.map((b) => {
    const m = /font-family:\s*["']?([^;"'}]+)["']?/i.exec(b);
    return m ? m[1].trim() : "";
  }),
);

console.log(`文件: ${file}`);
console.log(`内联 @font-face 数: ${faces.length}`);
console.log(`内联声明的族: ${[...declaredFamilies].filter(Boolean).join(" | ")}`);
console.log(`内联块引用的族: ${[...referenced].join(" | ")}`);
console.log("");

let bad = 0;
for (const fam of [...referenced].sort()) {
  const ok = declaredFamilies.has(fam);
  if (!ok) bad++;
  console.log(ok ? `  ✓ ${fam}` : `  ✗ 未声明 -> ${fam}  （首绘会静默跳过该族并重排）`);
}

console.log("");
for (const b of faces) {
  const fam = /font-family:\s*["']?([^;"'}]+)["']?/i.exec(b)?.[1] ?? "?";
  const wt = /font-weight:\s*([^;"'}]+)/i.exec(b)?.[1] ?? "400";
  const src = /src:\s*([^;}]+)/i.exec(b)?.[1] ?? "?";
  const kind = /url\(/i.test(src) ? "webfont" : "local-fallback";
  const adj = /size-adjust:\s*([^;"'}]+)/i.exec(b)?.[1] ?? "-";
  console.log(`  ${fam} w${wt} [${kind}] size-adjust=${adj}`);
}

console.log("");
if (bad) {
  console.error(`✗ ${bad} 个被引用的族没有内联声明`);
  process.exit(1);
}
console.log("✓ 全部被引用的族都已内联声明");
