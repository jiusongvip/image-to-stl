"""Subset the Geist webfonts to the glyphs this site actually uses.

The site content is 100% ASCII (verified against the built HTML), but the
upstream Geist files carry 645 glyphs each (~40 KB per weight). Subsetting to
the printable ASCII set plus the handful of typographic marks the copy uses
drops ~66% of every file.

Re-runnable: fetches from the pinned jsdelivr source, writes into
public/fonts/, and prints a size report. Run after adding new copy that
introduces characters outside the documented range.
"""

import os
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

OUT_DIR = "public/fonts"
TMP_DIR = ".fonttest"
VERSION = "1.3.1"

# Weights actually referenced by src/styles/global.css.
SANS = ["Regular", "Medium", "SemiBold", "Bold"]
MONO = ["Regular", "Medium", "SemiBold"]

# Printable ASCII + no-break space + the punctuation the copy uses
# (en/em dash, curly quotes, ellipsis, degree, multiply, minus, arrow).
UNICODES = (
    "U+0020-007E,U+00A0,U+2013-2014,U+2018-201D,"
    "U+2026,U+00D7,U+2212,U+00B0,U+2192"
)


def source_url(family: str, weight: str) -> str:
    folder = "geist-sans" if family == "sans" else "geist-mono"
    return f"https://cdn.jsdelivr.net/npm/geist@{VERSION}/dist/fonts/{folder}/Geist{'' if family == 'sans' else 'Mono'}-{weight}.woff2"


def fetch(url: str, dest: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    with open(dest, "wb") as fh:
        fh.write(data)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(TMP_DIR, exist_ok=True)

    jobs = [(fam, w) for fam in ("sans", "mono") for w in (SANS if fam == "sans" else MONO)]
    total_before = total_after = 0

    for family, weight in jobs:
        name = ("Geist" if family == "sans" else "GeistMono") + "-" + weight
        url = source_url(family, weight)
        raw = os.path.join(TMP_DIR, name + ".woff2")
        out = os.path.join(OUT_DIR, name + ".woff2")

        fetch(url, raw)
        before = os.path.getsize(raw)

        subset.main(
            [
                raw,
                f"--unicodes={UNICODES}",
                "--layout-features=*",
                "--flavor=woff2",
                f"--output-file={out}",
            ]
        )
        after = os.path.getsize(out)

        # Guard: never ship a subset that lost a glyph the site needs.
        needed = set(range(0x20, 0x7F)) | {
            0xA0, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D,
            0x2026, 0xD7, 0x2212, 0xB0, 0x2192,
        }
        cmap = TTFont(out).getBestCmap()
        missing = sorted(needed - set(cmap))
        if missing:
            raise SystemExit(f"{name}: subset is missing {[hex(c) for c in missing]}")

        total_before += before
        total_after += after
        print(
            f"  {name:<24} {before:>7} -> {after:>7} bytes "
            f"({(1 - after / before) * 100:>4.1f}% smaller, {len(cmap)} glyphs)"
        )

    print(
        f"\n  TOTAL {total_before} -> {total_after} bytes "
        f"({(1 - total_after / total_before) * 100:.1f}% smaller)"
    )


if __name__ == "__main__":
    main()
