# 性能报告 — 2026-09-21

**URL：** https://www.image-2-stl.com/
**方式：** PageSpeed Insights API（带 Key，经本地代理）× 桌面 3 次 + 移动 3 次；智能体浏览用本地 Lighthouse 13.5.0
**部署版本：** `ee53848`（已核实线上 HTML 含 interaction-only gtag，`charset@57`）

---

## 一、桌面端（3 次）

| 指标 | run 1 | run 2 | run 3 | 阈值 | 判定 |
|------|-------|-------|-------|------|------|
| **Performance** | 90 | **100** | **100** | ≥ 90 | ✅ |
| 无障碍 | 100 | 100 | 100 | ≥ 90 | ✅ |
| 最佳做法 | 100 | 100 | 100 | ≥ 90 | ✅ |
| SEO | 100 | 100 | 100 | ≥ 90 | ✅ |
| LCP | 0.54 s | 0.54 s | 0.47 s | ≤ 2.5 | ✅ |
| **CLS** | **0.2059** | **0.0438** | **0.0434** | ≤ 0.10 | **❌ / ⚠️** |
| FCP | 0.47 s | 0.46 s | 0.46 s | ≤ 1.8 | ✅ |
| TBT | 24 ms | 0 ms | 0 ms | ≤ 200 | ✅ |
| SI | 0.84 s | 0.48 s | 0.47 s | ≤ 3.4 | ✅ |
| TTFB | 161 ms | 162 ms | 162 ms | ≤ 0.8 | ✅ |
| benchmarkIndex | 343 | 786 | 849 | — | run 1 机器偏差，分数已剔除 |

## 二、移动端（3 次）

| 指标 | run 1 | run 2 | run 3 | 阈值 | 判定 |
|------|-------|-------|-------|------|------|
| **Performance** | **98** | **98** | **96** | ≥ 90 | ✅ |
| 无障碍 / 最佳做法 / SEO | 100 | 100 | 100 | ≥ 90 | ✅ |
| LCP | 2.25 s | 2.25 s | 2.10 s | ≤ 2.5 | ✅ |
| **CLS** | **0.0000** | **0.0000** | **0.0000** | ≤ 0.10 | ✅ |
| FCP | 1.68 s | 1.68 s | 1.81 s | ≤ 1.8 | ✅ |
| TBT | 0 ms | 0 ms | 0 ms | ≤ 200 | ✅ |
| SI | 2.40 s | 2.43 s | 3.89 s | ≤ 3.4 | ⚠️ run 3 |
| TTFB | 602 ms | 602 ms | 602 ms | ≤ 0.8 | ✅ |
| benchmarkIndex | 598 | 499 | 560 | — | 正常 |

**CrUX 字段数据：无**（真实用户样本不足，以实验室数据为准，属正常）。

**LCP 四段分解与实测值对账（移动端）——完全对得上，无未归因时间：**

| run | TTFB | 资源发现延迟 | 资源传输 | 元素渲染延迟 | 四段之和 | trace 实测 LCP |
|-----|------|------|------|------|------|------|
| 1 | 4 ms | 82 ms | 66 ms | 1078 ms | **1230 ms** | **1230 ms** |
| 2 | 6 ms | 87 ms | 43 ms | 1113 ms | **1249 ms** | **1250 ms** |
| 3 | 5 ms | 120 ms | 155 ms | 1980 ms | **2260 ms** | **2260 ms** |

移动端 `elementRenderDelay` 1098–1980 ms 仍是 4× 节流地板；本站代码长任务 0–87 ms，
run 3 的 114 ms 长任务来自 Cloudflare 注入的 `beacon.min.js`。**继续压这里没有收益。**

## 三、智能体浏览（本地 Lighthouse 13.5.0，`agentic-browsing`）

**category score = 1（满分 3/3）**

