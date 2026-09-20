/**
 * Downsize the illustrations that ship at 1024px but are displayed much smaller.
 *
 * Two size groups, because the same artwork is used at two very different
 * widths and a single file cannot serve both well. Every size here was measured
 * in Chrome with `getBoundingClientRect` rather than inferred from Tailwind
 * classes -- "max-w-3xl" reads like 768px but the real rendered width depends on
 * padding, scrollbars and the viewport.
 *
 *   gallery  414px on desktop (grid cell on the homepage), narrower on mobile
 *            -> target 512
 *   hero     766px on desktop (inside `max-w-3xl` on each detail page)
 *            -> target 860
 *
 * Targets sit just above the measured display width: enough headroom that the
 * image is never upscaled, while dropping most of the payload. Sizing a hero to
 * the gallery's 512 would upscale it 1.5x and visibly soften it.
 *
 * Idempotent: anything already at or below its target is skipped, so re-running
 * cannot degrade quality further.
 *
 * It does NOT rewrite the markup. The `src` and `width`/`height` attributes are
 * edited separately, because a build step that silently edits source files makes
 * it impossible to tell what changed.
 *
 *   node scripts/optimize-gallery-images.mjs [--check]
 *
 *   --check   report what would change, write nothing
 */
import sharp from "sharp";
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "public", "images");

const QUALITY = 80;

const GROUPS = {
  // Homepage "What You Can Create" grid. Output: public/images/optimized/
  gallery: {
    target: 512,
    out: join(SRC_DIR, "optimized"),
    files: [
      "photo-relief-print",
      "lithophane-backlit",
      "cookie-cutter-result",
      "logo-3d-extrusion",
      "custom-badges-signs",
      "topographic-terrain-map",
      "3d-printed-jewelry",
      "custom-stamps-embossing",
      "chocolate-mold-casting",
    ],
  },
  // Detail-page heroes. Output: public/images/optimized/hero/
  //
  // Deliberately a separate directory, not the same filename: five of these are
  // the same artwork as a gallery entry, and writing both sizes to one path
  // would mean whichever ran last silently wins.
  hero: {
    target: 860,
    out: join(SRC_DIR, "optimized", "hero"),
    files: [
      "logo-3d-extrusion",
      "topographic-terrain-map",
      "cookie-cutter-result",
      "lithophane-backlit",
      "photo-relief-print",
    ],
  },
};

const checkOnly = process.argv.includes("--check");

async function main() {
  let grandBefore = 0;
  let grandAfter = 0;

  for (const [groupName, group] of Object.entries(GROUPS)) {
    if (!checkOnly) mkdirSync(group.out, { recursive: true });

    let before = 0;
    let after = 0;
    let processed = 0;

    console.log(`\n[${groupName}] target ${group.target}px -> ${group.out}`);

    for (const name of group.files) {
      const src = join(SRC_DIR, `${name}.webp`);
      if (!existsSync(src)) {
        console.error(`  x missing source: ${src}`);
        process.exitCode = 1;
        continue;
      }

      const meta = await sharp(src).metadata();
      const srcBytes = statSync(src).size;
      before += srcBytes;

      if (meta.width <= group.target) {
        // Already small enough. Do not resample -- that only loses quality.
        console.log(`  ${name.padEnd(26)} already ${meta.width}px, skipped`);
        after += srcBytes;
        continue;
      }

      const buf = await sharp(src)
        .resize(group.target, group.target, {
          fit: "cover",
          // `lanczos3` is sharp's default and the best general-purpose kernel
          // for downscaling; stated explicitly so the choice is visible.
          kernel: "lanczos3",
        })
        .webp({ quality: QUALITY })
        .toBuffer();

      after += buf.length;
      processed++;
      if (!checkOnly) writeFileSync(join(group.out, `${name}.webp`), buf);

      const pct = (100 - (buf.length / srcBytes) * 100).toFixed(1);
      console.log(
        `  ${name.padEnd(26)} ${String(srcBytes).padStart(7)} -> ${String(buf.length).padStart(6)} B  (-${pct}%)`
      );
    }

    const saved = before - after;
    console.log(
      `  ${"-".repeat(58)}\n  group total ${String(before).padStart(7)} -> ${String(after).padStart(6)} B` +
        `  (-${(100 - (after / before) * 100).toFixed(1)}%, ${(saved / 1024).toFixed(0)} KiB saved, ${processed} rewritten)`
    );

    grandBefore += before;
    grandAfter += after;
  }

  console.log(`\n${"=".repeat(62)}`);
  console.log(
    `  ALL GROUPS ${String(grandBefore).padStart(7)} -> ${String(grandAfter).padStart(6)} B` +
      `  (-${(100 - (grandAfter / grandBefore) * 100).toFixed(1)}%)`
  );

  if (checkOnly) {
    console.log("\n  --check mode: nothing written.");
  } else {
    console.log("\n  Note: markup still points at the originals. src and width/height");
    console.log("  must be updated separately.");
  }
}

main().catch((e) => {
  console.error("image optimisation failed:", e);
  process.exit(1);
});
