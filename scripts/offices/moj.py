"""data/offices/moj/<局>.txt（各法務局の管内法務局一覧）の電話番号を houmukyoku.json の庁名に対応づける"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, HOUMU

def norm(name):
    if "本局" in name: return "本局"
    s = re.sub(r"[（(][^）)]*[）)]", "", name).replace("\u3000", "").strip()
    s = s.split(" ")[-1] if " " in s else s
    m = re.match(r"^.+?法務局(.+)$", s)
    if m: s = m.group(1)
    if s.endswith("法務局") or s in ("本局", ""): return "本局"
    return s

def load():
    tel = {}
    d = os.path.join(ROOT, "data/offices/moj")
    for f in os.listdir(d):
        site = f[:-4]
        src = None
        for line in open(os.path.join(d, f)):
            line = line.strip()
            if line.startswith("# source:"): src = src or line.split()[2]; continue
            if not line or line.startswith("#"): continue
            n, t = line.split("|")
            tel[(site, norm(n))] = (t, src)
    return tel

def build():
    tel = load()
    out, missing = {}, set()
    for pref, cities in HOUMU.items():
        for c, v in cities.items():
            site = re.search(r"jp/([^/]+)/", v["url"]).group(1)
            k = (site, norm(v["office"]))
            if k in tel: out[v["office"]] = tel[k]
            elif os.path.exists(os.path.join(ROOT, f"data/offices/moj/{site}.txt")): missing.add(v["office"])
    return out, missing

if __name__ == "__main__":
    o, m = build()
    print("電話あり:", len(o), "収集済みの局で見つからない庁:", sorted(m))
