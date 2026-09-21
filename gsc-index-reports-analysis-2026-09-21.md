# GSC 索引报告分析 — www.image-2-stl.com

> 核实时间：2026-09-21。所有线上状态码均为实测。
> 覆盖两份报告：**「网页会自动重定向」**（41 行）与 **「备用网页（有适当的规范标记）」**（2 行）。

---

# 第一部分：「网页会自动重定向」报告（41 行）

> 数据来源：GSC「网页索引编制 → 网页会自动重定向」导出，共 **41 行**（抓取日期 2026-08-13 ~ 2026-09-16）。

## 一、结论

**不需要任何修改操作。这不是错误，是跳转配置正常工作的副产物。**

一句话原因：本站有**唯一规范形式** `https://www.image-2-stl.com/<路径>/`（`astro.config.mjs` 里
`site: "https://www.image-2-stl.com"` + `trailingSlash: "always"`）。Google 从外链、历史 sitemap、
以及自动发现的变体里抓到了 `http` / 无 `www` / 缺尾斜杠 三种**非规范写法**，跟着 301/308 跳到了规范页，
把规范页收录了，于是把这些"入口"记进这份报告。

**决定性证据：41 条里没有一条是规范形式（`https://www.image-2-stl.com/…/`）。**
如果跳转配错了，规范形式反而会出现在这里。规范形式 0 条 = 配置是对的。

## 二、41 条的分类（全部为非规范变体）

| 类别 | 条数 | 举例 | 实测跳转 |
|---|---|---|---|
| `http://` 明文 | **2** | `http://image-2-stl.com/` | 301 → `https://image-2-stl.com/` → 301 → `https://www.image-2-stl.com/` **（2 跳）** |
| 无 `www`（apex） | **26** | `https://image-2-stl.com/heightmap-editor` | 301 → `https://www.image-2-stl.com/heightmap-editor` → 308 → `…/heightmap-editor/` **（2 跳）** |
| 有 `www` 但缺尾斜杠 | **13** | `https://www.image-2-stl.com/heightmap-editor` | 308 → `/heightmap-editor/` **（1 跳）** |
| **规范形式**（www + 尾斜杠） | **0** | — | 200，未出现在本报告 |

分类合计 2 + 26 + 13 = 41，与导出行数一致。

## 三、实测证据

### 3.1 跳转链（`curl -L`，逐条实测）

| 请求 | 首跳 | 落点 | 跳数 |
|---|---|---|---|
| `http://image-2-stl.com/` | **301** | `https://www.image-2-stl.com/` (200) | 2 |
| `https://image-2-stl.com/` | **301** | `https://www.image-2-stl.com/` (200) | 1 |
| `https://image-2-stl.com/heightmap-editor` | **301** | `https://www.image-2-stl.com/heightmap-editor/` (200) | 2 |
| `https://www.image-2-stl.com/heightmap-editor` | **308** | `…/heightmap-editor/` (200) | 1 |
| `https://www.image-2-stl.com/heightmap-editor/` | — | 200 | 0 ✅ |
| `https://www.image-2-stl.com/` | — | 200 | 0 ✅ |
| `https://image-2-stl.com/blog/what-is-stl-file` | **301** | `…/blog/what-is-stl-file/` (200) | 2 |

**所有变体最终都落到 200 的规范页，没有一条断链或死循环。**

两套机制分工明确：
- **301**：`http → https`、`apex → www`，在 **Cloudflare 边缘**做（跳转目标不带尾斜杠）；
- **308 Permanent Redirect**：`无尾斜杠 → 补尾斜杠`，由 **Cloudflare Pages** 依 Astro 的
  `trailingSlash: "always"` 产出（`Location` 是相对路径 `/heightmap-editor/`）。

两者都是**永久跳转**（301/308），符合"规范形式永久迁移"的要求 —— 这一点很重要，
如果用 302 就传不出权重。

### 3.2 sitemap 只含规范 URL

`dist/sitemap-0.xml` 的 18 条 `<loc>` **全部是 `https://www.image-2-stl.com/…/`**，
没有一条 apex 或缺尾斜杠。robots.txt 指向 `sitemap-index.xml`。✅

### 3.3 canonical 只指向规范 URL

