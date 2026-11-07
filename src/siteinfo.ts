// 「この土地の参考情報」：不動産情報ライブラリの各レイヤーを、地点ごとに読みやすく整える
type Hit = { d?: number; props: Record<string, unknown> };
type LayerRes = { label: string; found?: number; hits?: Hit[]; error?: string };
export type SiteInfo = { available: boolean; info?: Record<string, LayerRes>; elevation?: { value: number; hsrc: string } | null; address?: { pref: string; city: string; town: string } | null };
/** 所在地の参考表示（「〇〇県〇〇市〇〇町 付近」）。分からなければ空文字 */
export function addressText(si: SiteInfo | null | undefined): string {
  const a = si?.address;
  return a ? `${a.pref}${a.city}${a.town}` : "";
}

const cache = new Map<string, Promise<SiteInfo>>();

export function fetchSiteInfo(lng: number, lat: number): Promise<SiteInfo> {
  const key = `${lng.toFixed(4)},${lat.toFixed(4)}`; // 約10m単位。照会は座標だけで、住所の文字列は送らない
  let p = cache.get(key);
  if (!p) {
    p = fetch(`/api/site-info?lat=${lat}&lng=${lng}`)
      .then(r => (r.ok ? r.json() : { available: false }))
      .catch(() => ({ available: false })) as Promise<SiteInfo>;
    cache.set(key, p);
  }
  return p;
}

const str = (v: unknown) => (v == null ? "" : String(v));
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const layer = (si: SiteInfo, api: string) => si.info?.[api];
const ok = (l?: LayerRes) => !!l && !l.error;
const hits = (l?: LayerRes) => (ok(l) ? l!.hits ?? [] : []);

export type AreaClass = "urban" | "control" | "plan-only" | "none" | "unknown";
// 区域区分：市街化区域／市街化調整区域／（線引きのない）都市計画区域／都市計画区域外
export function areaClass(si: SiteInfo | null): AreaClass {
  if (!si?.available) return "unknown";
  const l = layer(si, "XKT001");
  if (!ok(l)) return "unknown";
  const names = hits(l).map(h => str(h.props.area_classification_ja));
  if (names.some(n => n.includes("市街化調整区域"))) return "control";
  if (names.some(n => n === "市街化区域")) return "urban";
  if (names.some(n => n.includes("都市計画区域"))) return "plan-only";
  return "none";
}

export const CONTROL_WARNING = "この地点は<b>市街化調整区域</b>です。市街化調整区域では、原則として建物を建てることが制限されます（農家住宅・既存宅地・開発許可を受けた場合などの例外があります）。下の3案は<b>許可が得られた場合の参考</b>としてご覧ください。建てられるかどうかは、市町村の都市計画・開発指導の窓口でご確認ください。";

// 浸水深ランク（想定最大規模）。標準的な区分として解釈
const FLOOD_RANK: Record<number, string> = { 1: "0.5m未満", 2: "0.5〜3m未満", 3: "3〜5m未満", 4: "5〜10m未満", 5: "10〜20m未満", 6: "20m以上" };

function generic(l?: LayerRes): string {
  // 項目名が地点ごとに違うレイヤーは、日本語の値を最大2つだけ拾う（都道府県・市町村名は除く）
  const vals = new Set<string>();
  for (const h of hits(l)) for (const [k, v] of Object.entries(h.props)) {
    if (!k.endsWith("_ja") || /prefecture|city/.test(k)) continue;
    const s = str(v); if (s && vals.size < 2) vals.add(s);
  }
  return vals.size ? `区域内（${[...vals].map(esc).join("・")}）` : "区域内";
}

const row = (k: string, v: string, attn = false) => `<tr${attn ? ' class="attn"' : ""}><th>${k}</th><td>${v}</td></tr>`;
const na = `<span class="muted">取得できませんでした</span>`;
const none = `<span class="muted">該当なし</span>`;

