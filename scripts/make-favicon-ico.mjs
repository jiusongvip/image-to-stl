// Generate public/favicon.ico from public/favicon.svg.
//
// Why this exists: Safari (macOS and iOS) does not support SVG favicons, so a
// site that declares only `rel="icon" type="image/svg+xml"` has no favicon at
// all there. An .ico fallback is therefore genuinely needed, not just legacy
// padding -- and it must be a real file: the head used to declare
// `/favicon.ico` while nothing served it, which 404s on every page.
//
// Keeping the .ico derived from the .svg (rather than hand-committed) means
// editing the SVG and forgetting to regenerate cannot happen: run this script.
//
// Usage:  node scripts/make-favicon-ico.mjs
//
// sharp rasterises the SVG; the ICO container is assembled here directly.
// Since Windows Vista, ICO entries may hold raw PNG data, so no BMP encoding
// is required.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, "public", "favicon.svg");
const icoPath = join(root, "public", "favicon.ico");

// 16 = browser tab, 32 = taskbar / bookmarks, 48 = Windows Explorer.
const SIZES = [16, 32, 48];

const svg = readFileSync(svgPath);

const pngs = await Promise.all(
  SIZES.map((size) =>
    sharp(svg, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer()
  )
);

// --- ICONDIR (6 bytes) + ICONDIRENTRY * n (16 bytes each) ---
const HEADER = 6;
const ENTRY = 16;
let offset = HEADER + ENTRY * pngs.length;

const dir = Buffer.alloc(HEADER);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: 1 = icon
dir.writeUInt16LE(pngs.length, 4);

const entries = pngs.map((png, i) => {
  const size = SIZES[i];
  const e = Buffer.alloc(ENTRY);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // width  (0 means 256)
  e.writeUInt8(size >= 256 ? 0 : size, 1); // height
  e.writeUInt8(0, 2); // palette size
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(png.length, 8); // bytes of image data
  e.writeUInt32LE(offset, 12); // offset from start of file
  offset += png.length;
  return e;
});

const ico = Buffer.concat([dir, ...entries, ...pngs]);
writeFileSync(icoPath, ico);

console.log(
  `✓ 写入 public/favicon.ico（${SIZES.join("/")} px，共 ${ico.length} B，` +
    `其中 PNG 数据 ${pngs.map((p) => p.length).join(" + ")} B）`
);
