#!/usr/bin/env python3
"""审计 dist/ 产物里的规范 URL 一致性。

背景：本站在 astro.config.mjs 里声明了
    site: "https://www.image-2-stl.com"
    trailingSlash: "always"
所以唯一规范形式是 `https://www.image-2-stl.com/<路径>/`。
任何缺尾斜杠 / 缺 www / http 明文的站内 URL 都会走 301/308 跳转，
出现在 GSC「网页会自动重定向」报告里，并浪费抓取预算。

两项检查：

  1. 站内 URL 是否都是规范形式
     扫 <a href> 与 JSON-LD 里的每个 URL。非规范写法 = 站点自己制造重定向源。
     （真实案例：BreadcrumbList 的 item 曾全部缺尾斜杠。）

  2. 每个页面的 <link rel="canonical"> 是否自指
     canonical 必须等于该页面自身的规范 URL；指向别处 = 让 Google 去抓另一个地址，
     指向一个会跳转的 URL 更是直接制造重定向。
     （真实案例：404 页曾声明 canonical=/404/，而该 URL 308 跳到 /404。）

用法：
    npm run build
    python scripts/audit-canonical-urls.py [--verbose]

退出码：0 = 全部通过；1 = 发现问题；2 = dist/ 不存在。
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from urllib.parse import urlsplit

DIST = "dist"
ORIGIN = "https://www.image-2-stl.com"
CANON_HOST = "www.image-2-stl.com"
SELF_HOSTS = {CANON_HOST, "image-2-stl.com"}
VERBOSE = "--verbose" in sys.argv

# 结构化数据里承载 URL 的常见键
URL_KEYS = ("url", "item", "itemListElement", "@id", "target", "sameAs", "contentUrl")


def is_static_file(path: str) -> bool:
    return "." in path.rsplit("/", 1)[-1]


def classify(path: str) -> str:
    if path in ("", "/"):
        return "根路径"
    if is_static_file(path):
        return "静态文件"
    return "规范" if path.endswith("/") else "缺尾斜杠（会 308）"


def expected_canonical(rel: str) -> str | None:
    """产物里的相对路径 -> 该页面自身的规范 URL。

    目录式页面（index.html）有唯一的规范 URL；
    非目录式页面（如 404.html）会服务任意未匹配路径，没有自己的规范 URL，
    因此返回 None —— 这类页面不应声明 canonical。
    """
    if rel == "index.html":
        return ORIGIN
    if rel.endswith("/index.html"):
        return f"{ORIGIN}/{rel[: -len('index.html')]}"
    return None


def walk_jsonld(node, visit):
    if isinstance(node, dict):
        visit(node)
        for value in node.values():
            walk_jsonld(value, visit)
    elif isinstance(node, list):
        for value in node:
            walk_jsonld(value, visit)


def main() -> int:
    pages = sorted(glob.glob(os.path.join(DIST, "**", "*.html"), recursive=True))
    if not pages:
        print(f"✗ {DIST}/ 下没有 HTML，先跑 npm run build", file=sys.stderr)
        return 2

    offenders: dict[str, set[str]] = {}      # 检查 1
    canonical_issues: list[str] = []          # 检查 2
    breadcrumbs: dict[str, set[str]] = {}
    jsonld_blocks = 0
    jsonld_broken = 0
    canonical_ok = 0

    def record(url: str, where: str) -> None:
        parts = urlsplit(url)
        if parts.netloc not in SELF_HOSTS:
            return
        if classify(parts.path) == "缺尾斜杠（会 308）":
            offenders.setdefault(url, set()).add(where)

    for file_path in pages:
        rel = os.path.relpath(file_path, DIST).replace("\\", "/")
        html = open(file_path, encoding="utf-8").read()

        # --- 检查 2：canonical 自指 ---
        match = re.search(r'<link rel="canonical" href="([^"]*)"', html)
        found = match.group(1) if match else None
        want = expected_canonical(rel)
        if want is None:
            if found:
                canonical_issues.append(
                    f"{rel}: 非目录式页面不应声明 canonical，却声明了 {found}"
                )
            elif VERBOSE:
                print(f"   {rel}: 无 canonical（正确）")
        elif found != want:
            canonical_issues.append(
                f"{rel}: canonical 应为 {want}，实际为 {found or '(缺失)'}"
            )
        else:
            canonical_ok += 1

        # --- 检查 1a：<a href> ---
        for m in re.finditer(r'<a\b[^>]*?\shref="([^"]+)"', html, re.I):
            href = m.group(1).strip()
            if href.startswith("/") and not href.startswith("//"):
                record(f"{ORIGIN}{href}", f"{rel} [a href]")
            elif href.startswith(("http://", "https://")):
                record(href, f"{rel} [a href]")

        # --- 检查 1b：JSON-LD ---
        for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
            jsonld_blocks += 1
            try:
                obj = json.loads(m.group(1))
            except Exception as exc:  # noqa: BLE001
                jsonld_broken += 1
                print(f"✗ JSON-LD 解析失败 {rel}: {exc}", file=sys.stderr)
                continue

            def visit(node: dict, rel: str = rel) -> None:
                node_type = node.get("@type")
                if node_type == "BreadcrumbList":
                    for item in node.get("itemListElement", []):
                        url = item.get("item") if isinstance(item, dict) else None
                        if isinstance(url, str):
                            breadcrumbs.setdefault(url, set()).add(rel)
                for key in URL_KEYS:
                    value = node.get(key)
                    if isinstance(value, str) and value.startswith(("http://", "https://")):
                        record(value, f"{rel} [{node_type}.{key}]")

            walk_jsonld(obj, visit)

    print(f"扫描 {len(pages)} 个页面，{jsonld_blocks} 个 JSON-LD 块（解析失败 {jsonld_broken} 个）")
    print()

    if VERBOSE:
        print("BreadcrumbList 的 item URL：")
        for url in sorted(breadcrumbs):
            print(f"   {classify(urlsplit(url).path):<22} {url}")
        print()

    failed = False

    if offenders:
        failed = True
        print(f"✗ 检查 1 失败：{len(offenders)} 个非规范的站内 URL（会触发 308）")
        for url in sorted(offenders):
            print(f"   {url}")
            for where in sorted(offenders[url]):
                print(f"        ← {where}")
        print("   修法：补成规范形式（末尾加 /，主机用 www）。")
        print()
    else:
        print("✓ 检查 1 通过：站内 URL 都是规范形式（www + 尾斜杠）")

    if canonical_issues:
        failed = True
        print(f"✗ 检查 2 失败：{len(canonical_issues)} 个页面的 canonical 不自指")
        for issue in canonical_issues:
            print(f"   {issue}")
        print("   修法：让 canonical 等于页面自身 URL；404 这类页面应传 canonical={null} 省略该标签。")
        print()
    else:
        print(f"✓ 检查 2 通过：{canonical_ok} 个页面的 canonical 全部自指")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
