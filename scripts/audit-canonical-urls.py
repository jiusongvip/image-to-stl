#!/usr/bin/env python3
"""审计 dist/ 产物里「站内 URL 是否都用了规范形式」。

背景：本站在 astro.config.mjs 里声明了
    site: "https://www.image-2-stl.com"
    trailingSlash: "always"
所以唯一规范形式是 `https://www.image-2-stl.com/<路径>/`。
任何缺尾斜杠 / 缺 www / http 明文的站内 URL 都会走 301/308 跳转，
出现在 GSC「网页会自动重定向」报告里，并浪费抓取预算。

这个脚本专门抓「站点自己喂给 Google 的重定向源」—— 即结构化数据
（JSON-LD）与 <a href> 里写法不规范但指向自己域名的 URL。
它抓到过一次真实缺陷：BreadcrumbList 的 item 全部缺尾斜杠。

用法：
    npm run build
    python scripts/audit-canonical-urls.py [--verbose]

退出码：0 = 全部规范；1 = 发现不规范 URL。
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from urllib.parse import urlsplit

DIST = "dist"
CANON_HOST = "www.image-2-stl.com"
SELF_HOSTS = {CANON_HOST, "image-2-stl.com"}
VERBOSE = "--verbose" in sys.argv

# 结构化数据里承载 URL 的常见键
URL_KEYS = ("url", "item", "itemListElement", "@id", "target", "sameAs", "contentUrl")


def is_static_file(path: str) -> bool:
    """末段带扩展名 = 静态文件，不需要尾斜杠。"""
    tail = path.rsplit("/", 1)[-1]
    return "." in tail


def classify(path: str) -> str:
    if path in ("", "/"):
        return "根路径（无斜杠即规范）"
    if is_static_file(path):
        return "静态文件"
    return "缺尾斜杠（会 308）" if not path.endswith("/") else "规范"


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

    # 不规范 URL -> {来源描述}
    offenders: dict[str, set[str]] = {}
    breadcrumbs: dict[str, set[str]] = {}
    jsonld_blocks = 0
    jsonld_broken = 0

    def record(url: str, where: str) -> None:
        parts = urlsplit(url)
        if parts.netloc not in SELF_HOSTS:
            return
        if classify(parts.path) != "缺尾斜杠（会 308）":
            return
        offenders.setdefault(url, set()).add(where)

    for file_path in pages:
        rel = os.path.relpath(file_path, DIST).replace("\\", "/")
        html = open(file_path, encoding="utf-8").read()

        # 1) <a href> 里的站内链接
        for match in re.finditer(r'<a\b[^>]*?\shref="([^"]+)"', html, re.I):
            href = match.group(1).strip()
            if href.startswith("/") and not href.startswith("//"):
                record(f"https://{CANON_HOST}{href}", f"{rel} [a href]")
            elif href.startswith(("http://", "https://")):
                record(href, f"{rel} [a href]")

        # 2) JSON-LD 里的 URL
        for match in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
            jsonld_blocks += 1
            try:
                obj = json.loads(match.group(1))
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

    if offenders:
        print(f"✗ 发现 {len(offenders)} 个非规范的站内 URL（会触发 308）：")
        for url in sorted(offenders):
            print(f"   {url}")
            for where in sorted(offenders[url]):
                print(f"        ← {where}")
        print()
        print("修法：把 URL 补成规范形式（末尾加 /，主机用 www）。")
        return 1

    print("✓ 所有站内 URL 都是规范形式（www + 尾斜杠）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
