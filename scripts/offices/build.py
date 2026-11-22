"""窓口データをまとめて site/assets/offices.json を作る（ブラウザが都道府県・市区町村から窓口を引く）

形式: {"checked": 確認日, "tax": [[名前, 電話, 出典URL], ...], "court": [...],
       "map": {都道府県: {市区町村: [[税務署の添字...], [家裁の添字...], 一部フラグ]}}}
一部フラグ: 1=税務署が町名などで分かれる、2=家裁が分かれる
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, HOUMU
import tax, court

def main():
    t, tm = tax.build()
    c, cm = court.build()
    if tm or cm:
        sys.exit(f"未割当があります: 税務署 {tm} 家裁 {cm}")
    tables = {"tax": [], "court": []}
    idx = {"tax": {}, "court": {}}
    def ref(kind, o):
        key = o["name"]
        if key not in idx[kind]:
            idx[kind][key] = len(tables[kind])
            tables[kind].append([o["name"], o["tel"], o["url"]])
        return idx[kind][key]
    out = {}
    for pref, cities in HOUMU.items():
        for city in cities:
            to, co = t[pref][city], c[pref][city]
            flag = (1 if any(o["part"] for o in to) else 0) | (2 if any(o["part"] for o in co) else 0)
            out.setdefault(pref, {})[city] = [[ref("tax", o) for o in to], [ref("court", o) for o in co], flag]
    data = {"checked": "2026-11-23", **tables, "map": out}
    p = os.path.join(ROOT, "site/assets/offices.json")
    json.dump(data, open(p, "w"), ensure_ascii=False, separators=(",", ":"))
    print("offices.json:", len(tables["tax"]), "税務署", len(tables["court"]), "家裁", os.path.getsize(p) // 1024, "KB")

if __name__ == "__main__":
    main()
