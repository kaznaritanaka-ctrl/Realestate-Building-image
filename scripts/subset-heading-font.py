"""見出し用フォント（Zen Kaku Gothic New Bold、SIL OFL 1.1）を、見出しで使う文字だけに絞って書き出す。

使い方: python3 scripts/subset-heading-font.py <ZenKakuGothicNew-Bold.ttf の場所>
  元のフォント: https://github.com/googlefonts/zen-kakugothic （fonts/ttf/）
  必要なもの: pip install fonttools brotli

site/ 以下の HTML の h1・h2・h3・サイト名から文字を集める。見出しの文言を変えたら、もう一度実行する
（入っていない文字は本文用のフォントで表示されるので、崩れはしないが見た目が混ざる）。
"""
import glob, html, re, subprocess, sys
src = sys.argv[1]
chars = set("土地の未来図β版、。・？！「」（）／〜ー…％" + "".join(chr(c) for c in range(0x20, 0x7F)) + "".join(chr(c) for c in range(0x3041, 0x3097)) + "".join(chr(c) for c in range(0x30A1, 0x30FD)) + "０１２３４５６７８９")
for f in glob.glob("site/**/*.html", recursive=True):
    t = open(f, encoding="utf-8").read()
    for m in re.finditer(r'<(h1|h2|h3)\b[^>]*>(.*?)</\1>|class="brand"[^>]*>(.*?)</a>', t, re.S):
        chars |= set(html.unescape(re.sub(r"<[^>]+>", "", m.group(2) or m.group(3) or "")))
chars = {c for c in chars if c >= " "}
out = "site/assets/fonts/zen-kaku-gothic-new-bold-head.woff2"
subprocess.run(["pyftsubset", src, f"--text={''.join(sorted(chars))}", "--flavor=woff2", f"--output-file={out}", "--layout-features=palt,kern", "--no-hinting", "--desubroutinize"], check=True)
import os; print(len(chars), "文字", os.path.getsize(out), "bytes")