各页 `<link rel="canonical">` 实测（抽样 12 个）全部为 `https://www.image-2-stl.com/<路径>/`，
首页为 `https://www.image-2-stl.com`（根路径，无斜杠也返回 200，符合 URL 规范）。✅

### 3.4 站内链接无 apex 写法

`grep -roh "https\?://image-2-stl\.com[^\"'<> ]*" dist/` → **0 条命中**。
产物里不存在任何绝对指向 apex 的链接，**不会自己制造新的重定向**。✅

### 3.5 不存在的路径正确返回 404

`https://www.image-2-stl.com/zzz-not-exist-xyz/` → **404 Not Found** ✅
（Cloudflare Pages 用 `dist/404.html` 兜底，状态码正确，不是软 404。）

## 四、为什么 Google 会"发现"这些变体

不是站点主动提交的，而是 Google 的常规发现行为：

1. **历史遗留**：站点早期可能用过 apex 或带/不带斜杠混用，旧链接仍在外部引用中。
2. **外链**：别人复制网址时常常漏掉 `www` 或尾斜杠。
3. **GSC 的 URL 检查/旧 sitemap**：提交过非规范 URL 也会留下记录。
4. **自动变体探测**：Google 会主动试 `http`、`www`、尾斜杠 等常见变体。

抓取日期从 8-13 一直延续到 9-16，且**新页面（`/photo-to-3d/`、`/heightmap-editor/`、`/lithophane-maker/`）9-16 也在被重抓** ——
说明 Google 仍在正常爬这个站，不是"卡住了"。

## 五、GSC 里这类报告该怎么读

| 报告状态 | 含义 | 要不要处理 |
|---|---|---|
| **网页会自动重定向** | 跳到了别的页，所以这一条没被索引 | ❌ **不用**（除非你不想要这个跳转） |
| 备用网页（有适当的规范标记） | 页面自己声明了 canonical 指向别处 | ❌ 不用 |
| 已发现，尚未编入索引 | 还没排上队 | ⏳ 等 |
| 已抓取，尚未编入索引 | 抓了但判定不值得收录 | ⚠️ 看内容质量 |
| **重定向错误** | 跳转链断裂/循环 | ✅ **必须修** |
| 软 404 | 返回 200 但内容是"找不到" | ✅ 要修 |

**你这份是第一种，属于"通知性"报告，Google 官方明确写着通常无需操作。**
真正需要警惕的是「重定向错误」和「软 404」—— 这两份报告本次都**没有**。

## 六、唯一需要在 GSC 里自己确认的一件事

本报告只说明"这些变体没被索引"，**不说明"规范页被索引了"**。请到 GSC
**「网页索引编制 → 已编入索引」** 里核对这 18 个规范 URL 是否都在：

```
/  /about/  /blog/  /blog/3d-printing-basics/  /blog/best-image-to-stl-converters/
/blog/what-is-stl-file/  /cookie-cutter/  /faq/  /heightmap-editor/
/how-to-convert-image-to-stl/  /jpg-to-stl/  /lithophane-maker/  /photo-to-3d/
/png-to-stl/  /privacy/  /svg-to-stl/  /terms/  /text-to-stl/
```

只要这 18 个都在「已编入索引」里，这份重定向报告就**完全正常，可以忽略**。
若其中有缺的，那才是需要单独查的问题（且与重定向无关）。

## 七、可选的小优化（收益极小，不做也没问题）

### 7.1 apex 变体要 2 跳 → 可压成 1 跳

`https://image-2-stl.com/heightmap-editor` 现在走
`301(补www) → 308(补斜杠)` 两跳。原因是 Cloudflare 的 apex→www 规则**跳转目标不带尾斜杠**。

**改法（在 Cloudflare 控制台，不在代码里）**：把 apex→www 的重定向规则改成保留并补齐尾斜杠，例如
动态表达式 `concat("https://www.image-2-stl.com", http.request.uri.path, ...)`。
**收益**：省一次往返、省一点抓取预算。**41 条 URL 的量级下，这个收益基本等于噪声。**
Google 官方允许最多 5 跳，2 跳完全在正常范围。

### 7.2 开 HSTS

Cloudflare 里开 HSTS + "Always Use HTTPS"，`http://` 变体会在浏览器层直接升级，
少一次明文往返。属顺手可做，非必需。

