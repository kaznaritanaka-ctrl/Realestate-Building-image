"""data/offices/city/municipal.csv の役所・役場の電話番号を houmukyoku.json の市区町村に対応づける"""
import csv, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, HOUMU, norm

def bare(c):
    """'川辺郡猪名川町' -> '猪名川町'（蒲郡市・小郡市などはそのまま）"""
    return re.sub(r"^.+?郡(?=.+[町村]$)", "", c)

def load():
    rows = {}
    f = open(os.path.join(ROOT, "data/offices/city/municipal.csv"), encoding="utf-8")
    for r in csv.DictReader(l for l in f if not l.startswith("#")):
        k = (r["pref"], norm(r["name"]))
        if r["tel"] or k not in rows: rows[k] = r  # 北海道の泊村は2つある（北方領土の村は電話なし）
    return rows

def office_name(n):
    if n.endswith("区") or n.endswith("市"): return n + "役所"
    return n + "役場"

def build():
    rows = load()
    out, missing = {}, []
    for pref, cities in HOUMU.items():
        for c in cities:
            r = rows.get((pref, norm(bare(c))))
            if r and r["tel"]:
                out.setdefault(pref, {})[c] = {"name": office_name(bare(c)), "tel": r["tel"], "url": r["official_url"] or r["source_url"].split(" , ")[0]}
            else:
                missing.append((pref, c))
    return out, missing

if __name__ == "__main__":
    o, m = build()
    print("電話あり:", sum(len(v) for v in o.values()), "なし:", m)
