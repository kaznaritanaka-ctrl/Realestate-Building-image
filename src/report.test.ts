import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlans } from "../engine/engine.ts";
import { buildSiteReport } from "./report.ts";

const result = computePlans({
  polygon: [[0,0],[12,0],[12,20],[0,20]],
  roadEdges: [{index:0,width:"4to6"}], zone:"r1", focusUse:"rental",
});
const input = {
  result,
  info: null,
  images: ["data:image/jpeg;base64,QQ==", "data:image/jpeg;base64,Qg==", "data:image/jpeg;base64,Qw=="],
  isSample: false,
  preparedAt: new Date("2026-11-07T01:00:00+09:00"),
  styleName: "ホワイト",
  center: [135.5, 34.7] as [number,number],
};

test("固定3ページ・概要/A/B/C/法令/防災/免責を含む", () => {
  const html = buildSiteReport(input);
  assert.equal((html.match(/class="rp-page rp-page-/g) ?? []).length, 3);
  assert.equal((html.match(/class="rp-card rp-plan"/g) ?? []).length, 3);
  for(const t of ["土地概要", "A案", "B案", "C案", "建築関連", "災害・地形", "未確認", "保証なし", "国土交通省", "国土地理院"]) {
    assert.ok(html.includes(t), t);
  }
});

test("地域データが無い状態を安全と表示せず、未取得・要確認と表示", () => {
  const html = buildSiteReport(input);
  assert.ok(html.includes("未取得・要確認"));
  assert.ok(!html.includes("洪水浸水想定（想定最大規模）</th><td>該当なし"));
});

test("追加データの取込とXSSエスケープ、標高の表示", () => {
  const withInfo = {
    ...input,
    info: {
      available: true,
      info: {
        XKT003: { label:"立地適正化計画",found:1,hits:[{props:{kubun_name_ja:"居住誘導区域"}}] },
        XKT027: { label:"高潮浸水",found:1,hits:[{props:{A49_003:"1m以上3m未満"}}] },
        XST001: { label:"災害履歴",found:1,hits:[{props:{disaster_name_ja:"<script>alert(1)</script>",disaster_date:"19810800"}}] },
        XKT029: {label:"土砂災害",error:"license_review_required"},
      },
      elevation: {value: 34.2, hsrc:"5m（レーザ）"},
    },
  };
  const html = buildSiteReport(withInfo);
  assert.ok(html.includes("居住誘導区域"));
  assert.ok(html.includes("1m以上3m未満"));
  assert.ok(html.includes("34.2m"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("商用利用条件"));
});

test("所在は町字までの目安を表示し、地番欄を用意する（文字列はエスケープ）", () => {
  const html = buildSiteReport({ ...input, info: { available: true, info: {}, address: { pref: "大阪府", city: "大阪市北区", town: "梅田<一丁目>" } } });
  assert.ok(html.includes("大阪府大阪市北区梅田&lt;一丁目&gt; 付近"));
  assert.ok(html.includes("data-lot"));
  const sample = buildSiteReport({ ...input, isSample: true });
  assert.ok(sample.includes("サンプル敷地") && !sample.includes("data-lot"));
});
