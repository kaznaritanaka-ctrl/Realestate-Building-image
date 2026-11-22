"""窓口データ（税務署・家裁・法務局・市区町村役場）を市区町村に割り当てる共通処理。"""
import json, re, os
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOUMU = json.load(open(os.path.join(ROOT, "site/assets/houmukyoku.json")))
GUN = json.load(open(os.path.join(ROOT, "data/offices/gun.json")))  # 都道府県 -> 町村名 -> 郡名

DESIGNATED = {}  # 都道府県 -> 政令市 -> [区]
for pref, cities in HOUMU.items():
    for c in cities:
        m = re.match(r"^(.+?市)(.+区)$", c)
        if m and pref != "東京都":
            DESIGNATED.setdefault(pref, {}).setdefault(m.group(1), []).append(m.group(2))

def bare(c):
    """'川辺郡猪名川町' -> '猪名川町'"""
    return re.sub(r"^.+?郡", "", c)

def norm(s):
    """表記ゆれをそろえる（ケ/ヶ、龍/竜、竈/釜、檮/梼）"""
    return s.replace("ヶ", "ケ").replace("龍", "竜").replace("竈", "釜").replace("檮", "梼")

GUN_N = {p: {norm(k): v for k, v in d.items()} for p, d in GUN.items()}

def gun_of(pref, c):
    m = re.match(r"^(.+?郡)", c)
    if m: return m.group(1)
    return GUN_N.get(pref, {}).get(norm(c))

def clean(s):
    s = re.sub(r"（[^）]*）", "", s)
    s = re.sub(r"\([^)]*\)", "", s)
    s = re.sub(r"\[[^\]]*\]", "", s)
    s = re.sub(r"※.*$", "", s)
    return s

def tokens(area):
    """管轄区域の文字列を語に分ける。'郡のうちA町、B村' は ('郡', [A町, B村]) にする"""
    area = clean(area)
    out = []
    for part in re.split(r"[　\s]+", area.strip()):
        if not part: continue
        m = re.match(r"^(.+?郡)のうち(.+)$", part)
        if m:
            out.append(("gun_part", m.group(1), [t for t in re.split(r"[、,]", m.group(2)) if t]))
            continue
        m = re.match(r"^(東京都|.+?県|.+?府|北海道)のうち(.+)$", part)
        if m:
            for w in re.split(r"[、,]", m.group(2)):
                if w: out.append(("name", w))
            continue
        m = re.match(r"^(.+?市)のうち(.+)$", part)
        if m and all(w.endswith("区") for w in re.split(r"[・、,]", m.group(2)) if w):
            for w in re.split(r"[・、,]", m.group(2)):
                if w: out.append(("ward", w, m.group(1)))
            continue
        m = re.match(r"^(.+?[市区町村])のうち", part)
        if m:
            out.append(("part", m.group(1))); continue
        for w in re.split(r"[、,]", part):
            if not w or w.endswith("地区"): continue
            mm = re.match(r"^(.+?)の一部$", w)
            if mm: out.append(("part", mm.group(1))); continue
            out.append(("name", w))
    return out

def assign(pref, entries):
    """entries: [(office_dict, area_str)] -> {市区町村: [(office, partial)]}"""
    cities = list(HOUMU[pref].keys())
    res = {c: [] for c in cities}
    whole_city = set()
    for off, area in entries:
        for t in tokens(area):
            if t[0] == "name" and t[1].endswith("市") and t[1] in DESIGNATED.get(pref, {}):
                whole_city.add(t[1])
    def wards_named(w, city=None):
        hits = []
        for dc, ws in DESIGNATED.get(pref, {}).items():
            if city and dc != city: continue
            if not city and dc in whole_city: continue
            if w in ws: hits.append(dc + w)
        return hits
    specific = set()  # 「郡のうち」で個別に名指しされた町村
    for off, area in entries:
        for t in tokens(area):
            if t[0] == "gun_part":
                for town in t[2]: specific.add(norm(town))
    for off, area in entries:
        for t in tokens(area):
            kind = t[0]
            targets, partial = [], False
            if kind == "gun_part":
                targets = [c for c in cities if norm(bare(c)) in [norm(x) for x in t[2]] and gun_of(pref, c) == t[1]]
            elif kind == "ward":
                targets = wards_named(t[1], t[2])
            else:
                w = t[1]; partial = kind == "part"
                if w in res:
                    targets = [w]
                elif w.endswith("郡"):
                    targets = [c for c in cities if gun_of(pref, c) == w and norm(bare(c)) not in specific]
                elif w in DESIGNATED.get(pref, {}):
                    targets = [w + x for x in DESIGNATED[pref][w]]
                elif w.endswith("区") and pref != "東京都":
                    targets = wards_named(w)
                elif w in res:
                    targets = [w]
                else:
                    # 表記ゆれ（ケ/ヶ、龍/竜 など）
                    targets = [c for c in cities if norm(c) == norm(w) or norm(bare(c)) == norm(bare(w))]
            if not targets:
                print(f"  ?? {pref}: '{t}' がどの市区町村にも当たりません（{off['name']}）")
            for c in targets:
                res[c].append((off, partial))
    return res
