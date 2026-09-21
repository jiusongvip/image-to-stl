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

## 八、顺带发现的三个小瑕疵（与本次报告无关）

1. **404 页的 canonical 指向一个会跳转的 URL。 —— 已修（见第三部分第七节）。**
   原来 `dist/404.html` 里是 `<link rel="canonical" href="https://www.image-2-stl.com/404/">`，
   而实测 `https://www.image-2-stl.com/404/` 会 **308** 跳到 `/404`。
   同一页已有 `<meta name="robots" content="noindex">`，**所以不会被索引，影响为零** ——
   但它与第三部分那个 BreadcrumbList 缺陷是同一类问题：**站点在声明一个会跳转的 URL 作为自己的规范地址**。
   已改为**省略该标签**（404 页服务任意未匹配路径，本来就没有自己的规范 URL）。

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

三项检查（检查 3 是后来补的，见第四部分）：

1. **站内 URL 规范性** —— 扫 `dist/` 里所有「指向自己域名但不是规范形式」的 URL
   （来自 `<a href>` 与 JSON-LD 的 `url` / `item` / `@id` / `target` / `sameAs` / `contentUrl` 等键），
   发现即报出来源页面与所在键名。
2. **canonical 自指** —— 每个目录式页面的 `canonical` 必须等于它自己的规范 URL；
   **非目录式页面（`404.html`）不该声明 canonical，声明了就报错。**
3. **站内引用可达性** —— `<a href>`、`<img>`/`<source>` 的 `src` 与 `srcset`、`<script src>`、
   `<link href>`、`og:image`/`twitter:image`、内联 `<style>` 里的 `url()`，
   是否都能落到 `dist/` 里真实存在的文件。详见第四部分。

任一项失败即 `exit 1`。

```bash
npm run build
npm run audit:urls          # 等价于 python scripts/audit-canonical-urls.py
```

正常输出：

```
扫描 19 个页面，15 个 JSON-LD 块（解析失败 0 个）
站内引用检查 1224 处（链接 + 资源）

✓ 检查 1 通过：站内 URL 都是规范形式（www + 尾斜杠）
✓ 检查 2 通过：18 个页面的 canonical 全部自指
✓ 检查 3 通过：站内链接与资源引用全部可达
```

**已做负向对照**（本项目「自检必须能证伪」的纪律），逐项各一次：

| 注入 | 预期 | 实测 |
|---|---|---|
| `about/index.html` 注入缺斜杠 URL | 检查 1 失败 | ✅ 定位到 `AboutPage.url` + `ListItem.item` |
| `about/index.html` 的 canonical 改成首页 | 检查 2 失败 | ✅ 指出「应为 `/about/`，实际为 `/`」 |
| 给 `404.html` 加上 `canonical="/404/"` | 检查 2 失败 | ✅ 指出「非目录式页面不应声明 canonical」 |
| `about/index.html` 注入坏图片 + 坏链接 | 检查 3 失败 | ✅ 两条都列出，计数 1224 → 1226，且检查 1/2 仍绿 |

还原后 `exit=0`。**改完 SEO / 链接相关代码后应跑一次。**

## 五、顺带核实的其它项（均无问题）

| 检查 | 结果 |
|---|---|
| 产物里 apex 绝对链接 | **0 条** |
| sitemap 18 条 `<loc>` | 全是规范形式 |
| 各页 `canonical` | 18 个目录式页面全部自指（首页为裸 origin，正确） |
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

## 七、同类的第三处：404 页的 canonical（已修）

把「检查 1」的思路推到极致就会发现：**404 页也在声明一个会跳转的 URL 作为自己的规范地址**，
只是检查器最初只扫 JSON-LD 与 `<a href>`，扫不到 `<link rel="canonical">`。

**缺陷**：

```
dist/404.html:  <link rel="canonical" href="https://www.image-2-stl.com/404/">
实测：https://www.image-2-stl.com/404/  →  308  →  /404
```

**为什么不能简单地「改成 `/404`」**：`404.html` 会被 Cloudflare Pages 用于服务**任意**未匹配路径，
它没有属于自己的规范 URL。指 `/404` 只是换了一个同样不成立的地址。

