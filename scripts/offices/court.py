"""data/offices/court/*.txt（裁判所の申立書提出先一覧＋窓口案内）を市区町村ごとの家庭裁判所に割り当てる"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, HOUMU, assign

def load(pref):
    p = os.path.join(ROOT, f"data/offices/court/{pref}.txt")
    if not os.path.exists(p): return None
    src, rows = None, []
    for line in open(p):
        line = line.rstrip("\n")
        if line.startswith("# source:"):
            src = src or line.split()[2]; continue
        if not line.strip() or line.startswith("#"): continue
        name, tel, area = line.split("|")
        rows.append(({"name": name, "tel": tel, "url": src}, area.replace("、", "　")))
    return rows

def build():
    out, missing = {}, []
    for pref in HOUMU:
        rows = load(pref)
        if rows is None: continue
        res = assign(pref, rows)
        for c, offs in res.items():
            if not offs: missing.append(pref + c); continue
            seen, lst = set(), []
            for o, partial in offs:
                if o["name"] in seen: continue
                seen.add(o["name"]); lst.append(dict(o, part=partial or len(offs) > 1))
            out.setdefault(pref, {})[c] = lst
    return out, missing

if __name__ == "__main__":
    out, missing = build()
    print("済み:", len(out), "未割当:", len(missing), missing[:40])
    for p, cs in out.items():
        for c, l in cs.items():
            if len(l) > 1: print("  複数:", p, c, [o["name"] for o in l])
