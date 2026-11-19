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
  assert.equal(houmukyokuFor("東京都", "新宿区"), null);
});

test("郡名の有無にかかわらず引ける", () => {
  assert.equal(houmukyokuFor("兵庫県", "猪名川町")?.office, "神戸地方法務局 伊丹支局");
  assert.equal(houmukyokuFor("兵庫県", "川辺郡猪名川町")?.office, "神戸地方法務局 伊丹支局");
});