| 审计项 | 权重 | 结果 |
|------|------|------|
| `agent-accessibility-tree` | 1 | ✅ |
| `cumulative-layout-shift` | 1 | ✅ 0.008 |
| `llms-txt` | 1 | ✅ |
| `webmcp-form-coverage` / `-registered-tools` / `-schema-validity` | 0 | N/A（未实现，非失败） |
| `ard-schema` | 0 | N/A |

---

## 四、唯一失分项：桌面端 CLS，根因已定位

**症状：** 桌面 CLS 0.0434 / 0.0438 / 0.2059（历史基线 0.0000），移动端 0.0000。

**根因（本地可复现 3/3，非噪声）：hero 的 `<h1>` 在 webfont 换入后少掉一行。**

```
hero 子元素 #1（<h1 class="... lg:text-[56px] font-bold">）
    首绘：168 px = 3 行 × 56 px
    字体换入后：112 px = 2 行 × 56 px
    → hero 区块高度 769 px → 713 px（−56 px）
    → 其下方全部内容整体上移 56 px  → CLS
```

`probe-firstpaint.mjs --desktop`（1350×940 + PSI 桌面网络预设）连续 3 次给出**完全相同的 56 px**；
`probe-cls.mjs --desktop` 读到具体位移元素（CTA 行 `top 596→540`、说明段 `430→374`，
均上移 56 px）；PSI 的 `layout-shifts` 把移位归因到 `Geist-Medium.woff2` /
`GeistMono-Medium.woff2` / `Geist-Bold.woff2` 的换入。

**触发条件：** `<h1>` 首行 `Convert Image to STL Online —` 的宽度**正好压在 816 px 容器边界上**
（`max-w-4xl` 896 − `px-10` 80 = 816）。回退面与 Geist Bold 的宽度差只要 1–2%，
就足以把这一行从 1 行翻成 2 行。本项目的宽度探针实测回退面在部分字符串上偏差达
**−2.34%**（w700 "Start Converting"），并非逐字符串都精确。

**为什么移动端不受影响：** 移动端 `<h1>` 是 `text-4xl`（36 px）、容器约 330 px，
首行在两种字体下都折成固定的行数，行数不变 → CLS 0.0000。

**为什么上一轮「桌面 CLS 0.0000 ×5」没拦住它：** 这是**竞态**——字体到达（95–298 ms）
与首绘谁先谁后。字体时序与历史基线几乎一致（95–298 ms vs 154–338 ms），
`213dd41..HEAD` 的 diff 也不含任何影响布局的改动（只有 gtag 门控）。
**上一轮的 0.0000 是竞态赢了，不是保证。**

### 首行宽度实测（56px / w700 / tracking-tight，字符串 `Convert Image to STL Online —`）

| 字体 | 宽度 | vs 旧容器 816 px |
|---|---|---|
| **Geist**（字体换入后） | **804.95 px** | 98.7% → 放得下 |
| **Geist Fallback**（首绘） | **838.80 px** | **102.8% → 折行** |
| system-ui | 846.19 px | 103.7% → 折行 |

**回退面在这个字符串上比 Geist 宽 4.2%。** 项目原有的宽度探针用的通用字符串
（`Real-Time 3D Preview` 0.00%、`Start Converting` −2.34%）**没有覆盖到它** ——
这正是它能在「回退面已校准」之后仍然漏网的原因。

### 已实施的修复（2026-09-21）

`src/pages/index.astro` 两处改动：

| 位置 | 改动 | 作用 |
|---|---|---|
| hero 文本容器 | `max-w-4xl` → `max-w-4xl lg:max-w-5xl` | lg 断点下文本列 816 → 944 px；**settled 渲染像素级不变**（文本左对齐，段落另有 `max-w-[58ch]` 封顶） |
| `<h1>` | `lg:text-[56px]` → `lg:text-[54px]` | 再让出 3.6%，保证最窄的 lg 视口（1024 px → 容器 896 px）也有余量 |

**修复后余量：**

