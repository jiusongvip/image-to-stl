#!/usr/bin/env python3
"""审计 dist/ 产物里的 URL 一致性与可达性。

背景：本站在 astro.config.mjs 里声明了
    site: "https://www.image-2-stl.com"
    trailingSlash: "always"
所以唯一规范形式是 `https://www.image-2-stl.com/<路径>/`。
任何缺尾斜杠 / 缺 www / http 明文的站内 URL 都会走 301/308 跳转，
出现在 GSC「网页会自动重定向」报告里，并浪费抓取预算。

三项检查：

  1. 站内 URL 是否都是规范形式
     扫 <a href> 与 JSON-LD 里的每个 URL。非规范写法 = 站点自己制造重定向源。
     （真实案例：BreadcrumbList 的 item 曾全部缺尾斜杠。）

  2. 每个页面的 <link rel="canonical"> 是否自指
     canonical 必须等于该页面自身的规范 URL；指向别处 = 让 Google 去抓另一个地址，
     指向一个会跳转的 URL 更是直接制造重定向。
     （真实案例：404 页曾声明 canonical=/404/，而该 URL 308 跳到 /404。）

  3. 站内链接与资源引用是否指向 dist/ 里真实存在的文件
     覆盖 <a href>、<img src/srcset>、<source src/srcset>、<script src>、<link href>、
     <meta> 里的 og:image / twitter:image，以及内联 <style> 里的 url()。
     链接指到不存在的路径 = 站内 404（浪费抓取预算 + 断掉内链权重传导）；
     资源指到不存在的文件 = 静默降级（图片不显示、字体回退、preload 白下）。
     这类问题构建不会报错，只有在浏览器里才会显形。

用法：
    npm run build
    python scripts/audit-canonical-urls.py [--verbose]

退出码：0 = 全部通过；1 = 发现问题；2 = dist/ 不存在。
"""

from __future__ import annotations

import glob
import json
import os
import posixpath
import re
import sys
from urllib.parse import unquote, urlsplit

DIST = "dist"
ORIGIN = "https://www.image-2-stl.com"
CANON_HOST = "www.image-2-stl.com"
SELF_HOSTS = {CANON_HOST, "image-2-stl.com"}
VERBOSE = "--verbose" in sys.argv

# 结构化数据里承载 URL 的常见键
URL_KEYS = ("url", "item", "itemListElement", "@id", "target", "sameAs", "contentUrl")

# 这些前缀不是可抓取的站内地址，跳过
SKIP_PREFIXES = ("#", "mailto:", "tel:", "sms:", "javascript:", "data:", "blob:", "?")

# <meta> 里承载图片 URL 的键
META_IMAGE_KEYS = ("og:image", "og:image:url", "og:image:secure_url", "twitter:image")


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


def target_paths(ref: str, page_rel: str) -> list[str] | None:
    """把一个引用解析成「可能对应哪些 dist/ 内文件」。

    返回候选相对路径列表（按优先级），None 表示不需要检查
    （外部域名、锚点、特殊协议）。
    """
    raw = ref.strip()
    if not raw or raw.startswith(SKIP_PREFIXES):
        return None

    parts = urlsplit(raw)
    if parts.scheme and parts.scheme not in ("http", "https"):
        return None
    if parts.netloc:
        if parts.netloc not in SELF_HOSTS:
            return None                      # 外部资源，不归本站管
        path = parts.path
    else:
        path = parts.path

    path = unquote(path)
    if not path:
        return None

    # 相对路径 -> 相对产物根
    if not path.startswith("/"):
        base = posixpath.dirname(page_rel)
        path = posixpath.normpath(posixpath.join(base, path))
        if path.startswith(".."):
            return None                      # 指到 dist/ 之外，不检查
        path = "/" + path

    rel = path.lstrip("/")
    if rel == "" or rel.endswith("/"):
        return [posixpath.join(rel, "index.html")]
    # 无扩展名的裸路径：先当文件，再当目录式页面（后者会 308，但存在即不算断链）
    if is_static_file(rel):
        return [rel]
    return [rel, posixpath.join(rel, "index.html")]


