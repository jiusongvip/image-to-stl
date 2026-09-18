// 构建后处理：修正 sitemap 首页 URL 并生成根路径 sitemap.xml。
//
// 背景：@astrojs/sitemap 在构建过程中生成 sitemap-index.xml 与 sitemap-0.xml。
// 但在带批量删除保护的沙箱环境中，astro build 可能在收尾阶段中断，
// 导致这两个文件缺失。为保证产物完整，本脚本在缺文件时会自行重建，
// 内容与 @astrojs/sitemap 的输出保持兼容（首页 URL 不带尾斜杠，内页带）。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const distDir = "dist";
const homeUrl = "https://www.image-2-stl.com";
const target = `<loc>${homeUrl}/</loc>`;
const replacement = `<loc>${homeUrl}</loc>`;

// 站点路由列表（与 src/pages 下的页面保持一致）
const ROUTES = [
  "/",
  "/about/",
  "/blog/",
  "/blog/3d-printing-basics/",
  "/blog/best-image-to-stl-converters/",
  "/blog/what-is-stl-file/",
  "/cookie-cutter/",
  "/faq/",
  "/heightmap-editor/",
  "/how-to-convert-image-to-stl/",
  "/jpg-to-stl/",
  "/lithophane-maker/",
  "/photo-to-3d/",
  "/png-to-stl/",
  "/privacy/",
  "/svg-to-stl/",
  "/terms/",
  "/text-to-stl/",
];

// 1. 修正已有的 sitemap-*.xml 中的首页 URL（去掉尾斜杠，与 canonical 一致）
let changed = false;
if (existsSync(distDir)) {
  for (const file of readdirSync(distDir)) {
    if (!file.startsWith("sitemap") || !file.endsWith(".xml") || file.includes("index")) {
      continue;
    }
    const path = join(distDir, file);
    const content = readFileSync(path, "utf8");
    if (content.includes(target)) {
      writeFileSync(path, content.replaceAll(target, replacement));
      changed = true;
      console.log(`✓ ${file}: 首页 URL 已去尾斜杠`);
    }
  }
}

// 2. 若 sitemap-0.xml 缺失（astro build 中断时会发生），按路由表重建
const sitemap0Path = join(distDir, "sitemap-0.xml");
if (!existsSync(sitemap0Path)) {
  const urls = ROUTES.map((route) => {
    const loc = route === "/" ? homeUrl : `${homeUrl}${route}`;
    return `<url><loc>${loc}</loc></url>`;
  }).join("");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  writeFileSync(sitemap0Path, xml);
  console.log(`✓ sitemap-0.xml: 已重建（${ROUTES.length} 条 URL）`);
}

// 3. 若 sitemap-index.xml 缺失，重建
const sitemapIndexPath = join(distDir, "sitemap-index.xml");
if (!existsSync(sitemapIndexPath)) {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    `<sitemap><loc>${homeUrl}/sitemap-0.xml</loc></sitemap>` +
    `</sitemapindex>`;
  writeFileSync(sitemapIndexPath, xml);
  console.log("✓ sitemap-index.xml: 已重建");
}

// 4. 始终生成根路径 sitemap.xml，确保 /sitemap.xml 可访问
const rootSitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  `  <sitemap>\n    <loc>${homeUrl}/sitemap-0.xml</loc>\n  </sitemap>\n` +
  `</sitemapindex>\n`;
writeFileSync(join(distDir, "sitemap.xml"), rootSitemap);
console.log("✓ sitemap.xml: 根路径索引已生成");

if (!changed) {
  console.log("（sitemap-0.xml 无需修正首页 URL）");
}
