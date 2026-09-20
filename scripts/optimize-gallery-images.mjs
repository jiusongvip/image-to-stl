/**
 * Downsize the "creations" gallery images from 1024px to 512px.
 *
 * Why: every image in this set is declared 1024x1024 in the markup but is
 * rendered at most 414px wide in the desktop grid and less on mobile. A 1024px
 * source for a 414px slot is 2.5x oversized, which Lighthouse flags as
 * `image-delivery-insight`. At 512px the source still exceeds the largest real
 * display width (so it stays sharp on high-DPR screens) while cutting the
 * payload by roughly two thirds.
 *
 * This is idempotent: it writes to `public/images/optimized/` and refuses to
 * resize an image that is already at or below the target width, so running it
 * twice does not degrade quality further.
 *
 * It does NOT rewrite the markup. The `width`/`height` attributes and `src`
 * paths are edited separately, because silently rewriting source files from a
 * build script is how you end up unable to tell what changed.
 *
 *   node scripts/optimize-gallery-images.mjs [--check]
 *
 *   --check   report what would change, write nothing
 */
import sharp from "sharp";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "public", "images");
const OUT_DIR = join(SRC_DIR, "optimized");

const TARGET = 512;
const QUALITY = 80;

/** The nine gallery images on the homepage, as referenced from index.astro. */
const FILES = [
  "photo-relief-print",
  "lithophane-backlit",
  "cookie-cutter-result",
  "logo-3d-extrusion",
  "custom-badges-signs",
  "topographic-terrain-map",
  "3d-printed-jewelry",
  "custom-stamps-embossing",
  "chocolate-mold-casting",
];

const checkOnly = process.argv.includes("--check");

async function main() {
  if (!checkOnly) mkdirSync(OUT_DIR, { recursive: true });

  let before = 0;
  let after = 0;
  const changed = [];

  for (const name of FILES) {
    const src = join(SRC_DIR, `${name}.webp`);
    if (!existsSync(src)) {
      console.error(`✗ 缺少源文件：${src}`);
      process.exitCode = 1;
      continue;
    }

    const meta = await sharp(src).metadata();
    const srcBytes = statSync(src).size;
    before += srcBytes;

    if (meta.width <= TARGET) {
      // Already small enough -- do not resample again, that only loses quality.
      console.log(`  ${name.padEnd(26)} 已是 ${meta.width}px，跳过`);
      after += srcBytes;
      continue;
    }

    const out = join(OUT_DIR, `${name}.webp`);
    const buf = await sharp(src)
      .resize(TARGET, TARGET, {
        fit: "cover",
        // `lanczos3` is the sharp default and the best general-purpose kernel
        // for downscaling; stated explicitly so the choice is visible.
        kernel: "lanczos3",
      })
      .webp({ quality: QUALITY })
      .toBuffer();

    after += buf.length;
    if (!checkOnly) writeFileSync(out, buf);

    const pct = (100 - (buf.length / srcBytes) * 100).toFixed(1);
    console.log(
      `  ${name.padEnd(26)} ${String(srcBytes).padStart(7)} -> ${String(buf.length).padStart(6)} B  (-${pct}%)`
    );
    changed.push({ name, srcBytes, outBytes: buf.length });
  }

  console.log("-".repeat(64));
  console.log(
    `  ${(checkOnly ? "预计合计" : "合计").padEnd(24)} ${String(before).padStart(7)} -> ${String(after).padStart(6)} B` +
      `  (-${(100 - (after / before) * 100).toFixed(1)}%)`
  );

  if (checkOnly) {
    console.log("\n  --check 模式：未写入任何文件。");
  } else if (changed.length) {
    console.log(`\n  输出目录：public/images/optimized/  （${changed.length} 个文件）`);
    console.log("  注意：markup 尚未改写，需手动更新 src 与 width/height。");
  }
}

main().catch((e) => {
  console.error("图片优化失败：", e);
  process.exit(1);
});
