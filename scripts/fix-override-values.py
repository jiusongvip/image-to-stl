"""Rewrite the metric-override values in src/styles/global.css.

Derivation (see the comment block in global.css):
  Geist hhea: ascender 920, descender -220, lineGap 100, upem 1000.
  `line-height: normal` box = (920 + 220 + 100) / 1000 = 124.0%
  which matches the independently measured Geist ratio of 1.24 at 100px.

  Therefore for a fallback face to occupy the same line box it must expose
    ascent-override  * size-adjust = (920 + 100)/1000 = 102%
    descent-override * size-adjust =  220     /1000 =  22%
  (lineGap is folded into the ascent, since the override API has no line-gap.)

  Empirically verified: for the current faces the model
  override_sum * size_adjust predicted 184.56% against a measured 183.89%.

Run:  python scripts/fix-override-values.py
"""
import re
import pathlib

P = pathlib.Path(__file__).resolve().parent.parent / "src" / "styles" / "global.css"

ASC = 1.02   # (920 + 100) / 1000
DESC = 0.22  # 220 / 1000


def fix_block(body: str) -> str:
    if "local(" not in body:
        return body
    fam_m = re.search(r"font-family:\s*[\"']?([^;\"'\n]+)", body)
    fam = fam_m.group(1).strip() if fam_m else "?"
    wt_m = re.search(r"font-weight:\s*(\d+)", body)
    wt = wt_m.group(1) if wt_m else "400"
    sa = re.search(r"size-adjust:\s*([\d.]+)%", body)
    if not sa:
        return body
    sadj = float(sa.group(1)) / 100.0
    a = ASC / sadj * 100
    d = DESC / sadj * 100
    body = re.sub(r"ascent-override:\s*[\d.]+%", "ascent-override: %.2f%%" % a, body)
    body = re.sub(r"descent-override:\s*[\d.]+%", "descent-override: %.2f%%" % d, body)
    print("  %s w%s: size-adjust %.2f%% -> ascent %.2f%%  descent %.2f%%"
          % (fam, wt, sadj * 100, a, d))
    return body


src = P.read_text(encoding="utf-8")
out = re.sub(r"@font-face\s*\{[^}]*\}", lambda m: fix_block(m.group(0)), src)
P.write_text(out, encoding="utf-8")
print("\nwritten: %s" % P)
