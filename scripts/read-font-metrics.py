"""Read the hhea/OS-2 metrics that determine a font's `line-height: normal` box.

This is the authoritative source for the fallback faces' ascent-override and
descent-override. Guessing those numbers from a ratio between two fonts is what
produced a descent-override nearly 4x too large (87.66% instead of 20.61%),
which inflated every fallback line box to ~184% of the em and caused a
page-wide vertical layout shift once the real font arrived.

The browser computes `line-height: normal` as:

    (hhea.ascender + abs(hhea.descender) + hhea.lineGap) / unitsPerEm

Verified independently in the browser: Geist measures 124px at font-size 100px,
and (920 + 220 + 100) / 1000 = 124.0%. They agree exactly.

The `ascent-override` / `descent-override` descriptors have no line-gap slot, so
fold lineGap into the ascent. Remember size-adjust also scales both overrides,
so divide by each face's own size-adjust:

    ascentOverride  = ((ascender + lineGap) / upem) / sizeAdjust
    descentOverride = (abs(descender)    / upem) / sizeAdjust

Run: python scripts/read-font-metrics.py [--size-adjust 106.73]
"""
import argparse
import pathlib
import sys

try:
    from fontTools.ttLib import TTFont
except ImportError:
    sys.exit("需要 fonttools：pip install fonttools brotli")

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "public" / "fonts"

FONTS = [
    "Geist-Regular",
    "Geist-Medium",
    "Geist-SemiBold",
    "Geist-Bold",
    "GeistMono-Regular",
    "GeistMono-Medium",
    "GeistMono-SemiBold",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--size-adjust",
        type=float,
        default=None,
        help="若给出，同时算出自适应该 size-adjust 的 override 值",
    )
    args = ap.parse_args()

    print("字体文件的 hhea 度量（决定 line-height: normal 的行盒）\n")
    for name in FONTS:
        p = FONT_DIR / f"{name}.woff2"
        if not p.exists():
            print(f"  跳过（不存在）: {name}")
            continue
        f = TTFont(str(p))
        upem = f["head"].unitsPerEm
        hhea = f["hhea"]
        asc, desc, gap = hhea.ascender, hhea.descender, hhea.lineGap
        normal = (asc - desc + gap) / upem
        sans_gap = (asc - desc) / upem
        print(f"=== {name} (upem={upem}) ===")
        print(f"  ascender={asc} descender={desc} lineGap={gap}")
        print(f"  line-height:normal 行盒 = ({asc} + {-desc} + {gap})/{upem} = {normal * 100:.2f}%")
        print(f"  不含 lineGap = {sans_gap * 100:.2f}%")
        print(f"  等比拆分为 ascent={asc / upem * 100:.2f}% descent={-desc / upem * 100:.2f}%")
        if args.size_adjust:
            sa = args.size_adjust / 100.0
            a = (asc + gap) / upem / sa
            d = -desc / upem / sa
            print(f"  size-adjust {args.size_adjust:.2f}% 下需要的："
                  f"ascent-override {a * 100:.2f}%  descent-override {d * 100:.2f}%")
        print()


if __name__ == "__main__":
    main()