def split_srcset(value: str) -> list[str]:
    out = []
    for candidate in value.split(","):
        candidate = candidate.strip()
        if not candidate:
            continue
        out.append(candidate.split()[0])
    return out


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

    offenders: dict[str, set[str]] = {}       # 检查 1
    canonical_issues: list[str] = []          # 检查 2
    broken: dict[str, set[str]] = {}          # 检查 3
    breadcrumbs: dict[str, set[str]] = {}
    jsonld_blocks = 0
    jsonld_broken = 0
    canonical_ok = 0
    refs_checked = 0

    def record(url: str, where: str) -> None:
        parts = urlsplit(url)
        if parts.netloc not in SELF_HOSTS:
            return
        if classify(parts.path) == "缺尾斜杠（会 308）":
            offenders.setdefault(url, set()).add(where)

    def check_ref(ref: str, where: str, page_rel: str) -> None:
        """检查 3 的核心：引用是否能落到 dist/ 里真实存在的文件。"""
        nonlocal refs_checked
        candidates = target_paths(ref, page_rel)
        if candidates is None:
            return
        refs_checked += 1
        if any(os.path.exists(os.path.join(DIST, c)) for c in candidates):
            return
        broken.setdefault(ref.strip(), set()).add(where)

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

        # --- 检查 3a：<a href> 是否可达 ---
        for m in re.finditer(r'<a\b[^>]*?\shref="([^"]+)"', html, re.I):
            check_ref(m.group(1), f"{rel} [a href]", rel)

        # --- 检查 3b：<img> / <source> 的 src 与 srcset ---
        for m in re.finditer(r'<(?:img|source)\b[^>]*?\ssrc="([^"]+)"', html, re.I):
            check_ref(m.group(1), f"{rel} [src]", rel)
        for m in re.finditer(r'<(?:img|source)\b[^>]*?\ssrcset="([^"]+)"', html, re.I):
            for candidate in split_srcset(m.group(1)):
                check_ref(candidate, f"{rel} [srcset]", rel)

        # --- 检查 3c：<script src> / <link href> ---
        for m in re.finditer(r'<script\b[^>]*?\ssrc="([^"]+)"', html, re.I):
            check_ref(m.group(1), f"{rel} [script src]", rel)
        for m in re.finditer(r'<link\b[^>]*?\shref="([^"]+)"', html, re.I):
            check_ref(m.group(1), f"{rel} [link href]", rel)

        # --- 检查 3d：<meta> 里的社交图片 ---
        for m in re.finditer(
            r'<meta\b[^>]*?\s(?:property|name)="([^"]+)"[^>]*?\scontent="([^"]+)"',
            html,
            re.I,
        ):
            if m.group(1) in META_IMAGE_KEYS:
                check_ref(m.group(2), f"{rel} [meta {m.group(1)}]", rel)

        # --- 检查 3e：内联 <style> 里的 url() ---
        for style in re.finditer(r"<style[^>]*>(.*?)</style>", html, re.S | re.I):
            for m in re.finditer(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", style.group(1)):
                check_ref(m.group(1), f"{rel} [inline css url()]", rel)

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
    print(f"站内引用检查 {refs_checked} 处（链接 + 资源）")
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

    if broken:
        failed = True
        print(f"✗ 检查 3 失败：{len(broken)} 个引用指向 dist/ 里不存在的文件")
        for ref in sorted(broken):
            print(f"   {ref}")
            for where in sorted(broken[ref])[:4]:
                print(f"        ← {where}")
            if len(broken[ref]) > 4:
                print(f"        ← … 另有 {len(broken[ref]) - 4} 处")
        print("   修法：改引用指向真实文件，或补上缺失的资源。")
        print()
    else:
        print("✓ 检查 3 通过：站内链接与资源引用全部可达")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
