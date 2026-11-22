"""窓口データをまとめて site/assets/offices.json を作る（ブラウザが都道府県・市区町村から窓口を引く）

形式: {"checked": 確認日, "tax": [[名前, 電話, 出典URL], ...], "court": [...], "city": [...],
       "moj": {法務局の庁名: [電話, 出典URL]},
       "map": {都道府県: {市区町村: [[税務署の添字...], [家裁の添字...], 一部フラグ, 役所の添字]}}}
一部フラグ: 1=税務署が町名などで分かれる、2=家裁が分かれる
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, HOUMU
import tax, court, city, moj

def main():
    t, tm = tax.build()
    cc, cm = court.build()
    y, ym = city.build()
    m, mm = moj.build()
    if tm or cm or ym or mm:
        sys.exit(f"未割当があります: 税務署 {tm} 家裁 {cm} 役所 {ym} 法務局 {mm}")
    tables = {"tax": [], "court": [], "city": []}
    idx = {"tax": {}, "court": {}, "city": {}}
    def ref(kind, o):
        key = o.get("key", o["name"])
        if key not in idx[kind]:
            idx[kind][key] = len(tables[kind])
            tables[kind].append([o["name"], o["tel"], o["url"]])
        return idx[kind][key]
    out = {}
    for pref, cities in HOUMU.items():
        for c in cities:
            to, co = t[pref][c], cc[pref][c]
            flag = (1 if any(o["part"] for o in to) else 0) | (2 if any(o["part"] for o in co) else 0)
            yo = {**y[pref][c], "key": pref + c}
            out.setdefault(pref, {})[c] = [[ref("tax", o) for o in to], [ref("court", o) for o in co], flag, ref("city", yo)]
    data = {"checked": "2026-11-23", **tables, "moj": {k: list(v) for k, v in m.items()}, "map": out}
    p = os.path.join(ROOT, "site/assets/offices.json")
    json.dump(data, open(p, "w"), ensure_ascii=False, separators=(",", ":"))
    print("offices.json:", len(tables["tax"]), "税務署", len(tables["court"]), "家裁", len(tables["city"]), "役所", len(m), "法務局", os.path.getsize(p) // 1024, "KB")

if __name__ == "__main__":
    main()
