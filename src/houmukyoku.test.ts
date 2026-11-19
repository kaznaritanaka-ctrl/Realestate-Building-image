import test from "node:test";
import assert from "node:assert/strict";
import { houmukyokuFor } from "./houmukyoku.ts";

test("政令市の区から管轄を引く", () => {
  assert.equal(houmukyokuFor("大阪府", "大阪市北区")?.office, "大阪法務局 北出張所");
  assert.equal(houmukyokuFor("兵庫県", "神戸市西区")?.office, "神戸地方法務局 明石支局");
});

test("市から管轄を引く", () => {
  assert.equal(houmukyokuFor("兵庫県", "小野市")?.office, "神戸地方法務局 社支局");
});

test("対象外の都道府県は null", () => {
  assert.equal(houmukyokuFor("北海道", "札幌市中央区"), null);
});

test("郡名の有無にかかわらず引ける", () => {
  assert.equal(houmukyokuFor("兵庫県", "猪名川町")?.office, "神戸地方法務局 伊丹支局");
  assert.equal(houmukyokuFor("兵庫県", "川辺郡猪名川町")?.office, "神戸地方法務局 伊丹支局");
});

test("近畿の拡張分：京都市北区は本局、宇治市は宇治支局、橿原市は中和支局", async () => {
  const { houmukyokuFor } = await import("./houmukyoku.ts");
  assert.equal(houmukyokuFor("京都府", "京都市北区")?.office, "京都地方法務局 本局");
  assert.equal(houmukyokuFor("京都府", "宇治市")?.office, "京都地方法務局 宇治支局");
  assert.equal(houmukyokuFor("奈良県", "橿原市")?.office, "奈良地方法務局 中和支局");
  assert.equal(houmukyokuFor("滋賀県", "彦根市")?.office, "大津地方法務局 彦根支局");
  assert.equal(houmukyokuFor("和歌山県", "和歌山市")?.office, "和歌山地方法務局 本局");
});

test("中国・九州の拡張分：広島市佐伯区は廿日市支局、高鍋町は高鍋出張所、那覇市は本局", async () => {
  const { houmukyokuFor } = await import("./houmukyoku.ts");
  assert.equal(houmukyokuFor("広島県", "広島市佐伯区")?.office, "広島法務局 廿日市支局");
  assert.equal(houmukyokuFor("宮崎県", "高鍋町")?.office, "宮崎地方法務局 高鍋出張所");
  assert.equal(houmukyokuFor("沖縄県", "那覇市")?.office, "那覇地方法務局 本局");
  assert.equal(houmukyokuFor("福岡県", "北九州市小倉北区")?.office, "福岡法務局 北九州支局");
});

test("中部の拡張分：新潟市北区は本局、入善町は魚津支局、名古屋市千種区は本局", async () => {
  const { houmukyokuFor } = await import("./houmukyoku.ts");
  assert.equal(houmukyokuFor("新潟県", "新潟市北区")?.office, "新潟地方法務局 本局");
  assert.equal(houmukyokuFor("新潟県", "新潟市秋葉区")?.office, "新潟地方法務局 新津支局");
  assert.equal(houmukyokuFor("富山県", "入善町")?.office, "富山地方法務局 魚津支局");
  assert.equal(houmukyokuFor("富山県", "上市町")?.office, "富山地方法務局 本局");
  assert.equal(houmukyokuFor("愛知県", "名古屋市千種区")?.office, "名古屋法務局 本局");
  assert.equal(houmukyokuFor("長野県", "長野市")?.office, "長野地方法務局 本局");
});

test("関東の拡張分：千代田区は本局、松戸市は松戸支局、保土ケ谷区は神奈川出張所", async () => {
  const { houmukyokuFor } = await import("./houmukyoku.ts");
  assert.equal(houmukyokuFor("東京都", "千代田区")?.office, "東京法務局 本局");
  assert.equal(houmukyokuFor("千葉県", "松戸市")?.office, "千葉地方法務局 松戸支局");
  assert.equal(houmukyokuFor("神奈川県", "横浜市保土ケ谷区")?.office, "横浜地方法務局 神奈川出張所");
  assert.equal(houmukyokuFor("埼玉県", "川口市")?.office, "さいたま地方法務局 川口出張所");
});
