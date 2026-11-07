import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { computePlans } from "../engine/engine.ts";
import { buildSiteReport } from "../src/report.ts";
const res = computePlans({
  polygon:[[0,0],[15,0],[15,21],[0,21]],roadEdges:[{index:0,width:"4to6"}],zone:"r1",focusUse:"rental",
});
const img = (n) => "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#f0f4f5"/><rect x="170" y="70" width="300" height="220" fill="#aec7bf"/><text x="320" y="200" text-anchor="middle" font-size="64" font-family="sans-serif">'+ n +'</text></svg>');
const info = { available:true, elevation:{value:36.4,hsrc:"5m（レーザ）"}, info:{
  XKT001:{label:"区域区分",found:1,hits:[{props:{area_classification_ja:"市街化区域"}}]},
  XKT002:{label:"用途地域",found:1,hits:[{props:{use_area_ja:"第一種住居地域"}}]},
  XKT003:{label:"立地適正化計画",found:1,hits:[{props:{kubun_name_ja:"居住誘導区域"}}]},
  XKT014:{label:"防火・準防火",found:1,hits:[{props:{fire_prevention_ja:"準防火地域"}}]},
  XKT023:{label:"地区計画",found:0,hits:[]},
  XKT024:{label:"高度利用地区",found:0,hits:[]},
  XKT030:{label:"都市計画道路",found:1,hits:[{d:13,props:{}}]},
  XKT026:{label:"洪水",found:1,hits:[{props:{A31a_205:2}}]},
  XKT027:{label:"高潮",found:1,hits:[{props:{A49_003:"0.5m未満"}}]},
  XST001:{label:"過去の災害履歴",found:1,hits:[{props:{disaster_name_ja:"洪水浸水域",disaster_date:"19810101"}}]},
  XKT020:{label:"盛土",found:0,hits:[]},
  XKT025:{label:"液状化",found:1,hits:[{props:{note:"やや液状化しやすい"}}]},
  XKT029:{label:"土砂",error:"license_review_required"},
}};
const content = buildSiteReport({ result:res, info, images:[img("A"),img("B"),img("C")], isSample:true,
  preparedAt:new Date("2026-11-07T10:00:00+09:00"), styleName:"ホワイト" });
const css = pathToFileURL(resolve("site/assets/report.css")).href;
const style = '<style>@media print {body{margin:0!important} .rp-page{break-after:page}}</style>';
const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="' + css + '">' + style +
  '</head><body><div class="print-sheet">' + content + '</div></body></html>';
writeFileSync(process.argv[2] ?? "/tmp/report-preview.html", html, "utf8");
