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

// 单轮清理：返回本轮实际移除的项数
function sweep() {
  let n = 0;

  // 1. 目录级中间产物
  for (const t of TARGETS) {
    if (removeTarget(t)) {
      console.log(`✓ 已移除 ${t}`);
      n++;
    }
  }

  // 2. dist 根目录下的中间产物文件
  if (existsSync(DIST)) {
    const files = readdirSync(DIST).filter(SCRATCH_FILE);
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      for (const f of files.slice(i, i + BATCH_SIZE)) {
        try {
          rmSync(join(DIST, f), { force: true });
          n++;
        } catch {
          /* ignore */
        }
      }
    }
    if (files.length) console.log(`✓ 已移除 ${files.length} 个中间产物文件`);
  }

  return n;
}

// 是否仍有中间产物残留
function hasScratch() {
  for (const t of TARGETS) if (existsSync(t)) return true;
  if (!existsSync(DIST)) return false;
  return readdirSync(DIST).some(SCRATCH_FILE);
}

// 当前残留中间产物的快照签名，用于判断写入是否仍在继续。
// 返回空字符串表示已完全干净。
function scratchSignature() {
  const parts = [];
  for (const t of TARGETS) if (existsSync(t)) parts.push(t);
  if (existsSync(DIST)) {
    for (const f of readdirSync(DIST).filter(SCRATCH_FILE)) parts.push(join(DIST, f));
  }
  return parts.sort().join("|");
}

// 这些产物由 Astro 在进程收尾阶段异步写入，实测会在 astro 进程退出后持续分多批延迟落盘
// （观察到的写入窗口可达 1 分钟以上），且批次之间的间隔并不均匀。因此不能靠「固定等待 N 秒」
// 或「连续 N 轮为空」来判断，而必须监测中间产物集合本身的**变化**：
// 只有当集合连续多轮完全一致且为空时，才认定写入已真正停止。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 3000; // 轮询间隔
const REQUIRED_STABLE_ROUNDS = 4; // 集合连续多少轮不变且为空才判定收敛
const MAX_ROUNDS = 40; // 安全上限（约 2 分钟），防止无限循环

let cleaned = 0;
let stableRounds = 0;
let prevSignature = null;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const n = sweep();
  cleaned += n;

  const signature = scratchSignature(); // 清理后仍存在的中间产物快照

  if (signature === prevSignature && signature === "") {
    // 与上一轮完全一致，且确实为空 —— 写入已停止
    stableRounds++;
    if (stableRounds >= REQUIRED_STABLE_ROUNDS) break;
  } else {
    stableRounds = 0;
  }
  prevSignature = signature;

  await sleep(POLL_MS);
}

if (hasScratch()) {
  console.warn("\n⚠ 仍有中间产物残留，部署前请再次运行 npm run clean:dist");
  process.exitCode = 1;
} else if (cleaned === 0) {
  console.log("（dist/ 中无中间产物需要清理）");
} else {
  console.log(`\n✓ 清理完成，共处理 ${cleaned} 项`);
}
