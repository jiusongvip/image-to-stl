# PSI 测量陷阱：报告值 vs 实测值

一份可复现的测量记录，说明**为什么本站移动端 PSI 分数会突然从 97 掉到 83**，
以及**为什么这个分数不能直接当作页面质量的判据**。

- 站点：https://www.image-2-stl.com
- 被测代码：commit `6fc4937`（测量期间代码**完全没有改动**，已用 `git ls-remote origin main` 核实线上一致）
- 工具：PageSpeed Insights API v5（Lighthouse 13.4.1），`strategy=mobile`
- 测量脚本：`scripts/psi-run.mjs`（每次带随机 query 参数绕过 PSI 缓存，并核对 `fetchTime` 去重）

---

## 1. 现象

同一份代码，6 次独立测量的移动端结果：

| 次 | benchmark | Perf | 报告 FCP | 报告 LCP | 实测 FCP | 实测 LCP | TTFB |
|---|---|---|---|---|---|---|---|
| 1 | 783.5 | 97 | 1675 ms | 2251 ms | 1337 ms | 1351 ms | 601 ms |
| 2 | 599.0 | 96 | 1678 ms | 2252 ms | 1329 ms | 1329 ms | 602 ms |
| 3 | 495.0 | 97 | 1682 ms | 2255 ms | 1326 ms | 1326 ms | 605 ms |
| 4 | 1042.5 | 97 | 1668 ms | 2251 ms | **255 ms** | **325 ms** | 601 ms |
| 5 | 650.0 | **83** | 1727 ms | **4120 ms** | 2309 ms | 2309 ms | 601 ms |
| 6 | 737.0 | 98 | 1677 ms | 2255 ms | **318 ms** | **318 ms** | 605 ms |

**第 5 次就是「LCP 4.1s / SI 4.0s」的来源。**

### 关键观察

- **报告 FCP 的极差只有 59 ms**（1668–1727），**实测 FCP 的极差是 2054 ms**（255–2309）—— 相差 35 倍。
- 第 4、6 次实测首绘在 **255 ms / 318 ms**，报告值却仍然是 **1668 ms / 1677 ms**。
- **TTFB 恒定在 601–605 ms**（极差 4 ms），但：
  - 文档的 `networkEndTime` 只有 **81–120 ms**；
  - 实测首绘低至 **255 ms**。
  - **实测首绘早于 TTFB，逻辑上不可能。** 说明 `timeToFirstByte` 与首绘指标来自互不相关的测量路径。

---

## 2. 两套指标的含义

`lighthouseResult.audits.metrics.details.items[0]` 里同时存在两套 KPI：

| 字段 | 含义 |
|---|---|
| `firstContentfulPaint` / `speedIndex` / `largestContentfulPaint` | **Lighthouse 用来打分的值** |
| `observedFirstContentfulPaint` / `observedSpeedIndex` / `observedLargestContentfulPaint` | **trace 里真实观测到的值** |
| `observedFirstPaint` / `observedFirstVisualChange` / `observedLastVisualChange` | 同上，纯 trace 口径 |
| `timeToFirstByte` | 独立测量，本页上与前两者都对不上 |

桌面端（稳定，作为仲裁）缺口很小：

| 次 | bench | Perf | 报告 FCP | 实测 FCP | 报告 LCP | 实测 LCP | TTFB |
|---|---|---|---|---|---|---|---|
| 1 | 914.5 | 100 | 459 ms | 291 ms | 459 ms | 291 ms | 162 ms |
| 2 | 525.5 | 99 | 464 ms | 428 ms | 881 ms | 524 ms | 162 ms |
| 3 | 604.5 | 99 | 471 ms | 483 ms | 602 ms | 527 ms | 162 ms |

**桌面缺口 +36 到 +168 ms；移动缺口 −582 到 +1926 ms。**
移动端缺口大且随机 ⇒ 该次测量不可信。

---

## 3. 胶片实证：页面在 375 ms 就画完了

`audits.screenshot-thumbnails.details.items` 是 8 张 **JPEG** 缩略图（250×498，视口 412×823 的降采样），
时间点 375 / 750 / 1125 / … / 3000 ms。

