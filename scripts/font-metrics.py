#!/usr/bin/env python3
"""Derive the metric-override numbers for the "Geist Fallback" faces.

Why this exists
---------------
The Tailwind font stack names `Geist Fallback` / `Geist Mono Fallback`, but a
family named in a font stack and never declared via @font-face is silently
skipped. The browser fell through to `system-ui`, so with `font-display: swap`
the hero painted in the system font and then re-laid-out when Geist arrived —
a reproducible CLS of 0.0126–0.0202 (the paragraph lost a whole line).

The fix is a fallback face that renders in the system font but forces its
metrics to match Geist, so swapping changes glyph shapes only.

The formulas (same as Next.js `next/font` uses):

    size-adjust       = fallback.avgAdvance / target.avgAdvance
    ascent-override   = target.ascent  / fallback.ascent
    descent-override  = target.descent / fallback.descent
    line-gap-override = target.gap     / fallback.gap   (skip if fallback gap = 0)

`size-adjust` scales every glyph advance; the ascent/descent overrides then
re-express the *already scaled* font's vertical metrics in the target's terms —
which is why they do NOT depend on the target's own size-adjust.

Run
---
    python scripts/font-metrics.py

It prints the @font-face blocks to paste into src/styles/global.css. It reads
the real subset woff2 files from public/fonts/ and the system fonts it can find;
requires `fonttools` (`pip install fonttools brotli`).
"""

import os
import sys

try:
    from fontTools.ttLib import TTFont
except ImportError:
    sys.exit("需要 fonttools：pip install fonttools brotli")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# The family we are matching, and the weight buckets that need their own face.
# Only weights that differ materially in average advance need a separate entry;
# 400/500/600 share Geist's regular-ish widths closely enough that one face
# covers them, but 700 is measurably wider, so it gets its own.
TARGETS = [
    ("Geist",          400, "Geist-Regular.woff2"),
    ("Geist",          700, "Geist-Bold.woff2"),
    ("Geist Mono",     400, "GeistMono-Regular.woff2"),
]

# Fallbacks in the order they appear in the stack. We compute against a single
# representative per platform and emit one rule each, because CSS `local()`
# makes the browser pick whichever exists — so several rules for the same
# family would just conflict. We standardise on the Windows default, which is
# what the large majority of this site's traffic resolves to.
REFERENCE_FONTS = [
    ("Segoe UI", ["C:/Windows/Fonts/segoeui.ttf",
                  "C:/Windows/Fonts/segoeui.ttc"]),
    ("Arial",    ["C:/Windows/Fonts/arial.ttf",
                  "C:/Windows/Fonts/arial.ttf",
                  "/System/Library/Fonts/Supplemental/Arial.ttf"]),
]

# Which fallback each emitted face targets. Segoe UI is the Windows default and
# the dominant case, so the rules are computed against it.
PRIMARY = "Segoe UI"


def face_metrics(path):
    f = TTFont(path, fontNumber=0)
    upm = f["head"].unitsPerEm
    hhea, os2 = f["hhea"], f["OS/2"]
    cmap, hmtx = f.getBestCmap(), f["hmtx"]

    lower = "abcdefghijklmnopqrstuvwxyz"
    widths = [hmtx[cmap[ord(c)]][0] for c in lower if ord(c) in cmap]
    avg = (sum(widths) / len(widths) / upm) if widths else 0.0

    return {
        "upm": upm,
        "asc": hhea.ascent / upm,
        # hhea.descent is negative by convention; overrides take a magnitude.
        "desc": abs(hhea.descent) / upm,
        "gap": max(hhea.lineGap, 0) / upm,
        "avg": avg,
    }


def find(cands):
    for c in cands:
        if os.path.exists(c):
            return c
    return None


def main():
    refs = {}
    for name, cands in REFERENCE_FONTS:
        p = find(cands)
        if p:
            refs[name] = face_metrics(p)
            print(f"# reference {name:<10} {os.path.basename(p)}  "
                  f"avg={refs[name]['avg']:.4f} "
                  f"asc={refs[name]['asc']:.4f} desc={refs[name]['desc']:.4f} "
                  f"gap={refs[name]['gap']:.4f}")
    if PRIMARY not in refs:
        sys.exit(f"找不到参考字体 {PRIMARY}")
    ref = refs[PRIMARY]

    print()
    for fam, weight, fname in TARGETS:
        path = os.path.join(ROOT, "public", "fonts", fname)
        if not os.path.exists(path):
            sys.exit(f"缺少字体文件：{path}")
        t = face_metrics(path)

        size_adjust = ref["avg"] / t["avg"] * 100
        asc_ov = t["asc"] / ref["asc"] * 100
        desc_ov = t["desc"] / ref["desc"] * 100
        gap_ov = (t["gap"] / ref["gap"] * 100) if ref["gap"] > 0 else None

        fallback_family = "Geist Mono Fallback" if "Mono" in fam else "Geist Fallback"
        print("@font-face {")
        print(f'  font-family: "{fallback_family}";')
        print('  src: local("Segoe UI"), local("Arial"), local("Helvetica Neue");')
        if weight != 400:
            print(f"  font-weight: {weight};")
        print(f"  size-adjust: {size_adjust:.2f}%;")
        print(f"  ascent-override: {asc_ov:.2f}%;")
        print(f"  descent-override: {desc_ov:.2f}%;")
        if gap_ov is not None:
            print(f"  line-gap-override: {gap_ov:.2f}%;")
        else:
            # Both fonts contribute a 0 line gap, so the used line box is
            # unaffected and a percentage would divide by zero.
            print("  /* line-gap-override omitted: reference line gap is 0 */")
        print("}")
        print()


if __name__ == "__main__":
    main()