| 字体 | 宽 1350 px 视口（容器 944） | 最窄 lg 视口 1024 px（容器 896） |
|---|---|---|
| Geist | 776.20 px → 17.8% | 17.8% |
| Geist Fallback | 808.92 px → **14.3%** | **9.7%** |
| system-ui | 815.97 px → 13.6% | 8.9% |

**验证（本地 `dist/` + `probe-firstpaint.mjs --desktop`）：**

| | 修复前（线上） | 修复后（本地） |
|---|---|---|
| `fontReflowPx`（hero 子元素高度变化） | **56 px**（3/3） | **0 px**（2/2） |
| `maxDeviationPx` | 56 px | 0 px |
| hero 高度 | 769 → 713 | 709 → 709（稳定） |
| h1 行数（woff2 拦截 / 放行） | 3 行 → 2 行 | **2 行 → 2 行** |

hero 高度从 713 变为 709（−4 px），是 54 px 字号让两行各少 2 px 的正常结果。

**断点边界复核**（`FP_WIDTH=1024 FP_HEIGHT=768`，即最窄的 lg 视口、容器只有 896 px）：
`fontReflowPx = 0`（2/2）。**边界处也不折行。**

### 顺带修掉了一个「说谎的自检」（已改）

`scripts/probe-firstpaint.mjs` 原来把「字体换入导致的几何漂移」注释成
*"normal and must NOT be counted against the build"* 并直接判 **通过** ——
这正是这个 56 px 重排能带着「通过」上线的原因。
现已改为**单独输出 `fontReflowPx` 与明确的 CLS 风险判定**，不再被静默放过。

---

## 五、其余优化机会（都很小，可不做）

| 项 | 数值 | 说明 |
|------|------|------|
| `image-delivery-insight` | 28 KiB | 首页作品网格 3 张 webp：`cookie-cutter-result` 14 KiB、`lithophane-backlit` 8 KiB、`photo-relief-print` 6 KiB。在折叠之下，收益有限 |
| `cache-insight` | 4 KiB | 全是 Cloudflare 边缘注入（`beacon.min.js`、`email-decode.min.js`），**源站 HTML 里不存在**，只能去 CF 控制台改 |
| `forced-reflow-insight` | ~140 ms（unattributed） | 桌面主线程 `styleLayout` 155 ms。无归因来源，暂无法定位 |
| `network-dependency-tree-insight` | score 0 | **不是缺陷**：内容为「没有更多合适的 preconnect 候选」 |
| `render-blocking-insight` | score 1，items 0 | ✅ 无阻塞 |
| `total-byte-weight` | 316 KiB | ✅ |

## 六、结论

- **移动端全绿**：Perf 96–98、LCP 2.10–2.25 s、**CLS 0.0000**，优于上一轮（95/90/83、LCP 最高 4.10 s）。
- **桌面端唯一失分项是 CLS**，根因是 hero `<h1>` 首行压在换行边界上、字体换入后掉一行导致 56 px 整体位移。
  **已修复并本地验证**（`fontReflowPx` 56 → 0），**需 push 部署后才在线上生效，生效后应用 PSI 复测确认。**
- 其余项已到边际收益，长任务与缓存项均属 Cloudflare 边缘注入，代码侧无杠杆。

## 七、遗留观察（未处理）

- `<h1>` 的计算 `line-height` 是 **56 px**（= 字号），而 `leading-[1.06]` 期望的是 59.36 px。
  该 class 确实存在于产物 CSS（`leading-\[1\.06\]{line-height:1.06}`），但未生效 ——
  原因未查明。当前无功能影响（固定行高反而让行盒不随字体变化），
  但**行盒高度目前是「字号 × 1.0」**，改字号时会同比变化，需知悉。
- `p.mt-6 ... max-w-[58ch]` 的 `ch` 单位随字体变化，属于同一类隐患。
  本次实测它没有参与位移（hero 高度差 56 px 全部由 `<h1>` 贡献），故未改动。