export function siteInfoHtml(si: SiteInfo | null, areaSqm: number): string {
  if (si === null) return `<b>この土地の参考情報</b><p class="muted">調べています…</p>`;
  if (!si.available) return `<b>この土地の参考情報</b><p class="muted">この地点の情報は取得できませんでした。</p>`;
  const rows: string[] = [];
  const addr = addressText(si);
  if (addr) rows.push(row("所在（参考）", `${esc(addr)} 付近<small>座標から求めた町名までの目安です（地番は分かりません）。</small>`));

  // 都市計画
  const ac = areaClass(si);
  const acText: Record<AreaClass, string> = {
    urban: "市街化区域", control: "<b>市街化調整区域</b>（原則として建築が制限されます）",
    "plan-only": "都市計画区域（区域区分なし）", none: "都市計画区域外", unknown: na,
  };
  rows.push(row("区域区分", acText[ac], ac === "control"));
  const zone = hits(layer(si, "XKT002"))[0];
  if (zone) {
    const p = zone.props;
    rows.push(row("用途地域", `${esc(str(p.use_area_ja))}（建ぺい率 ${esc(str(p.u_building_coverage_ratio_ja || p.building_coverage_ratio))}・容積率 ${esc(str(p.u_floor_area_ratio_ja || p.floor_area_ratio))}）`.replace(/（建ぺい率 ・容積率 ）$/, "")));
  } else if (ok(layer(si, "XKT002"))) rows.push(row("用途地域", none));
  const loc = layer(si, "XKT003");
  if (ok(loc)) rows.push(row("立地適正化計画", hits(loc).length ? esc(str(hits(loc)[0].props.kubun_name_ja ?? hits(loc)[0].props.area_classification_ja)) : none, hits(loc).length > 0));
  const fire = layer(si, "XKT014");
  rows.push(row("防火・準防火地域", !ok(fire) ? na : hits(fire).length ? esc(str(hits(fire)[0].props.fire_prevention_ja)) + "<small>建物の構造（耐火・準耐火）に制限があり、工事費に影響します。</small>" : none, hits(fire).length > 0));
  const dp = layer(si, "XKT023");
  if (ok(dp)) rows.push(row("地区計画", hits(dp).length ? generic(dp) + "<small>建物の用途・高さ・壁面の位置などに独自のルールがある場合があります。</small>" : none, hits(dp).length > 0));
  const hu = layer(si, "XKT024");
  if (ok(hu) && hits(hu).length) rows.push(row("高度利用地区", generic(hu), true));
  const road = layer(si, "XKT030");
  if (ok(road)) rows.push(row("都市計画道路", hits(road).length ? `敷地から約${hits(road)[0].d}m以内に計画線があります<small>敷地にかかる場合は建築に制限があります。</small>` : `<span class="muted">近く（25m以内）にはありません</span>`, hits(road).length > 0));

  // ハザード
  const fl = layer(si, "XKT026");
  if (!ok(fl)) rows.push(row("洪水（想定最大規模）", na));
  else if (!hits(fl).length) rows.push(row("洪水（想定最大規模）", `<span class="muted">浸水想定区域外</span>`));
  else {
    const ranks = hits(fl).map(h => Number(h.props.A31a_205)).filter(n => n > 0);
    const max = ranks.length ? Math.max(...ranks) : 0;
    const rivers = [...new Set(hits(fl).map(h => str(h.props.A31a_202)).filter(Boolean))].slice(0, 3);
    rows.push(row("洪水（想定最大規模）", `浸水想定区域内${max ? `：深さ ${FLOOD_RANK[max] ?? `ランク${max}`}` : ""}${rivers.length ? `（${rivers.map(esc).join("・")}）` : ""}`, max >= 3));
  }
  const tide = layer(si, "XKT027");
  if (ok(tide)) rows.push(row("高潮浸水想定", hits(tide).length ? esc(str(hits(tide)[0].props.A49_003 ?? "区域内（深さ不明）")) : none, hits(tide).length > 0));
  const ls = layer(si, "XKT029");
  // このAPIには一部自治体で非商用制限があり、現状は表示を保留している。
  rows.push(row("土砂災害警戒区域", ls?.error === "license_review_required"
    ? "提供保留（商用利用条件の確認中）"
    : !ok(ls) ? na : hits(ls).length ? generic(ls) : none, hits(ls).length > 0));
  const history = layer(si, "XST001");
  if (ok(history)) {
    const items = hits(history).slice(0, 2).map(h => {
      const p = h.props;
      return esc(str(p.disaster_name_ja || "災害")) + (p.disaster_date ? "（" + esc(str(p.disaster_date)) + "）" : "");
    });
    rows.push(row("周辺の災害履歴（収録分のみ）", items.length ? items.join(" / ") + "<small>未収録の災害もあります。150m以内の近接情報を含みます。</small>" : none, items.length > 0));
  }
  const fill = layer(si, "XKT020");
  if (ok(fill)) rows.push(row("大規模盛土造成地", hits(fill).length ? "区域内" : none, hits(fill).length > 0));
  const lq = hits(layer(si, "XKT025"))[0];
  if (lq) rows.push(row("液状化の発生傾向", `${esc(str(lq.props.note))}${lq.props.topographic_classification_name_ja ? `<small>地形区分：${esc(str(lq.props.topographic_classification_name_ja))}</small>` : ""}`));

  // 周辺
  if (si.elevation && Number.isFinite(si.elevation.value)) rows.push(row("参照地点の標高", si.elevation.value.toFixed(1) + "m<small>" + esc(si.elevation.hsrc) + "。約10m単位の参照地点であり、敷地内の高低差は分かりません。</small>"));

  const lp = hits(layer(si, "XPT002"));
  if (lp.length) {
    const items = lp.slice(0, 2).map(h => {
      const p = h.props;
      const price = Number(str(p.u_current_years_price_ja).replace(/[^\d]/g, ""));
      const man = Math.round((price * areaSqm) / 1e4);
      const est = price && areaSqm ? `<small>単価×この敷地の面積＝約${man >= 10000 ? `${(man / 10000).toFixed(1)}億` : `${man.toLocaleString("ja-JP")}万`}円（あくまで目安）</small>` : "";
      return `<div class="si-item">${esc(str(p.u_current_years_price_ja))}・${esc(str(p.use_category_name_ja))}（約${h.d}m先、${esc(str(p.target_year_name_ja))}時点）${est}</div>`;
    });
    rows.push(row("近くの地価（公示・調査）", items.join("")));
  } else if (ok(layer(si, "XPT002"))) rows.push(row("近くの地価（公示・調査）", `<span class="muted">1.5km以内に地点がありません</span>`));
  const st = hits(layer(si, "XKT015"));
  if (st.length) {
    const seen = new Set<string>();
    const items = st.filter(h => { const n = str(h.props.S12_001_ja); if (seen.has(n)) return false; seen.add(n); return true; }).slice(0, 2).map(h => {
      const p = h.props;
      const yk = Object.keys(p).filter(k => /^\d{4}_passenger_count$/.test(k) && Number(p[k]) > 0).sort().pop();
      return `${esc(str(p.S12_001_ja))}駅（${esc(str(p.S12_002_ja))}、約${h.d}m）${yk ? `：乗降 ${Number(p[yk]).toLocaleString("ja-JP")}人/日（${yk.slice(0, 4)}年）` : ""}`;
    });
    rows.push(row("近くの駅", items.join("<br>")));
  }

  return `<b>この土地の参考情報</b>
    <table class="kv">${rows.join("")}</table>
    <p class="muted small">ハザード情報は国の公開データによる目安です。最新の内容は市町村のハザードマップでご確認ください。地価は近くの標準地・基準地の価格で、この土地の価格ではありません。距離は敷地の中心からの直線距離です。</p>
    <p class="muted credit">出典：国土交通省 不動産情報ライブラリ（<a href="https://www.reinfolib.mlit.go.jp/" target="_blank" rel="noopener">https://www.reinfolib.mlit.go.jp/</a>）。国土数値情報（洪水浸水想定区域・土砂災害警戒区域・駅別乗降客数ほか）、都市計画決定GISデータ、地価公示・都道府県地価調査、大規模盛土造成地マップ、液状化の発生傾向図をもとに土地の未来図が編集・加工。提供情報の最新性、正確性、完全性等が保証されたものではありません。</p>`;
}