把它们解码后**逐像素**比较（`PIL.ImageChops.difference`）：

```
f0(375ms) vs f7(3000ms) : 变化像素 0   ← 完全相同
f0 -> f1 : 变化像素 52，区域 x:240-250 y:0-24（汉堡图标状态）
f2 之后  : 全部 0
```

**375 ms 那一帧已经与 3000 ms 终帧逐像素相同。** 整页内容全部就位。

> ⚠️ 注意：**不能比字节或 md5**。f0 是 20958 B、f7 是 20943 B，字节不同，
> 但像素差为 0（JPEG 熵编码差异）。必须解码后逐像素比。

那个 375 ms 的实测 FCP，与报告 FCP 1670 ms 之间的 **~1300 ms 差额，不来自页面渲染**。

---

## 4. `lcp-breakdown-insight` 的缺口同样指向指标口径

四段分解（字段名是 **`duration`**，不是 `value`）：

| 次 | TTFB | 资源加载延迟 | 资源加载耗时 | 元素渲染延迟 | 四段和 | 报告 LCP | 缺口 |
|---|---|---|---|---|---|---|---|
| 1 | 3.2 | 133.4 | 88.8 | 1125.5 | 1351 | 2251 | **900** |
| 4 | 4.1 | 108.1 | 52.3 | 160.8 | 325 | 2251 | **1926** |
| 5 | 4.2 | 122.4 | 48.5 | 2134.2 | 2309 | 4120 | **1810** |

第 4 次是决定性的一次：**网络侧只用了 325 ms 就全部就绪、元素渲染延迟仅 161 ms，
报告 LCP 却仍是 2251 ms。** 差额与被测对象的实际行为无关。

---

## 5. 结论与操作规则

**结论：本站移动端 PSI 的分差主要是测量装置造成的，不是代码回归。**
用户报告的 LCP 4.1s / SI 4.0s 已复现（第 5 次），但那次的 `elementRenderDelay` 是 2134 ms
（其余三次为 116 / 1125 / 161 ms），且同次实测 LCP 是 2309 ms —— 是长尾抖动。

### 规则

1. **报数字前必须同时看报告值和实测值。** 缺口 > 500 ms 就不引用这次的分。
2. **`benchmarkIndex` 不是唯一的过滤条件。** 第 5 次 `bench=650` 并不极端，照样给出 83 分。
   去重 `fetchTime` 也挡不住 —— 每次 `fetchTime` 都不同，报告 FCP 照样恒定 1670 ms。
3. **桌面端缺口小且稳定，仍是仲裁者。** 桌面 Perf 100 / 99 / 99，CLS 0.000。
4. **`screenshot-thumbnails` 比任何数字都可信** —— 它是像素，不是聚合指标。
5. **不要为移动端分差改代码。** 当前所有可控项都已归零：
   `render-blocking-insight` score=1 / `metricSavings {FCP:0, LCP:0}` / `items=[]`；
   `lcp-discovery-insight` score=1；CLS 0.000。

---

## 附：复现命令

```bash
# 移动端 5 次（脚本自带缓存绕过、失败校验、报告值 vs 实测值对比）
node scripts/psi-run.mjs "https://www.image-2-stl.com/" mobile 5 /tmp/psi-m

# 桌面端对照
node scripts/psi-run.mjs "https://www.image-2-stl.com/" desktop 3 /tmp/psi-d
```

导出胶片帧并逐像素比较：

```bash
node -e "
const fs=require('fs');
const j=JSON.parse(fs.readFileSync('/tmp/psi-m-5.json','utf8'));
const st=j.lighthouseResult.audits['screenshot-thumbnails'];
fs.mkdirSync('/tmp/frames',{recursive:true});
st.details.items.forEach((it,i)=>{
  fs.writeFileSync('/tmp/frames/f'+i+'.jpg',
    Buffer.from(it.data.replace(/^data:image\/jpeg;base64,/,''),'base64'));
});
"
# 然后用 PIL 逐像素比（不要比字节）
```