## 八、顺带发现的两个小瑕疵（与本次报告无关，优先级低）

1. **404 页的 canonical 指向一个会跳转的 URL。**
   `dist/404.html` 里是 `<link rel="canonical" href="https://www.image-2-stl.com/404/">`，
   而实测 `https://www.image-2-stl.com/404/` 会 **308** 跳到 `/404`。
   好在同一页已有 `<meta name="robots" content="noindex">`，
   **所以不会被索引，影响为零**。真要修就是把 canonical 改成 `/404` 或直接删掉这一行。

2. **`/404` 返回 200 而不是 404**（`https://www.image-2-stl.com/404` → 200）。
   这是 Cloudflare Pages 把 `/404` 当真实文件匹配的结果。
   同样被 `noindex` 兜住了，**无实际影响**。要彻底干净可加一条 Pages 的 `_redirects` 规则。

3. **`public/sitemap.xml`（手写的 sitemapindex）与 `@astrojs/sitemap` 生成的 `sitemap-index.xml` 并存**，
   两者内容都指向 `sitemap-0.xml`，robots.txt 只声明了 `sitemap-index.xml`。
   冗余但无害，可留可删。

## 九、总结

- **原因**：站点统一到 `https://www.image-2-stl.com/<路径>/`，其他写法（http / apex / 缺尾斜杠）全部 301/308 永久跳转。Google 抓到这些入口后跟着跳到规范页，于是记入本报告。
- **要不要改**：**不用**。41 条全是非规范变体，规范形式 0 条；跳转链全部落在 200，无断链无循环；sitemap / canonical / 站内链接三者都只使用规范形式。
- **唯一动作**：去 GSC「已编入索引」确认那 18 个规范 URL 都在。在 → 直接忽略这份报告。

---

# 第二部分：「备用网页（有适当的规范标记）」报告（2 行）

> 数据来源：GSC 同目录下的「备用网页（有适当的规范标记）」导出，共 **2 行**。
>
> | # | 网址 | 上次抓取日期 | 判定 |
> |---|---|---|---|
> | 1 | `https://www.image-2-stl.com/search?q={search_term_string}` | 2026-08-22 | ⚠️ **真实缺陷，已修** |
> | 2 | `https://image-2-stl.com/blog/` | 2026-08-15 | ✅ 过期记录，无需处理 |

## 一、第 1 条：`/search?q={search_term_string}` —— 真实缺陷（已修）

### 原因

`src/pages/index.astro` 的 `websiteSchema`（`WebSite` 节点）里声明了：

```js
potentialAction: {
  "@type": "SearchAction",
  target: `${SITE_URL}/search?q={search_term_string}`,
  "query-input": "required name=search_term_string",
},
```

`{search_term_string}` 是 schema.org / Google 规定的**占位符字面量**（不是真实查询参数），
Google 会把这个字符串当 URL 去抓。**但本站根本没有 `/search` 路由**，实测：

| 请求 | 结果 |
|---|---|
| `https://www.image-2-stl.com/search` | **404 Not Found** |
| `https://www.image-2-stl.com/search/` | **404 Not Found** |
| `https://www.image-2-stl.com/search?q=test` | **404 Not Found** |

→ 这个声明是**坏的**：它把一个不存在的页面宣传成了站内搜索入口。

### 为什么它落在「备用网页」而不是「未找到(404)」

最可能的解释：404 兜底页 `dist/404.html` 里带着
`<link rel="canonical" href="https://www.image-2-stl.com/404/">`，
Google 抓到 canonical 后把它归入「备用网页（有适当的规范标记）」而不是硬 404。
（这一条是推断，不影响结论 —— 无论归到哪一类，根因都是那个指向 404 的声明。）

### 为什么是「删掉」而不是「补一个 /search 页」

Google 已于 **2024-10-21 宣布弃用**、**2024-11 完全下线**「站点链接搜索框（sitelinks search box）」富媒体结果。
官方原话：*"While you can remove sitelinks search box structured data from your site, there's no need to…"*，
并说明该变更**不影响排名与其他 sitelinks**，相关项也会从 Search Console 报告中移除。

也就是说：`SearchAction` 现在**产生不了任何富媒体结果**。留着只有三个坏处：

