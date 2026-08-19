// 构建后处理：将 sitemap 首页 URL 去掉尾斜杠，与 canonical 保持一致（内页保持尾斜杠）
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const distDir = "dist";
const homeUrl = "https://www.image-2-stl.com";
const target = `<loc>${homeUrl}/</loc>`;
const replacement = `<loc>${homeUrl}</loc>`;

let changed = false;
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

if (!changed) {
  console.log("⚠ 未找到需要处理的 sitemap 首页 URL");
}
