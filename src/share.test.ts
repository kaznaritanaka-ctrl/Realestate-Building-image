import { test } from "node:test";
import assert from "node:assert/strict";
import { validateShareData } from "./share.ts";

const base = { v: 1, p: [[135.5, 34.7], [135.5001, 34.7], [135.5001, 34.7001]], e: ["4to6"], z: "r1", u: "house" };

test("accepts an ordinary shared result including numeric percentages", () => {
  assert.equal(validateShareData({ ...base, b: "60", f: "200", zs: "user" })?.b, "60");
});

test("rejects HTML and non-decimal percentage values", () => {
  assert.equal(validateShareData({ ...base, b: "<style>body{display:none}</style>" }), null);
  assert.equal(validateShareData({ ...base, f: "0x64" }), null);
});

test("rejects malformed sibling fields and inherited zone names", () => {
  assert.equal(validateShareData({ ...base, e: "4to6" }), null);
  assert.equal(validateShareData({ ...base, z: "toString" }), null);
  assert.equal(validateShareData({ ...base, r: 1e100 }), null);
});

test("accepts valid geographic points and rejects invalid coordinates", () => {
  assert.equal(validateShareData(base)?.p.length, 3);
  assert.equal(validateShareData({ ...base, p: [[181, 0], [0, 0], [1, 1]] }), null);
  const many = Array.from({ length: 60 }, (_, i) => [135.5 + Math.cos(i) * 0.0001, 34.7 + Math.sin(i) * 0.0001]);
  assert.equal(validateShareData({ ...base, p: many })?.p.length, 60);
});