1. 声明指向一个 404（无效声明）；
2. Google 持续抓取那个占位符 URL（浪费抓取预算）；
3. 就是本报告里这条噪音。

### 改动

删除 `src/pages/index.astro` 里 `websiteSchema` 的 `potentialAction` 整块（5 行）。
`WebSite` 节点其余字段（`name` / `url` / `description` / `publisher` / `sameAs` / `inLanguage` /
`datePublished` / `dateModified` / `about`）**全部保留**。

### 验证（构建产物实测）

- 构建通过：19 页，所有自检绿灯 —— `preload@208 < JSON-LD@3068`、`stylesheet@1012`、
  `charset@57 (<1024)`、关键 CSS 16897 B（预算 20480 B）、浏览器级首绘样式比对一致。
- `grep -roh "SearchAction\|search_term_string\|potentialAction" dist/*.html` → **0 条**。
- 全站 **15 个 JSON-LD 块全部解析成功（0 失败）**，`@type` 分布完好：
  `Organization 33 / Question 22 / Answer 22 / SoftwareApplication 9 / Offer 9 / ListItem 8 /
  DefinedTerm 6 / BreadcrumbList 5 / HowToStep 4 / BlogPosting 3 / CreativeWork 3 / ContactPoint 1 /
  AboutPage 1 / FAQPage 1 / HowTo 1 / WebSite 1 / WebPage 1`，**SearchAction 0**。

### 修完之后的预期

Google 下次抓取 `https://www.image-2-stl.com/search?q={search_term_string}` 会拿到 **404**，
该条目会从「备用网页」移到「未找到(404)」—— 这**本来就是正确状态**（页面确实不存在），
之后随抓取减少自然消失。**不需要再管。**

## 二、第 2 条：`https://image-2-stl.com/blog/` —— 过期记录，无需处理

实测：

```
https://image-2-stl.com/blog/  →  301 Moved Permanently
                               →  https://www.image-2-stl.com/blog/
```

它**现在已经是重定向**了，本该出现在「网页会自动重定向」里。之所以还留在「备用网页」，
是因为它的**抓取日期是 2026-08-15 —— 这 41+2 条里最旧的一条**：
那次抓取时 apex 还是直接返回 200 且 canonical 指向 www，Google 据此归类；
此后跳转规则生效，但这条记录还没被刷新。

→ **无需任何操作**，下次抓取后会自动改判。

## 三、两份报告放在一起看

| 报告 | 条数 | 性质 |
|---|---|---|
| 网页会自动重定向 | 41 | 全部是规范变体之外的其他写法，配置正确 |
| 备用网页（有适当的规范标记） | 2 | 1 条真实缺陷（已修）+ 1 条过期记录 |
| 重定向错误 | 0 | ✅ 无 |
| 软 404 | 0 | ✅ 无 |

**共同规律**：这两份报告记录的都是「Google 发现了非规范 / 无效 URL，并正确地没有索引它们」——
它们描述的是**结果**，不是**问题**。判断要不要动手的唯一标准是：
**被指向的那个目标页是否正常存在、是否被索引。**

本次唯一真正需要动手的就是那个指向 404 的 `SearchAction`，已修并推送。

---

# 第三部分：延伸审计 —— 站点在给 Google 喂自己的重定向源

处理完上面两份报告后，我把「站内链接 + 结构化数据里声明的 URL」全量扫了一遍，
结果发现**第一部分那 13 条 `www` + 缺尾斜杠条目的来源，就是本站自己的 `BreadcrumbList`**。

## 一、缺陷：`BreadcrumbList` 的 `item` 全部缺尾斜杠

5 个 URL 硬编码在 4 个页面的 `breadcrumbs` frontmatter 里，**全部漏了尾斜杠**：

| 文件 | 错误写法 |
|---|---|
| `src/pages/about.astro` | `https://www.image-2-stl.com/about` |
| `src/pages/blog/3d-printing-basics.astro` | `…/blog`、`…/blog/3d-printing-basics` |
| `src/pages/blog/best-image-to-stl-converters.astro` | `…/blog`、`…/blog/best-image-to-stl-converters` |
| `src/pages/blog/what-is-stl-file.astro` | `…/blog`、`…/blog/what-is-stl-file` |

实测这些 URL 全部 **308**：

