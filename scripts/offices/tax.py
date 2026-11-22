"""data/offices/tax/*.txt（国税庁の税務署一覧）を市区町村ごとの税務署に割り当てる"""
import glob, os, re, json, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, HOUMU, assign

def load(pref):
    p = os.path.join(ROOT, f"data/offices/tax/{pref}.txt")
    src, rows = None, []
    for line in open(p):
        line = line.rstrip("\n")
        if line.startswith("# source:"): src = line.split()[2]; continue
        if not line.strip(): continue
        name, tel, area = line.split("|")
        name = re.sub(r"（[^）]*）", "", name).replace("税務署", "") + "税務署"
        rows.append(({"name": name, "tel": tel, "url": src}, area))
    return rows

def build():
    out, missing = {}, []
    for pref in HOUMU:
        res = assign(pref, load(pref))
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
    print("未割当:", len(missing), missing[:30])
    multi = [(p, c, [o["name"] for o in l]) for p, cs in out.items() for c, l in cs.items() if len(l) > 1]
    print("複数署:", len(multi)); [print("  ", m) for m in multi]
