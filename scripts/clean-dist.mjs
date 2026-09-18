// 清理 dist/ 中的 Astro 服务端渲染中间产物。
//
// 背景：本项目 output: "static"，但 @astrojs/react / sitemap 等集成会额外产出
// 服务端渲染中间文件（路由模块 dist/pages/*.astro.mjs、dist/chunks/、
// manifest_*.mjs、renderers.mjs、_noop-middleware.mjs）。这些文件不属于静态站点
// 产物，部署时应排除，否则会连同 HTML 一起被上传。
//
// 重要：这些文件由 Astro 在构建收尾阶段异步写入，可能在 build 脚本执行期间反复出现。
// 因此本脚本设计为「构建流程的最后一步」，独立运行 —— 确保此时 astro 进程已完全退出。
//
// 删除采用分批策略（每批 < 10 项），以适配带批量删除保护的环境。
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const BATCH_SIZE = 10;
const DIST = "dist";

// 需要整体删除的中间产物目录 / 文件
const TARGETS = ["dist/pages", "dist/chunks", "dist/astro", ".astro"];

// dist 根目录下需要删除的中间产物文件名模式
const SCRATCH_FILE = (f) =>
  f === "_noop-middleware.mjs" ||
  f === "renderers.mjs" ||
  (f.startsWith("manifest_") && f.endsWith(".mjs"));

function removeTarget(target) {
  if (!existsSync(target)) return false;

  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    return false;
  }

  if (!isDir) {
    try {
      rmSync(target, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  // 递归收集，深度优先
  const collect = (d) => {
    const out = [];
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const p = join(d, entry);
      let entryIsDir = false;
      try {
        entryIsDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (entryIsDir) out.push(...collect(p));
      out.push({ path: p, isDir: entryIsDir });
    }
    return out;
  };

  const entries = collect(target);
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    for (const { path, isDir: entryIsDir } of entries.slice(i, i + BATCH_SIZE)) {
      try {
        rmSync(path, { recursive: entryIsDir, force: true });
      } catch {
        /* 忽略：可能已被父级删除 */
      }
    }
  }

  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // 以「目标是否已消失」作为成功判据
  return !existsSync(target);
}

let cleaned = 0;

// 1. 目录级中间产物
for (const t of TARGETS) {
  if (removeTarget(t)) {
    console.log(`✓ 已移除 ${t}`);
    cleaned++;
  }
}

// 2. dist 根目录下的中间产物文件
if (existsSync(DIST)) {
  const files = readdirSync(DIST).filter(SCRATCH_FILE);
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    for (const f of files.slice(i, i + BATCH_SIZE)) {
      try {
        rmSync(join(DIST, f), { force: true });
        cleaned++;
      } catch {
        /* ignore */
      }
    }
  }
  if (files.length) console.log(`✓ 已移除 ${files.length} 个中间产物文件`);
}

if (cleaned === 0) {
  console.log("（dist/ 中无中间产物需要清理）");
} else {
  console.log(`\n✓ 清理完成，共处理 ${cleaned} 项`);
}