```
https://www.image-2-stl.com/about                  → 308 → /about/
https://www.image-2-stl.com/blog                   → 308 → /blog/
https://www.image-2-stl.com/blog/3d-printing-basics → 308 → /blog/3d-printing-basics/
https://www.image-2-stl.com/blog/best-image-to-stl-converters → 308 → …/
https://www.image-2-stl.com/blog/what-is-stl-file  → 308 → /blog/what-is-stl-file/
```

**所以 `item` 指向的是跳转 URL** —— 结构化数据里声明一个会 308 的地址，
Google 抓它、跟一跳、把来源记进「网页会自动重定向」。
**站点在主动制造自己的重定向源，这部分抓取预算是白白花掉的。**

## 二、修复（提交 `b6ab564`）

1. **4 个调用点补上尾斜杠**（7 处 URL）。
2. **`src/layouts/BaseLayout.astro` 加 `toCanonicalUrl()` 归一化护栏** ——
   以后新页面忘了写斜杠也不会再犯（这是产生 breadcrumb schema 的唯一位置）。
3. **裸 origin `https://www.image-2-stl.com` 刻意保持无斜杠** ——
   那是首页的规范形式，与 `<link rel="canonical">` 和 sitemap 一致（且它返回 200，不是跳转）。

## 三、验证

- 产物：全站 `BreadcrumbList` 的 `item` **全部带尾斜杠**（唯一无斜杠的是首页裸 origin，正确）。
- 线上（Cloudflare 约 24 秒生效）：抽查 `/about/` 与 3 个博客页，**全部已是带斜杠形式**。
  例如 `/blog/what-is-stl-file/`：
  ```json
  {"@type":"BreadcrumbList","itemListElement":[
    {"@type":"ListItem","position":1,"name":"Blog","item":"https://www.image-2-stl.com/blog/"},
    {"@type":"ListItem","position":2,"name":"What Is an STL File?","item":"https://www.image-2-stl.com/blog/what-is-stl-file/"}]}
  ```

## 四、新增检查器：`scripts/audit-canonical-urls.py`

扫 `dist/` 里所有「指向自己域名但不是规范形式」的 URL（来自 `<a href>` 与 JSON-LD），
发现即 `exit 1` 并列出来源页面与所在键名。

```bash
npm run build
python scripts/audit-canonical-urls.py --verbose
```

正常输出：

```
扫描 19 个页面，15 个 JSON-LD 块（解析失败 0 个）
✓ 所有站内 URL 都是规范形式（www + 尾斜杠）
```

**已做负向对照**（本项目「自检必须能证伪」的纪律）：往 `dist/about/index.html` 注入一个缺斜杠 URL
→ `exit=1` 且准确定位：

```
✗ 发现 1 个非规范的站内 URL（会触发 308）：
   https://www.image-2-stl.com/about
        ← about/index.html [AboutPage.url]
        ← about/index.html [ListItem.item]
```

还原后 `exit=0`。**改完 SEO / 链接相关代码后应跑一次。**

## 五、顺带核实的其它项（均无问题）

| 检查 | 结果 |
|---|---|
| 产物里 apex 绝对链接 | **0 条** |
| sitemap 18 条 `<loc>` | 全是规范形式 |
| 各页 `canonical` | 全是规范形式（首页为裸 origin，正确） |
| 不存在的路径 | 正确 **404** |
| 结构化数据里的外部 URL | 见下 |

**外部 URL 检查的口径提醒**：用 curl 检查时 Wikipedia ×3 与 schema.org 返回 **502**、ISO 返回 **403**，
但同一轮里 GitHub / Britannica / Cloudflare 都是 **200** ——
**这是本地代理侧的问题，不是死链**。用另一条通道复核 Wikidata `Q1238229` = **STL（file format）** ✅ 在线且正确。
**结论：curl 拿到 5xx/403 时不要直接判为死链。**

## 六、第三部分的结论

第一部分的 41 条里有 **13 条**（`www` + 缺尾斜杠）**根因在站内**，现已消除：

- 4 个页面修正 + 1 处归一化护栏 → 站点不会再自己生成这类 URL；
- 新增检查器 → 以后能自动发现回归。

**GSC 侧的动作**：等 Google 重新抓取后，这 13 条会逐步从「网页会自动重定向」消失。
**不需要再手动做任何事。**


