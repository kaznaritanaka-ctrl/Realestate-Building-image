import { test } from "node:test";
import assert from "node:assert/strict";
import { UpstreamBudget } from "./upstream-budget.ts";

test("caps parallel cache misses within one request", async () => {
  let calls = 0;
  const budget = new UpstreamBudget({ limit: async () => { calls++; return { success: true }; } }, 3);
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => budget.reserve())),
    [true, true, true, false, false, false]);
  assert.equal(calls, 3);
});

test("honors the shared limiter before an upstream call", async () => {
  const budget = new UpstreamBudget({ limit: async () => ({ success: false }) }, 3);
  assert.equal(await budget.reserve(), false);
});