**为什么不能简单地「删掉这个 prop」**：`SeoHead.astro` 里 `canonical` 有默认值
`"https://www.image-2-stl.com"` —— 删掉 prop 会让 404 页的 canonical **退化成指向首页**，
那比现在更糟（等于把所有 404 都声明成首页的副本）。

**修法**：让 `canonical` 支持「显式省略」。

- `src/components/SeoHead.astro`：`canonical?: string` → `canonical?: string | null`，
  并把 `<link rel="canonical">` 与 `<meta property="og:url">` 改为条件渲染（`{canonical && ...}`）。
- `src/layouts/BaseLayout.astro`：透传类型同步为 `string | null`。
- `src/pages/404.astro`：`canonical={null}`（该页已有的 `noindex` 保持不变）。

**验证**（构建产物实测）：

```
dist/404.html          rel="canonical" 0 条、og:url 0 条、robots=noindex ✓
其余 18 个页面         canonical 各 1 条，总数 18，全部自指 ✓
audit-canonical-urls   两项检查通过，exit=0 ✓
```

**影响评估**：这一处**本来就是零影响**（404 页有 `noindex`，不会被索引）。
修它的价值在于**一致性** —— 站点不应存在任何「声明跳转 URL 为自己的规范地址」的地方，
否则同类问题会以新形式复现。这也是把它固化成检查器第二项的原因。



---

# 第四部分：延伸审计（二）—— 站内引用可达性

> 起因：把「声明一个不可达的 URL」这条线继续推下去。
> 前三部分解决的都是「URL 形式不对」，但还有一个更基本的问题从没被问过：
> **被指向的那个东西，到底存不存在？**

## 一、新增检查 3

原来的审计只查 URL 形式与 canonical 自指，两者都建立在「引用是可达的」这个**未经验证的假设**上。
补上检查 3，覆盖这些引用来源：

| 来源 | 取什么 |
|---|---|
| `<a href>` | 站内链接 |
| `<img>` / `<source>` | `src` 与 `srcset`（`srcset` 按逗号拆候选，丢掉描述符） |
| `<script src>` | 脚本 |
| `<link href>` | 样式表、preload、icon… |
| `<meta property/name>` | `og:image`、`og:image:url`、`og:image:secure_url`、`twitter:image` |
| 内联 `<style>` | `url(...)`（字体、背景图） |

解析规则：

- 去掉 `?query` 与 `#fragment`，并对路径做 URL 解码；
- 绝对 URL 只在主机属于本站时检查，外部主机跳过；
- 以 `/` 开头按产物根解析，相对路径按**该页面所在目录**解析；
- 末尾 `/` → 找 `<path>/index.html`；带扩展名 → 当文件找；
  不带扩展名的裸路径 → **先当文件找，再当目录页找**（后者会 308，但存在就不算断链）；
- `mailto:` / `tel:` / `javascript:` / `data:` / `blob:` / `#` / `?` 开头一律跳过。

## 二、第一次运行就抓到真实缺陷：`/favicon.ico`

```
✗ 检查 3 失败：1 个引用指向 dist/ 里不存在的文件
   /favicon.ico
        ← 404.html [link href]
        ← about/index.html [link href]
        ← blog/3d-printing-basics/index.html [link href]
        ← … 另有 15 处
```

**19 个页面全部声明了 `/favicon.ico`，而 `public/` 里只有 `favicon.svg`。**

线上实测：

```
https://www.image-2-stl.com/favicon.ico  →  404
https://www.image-2-stl.com/favicon.svg  →  200
```

这与前三部分是**同一类缺陷**（`af20df5` 删掉的 `SearchAction` 也是这个形状）：
**文档主动声明了一个解析不到的地址。**

### 而且是两个错误叠在一起

`src/layouts/BaseLayout.astro:154` 原文：

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="alternate icon" href="/favicon.ico" />
```

1. **`rel="alternate icon"` 不是有效的图标关系** —— 浏览器只认 `icon` / `shortcut icon`，
   所以这行**从来没起到过回退作用**，哪怕文件存在也一样。
2. **它指向的文件不存在** —— 于是变成纯粹的 404 来源。

### 为什么「删掉这行」不是最好的修法

因为它想解决的问题是真的：**Safari 不支持 SVG favicon**（macOS 与 iOS 都不支持）。
只声明 `image/svg+xml` 的话，**Safari 用户看到的标签页完全没有图标**。
`rel="alternate icon"` 这行的**意图是对的，实现是错的**。

所以正确修法是**把文件真的补上**，并把 `rel` 改成有效值。

## 三、修法

### 1. 生成真实的 `favicon.ico`

新增 `scripts/make-favicon-ico.mjs`：

- `sharp` 把 `public/favicon.svg` 栅格化成 16 / 32 / 48 px 的 PNG；
- 在本脚本里直接拼 ICO 容器（**Windows Vista 起 ICO 条目可以直接放 PNG 数据**，
  所以不需要写 BMP 编码）。

```bash
npm run favicon        # 改了 favicon.svg 之后跑一次
```

**为什么用脚本生成而不是手提交一个二进制**：手提交的话，改了 SVG 忘了重新导出就会两者不一致，
而且没人看得出来。生成式保证两者不可能漂移。

产物校验（用 PIL 真实解码，不只是看文件头）：

```
PIL 解码 favicon.ico: ICO (48, 48) RGBA
ICONDIR: reserved=0 type=1 count=3
  #0: 16x16 bpp=32 bytes=484  offset=54    PNG=True
  #1: 32x32 bpp=32 bytes=801  offset=538   PNG=True
  #2: 48x48 bpp=32 bytes=1005 offset=1339  PNG=True
```

偏移自洽（`6 + 3×16 = 54`、`54+484 = 538`、`538+801 = 1339`、`1339+1005 = 2344` = 文件大小），
渲染出来是蓝底圆角 + 白色立方体线稿，三个尺寸都清晰。

### 2. 修正 head 声明

```diff
-    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
-    <link rel="alternate icon" href="/favicon.ico" />
+    <link rel="icon" href="/favicon.ico" />
+    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
```

**顺序是刻意的**：ICO 在前、SVG 在后 —— 老消费者拿 ICO，支持 SVG 的拿 SVG。

### 3. 顺带把脚本接进 `package.json`

```json
"favicon": "node scripts/make-favicon-ico.mjs",
"audit:urls": "python scripts/audit-canonical-urls.py"
```

一个没人知道的检查脚本等于不存在。

## 四、验证

| 检查 | 结果 |
|---|---|
| 构建产物 `dist/favicon.ico` | 存在（2344 B）✓ |
| 产物 head icon 声明 | 19 页 × 2 条（ICO + SVG），`alternate icon` 残留 **0** ✓ |
| 审计三项 | 全绿 `exit=0` ✓ |
| 负向对照（注入坏图片 + 坏链接） | 两条都被列出，计数 1224 → 1226，检查 1/2 未受污染 ✓ |
| **线上 `favicon.ico`** | **200**，`content-type: image/vnd.microsoft.icon` ✓ |
| **线上内容一致性** | 字节数 2344 = 2344，**sha256 完全相同** ✓ |
| 线上 head | 2 条 icon 声明、无 `alternate icon` ✓ |

**线上内容用哈希比对而不是只看状态码** —— 200 只说明「有东西」，不说明「是对的东西」。

## 五、顺带确认：检查 3 没有误报

1224 处站内引用里，除 `favicon.ico` 外**零误报** —— 字体 preload、`/_astro/*.js`、
gallery 图片、内联 CSS 里的 `url()` 全部正确解析为「存在」。
误报是这类检查器最大的风险（一旦误报，人就会开始忽略它），所以这个数字比「抓到了 1 个」更重要。

## 六、第四部分的结论

前三部分是「URL **形式**不对」，第四部分是「引用**目标**不存在」——
**两种都不报错，都只能在浏览器或审计工具里显形。**

新增的检查 3 让这一类问题从「靠运气发现」变成「构建后必查」。
`npm run audit:urls` 现在是改完任何 SEO / 链接 / 资源相关代码后的固定动作。
