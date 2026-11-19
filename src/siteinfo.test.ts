import test from "node:test";
import assert from "node:assert/strict";
import { fetchSiteInfo } from "./siteinfo.ts";

test("temporary upstream denial is retried after one minute", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 0;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 429 }); };
  try {
    const lng = 139.123456, lat = 35.123456;
    assert.equal((await fetchSiteInfo(lng, lat)).available, false);
    assert.equal((await fetchSiteInfo(lng, lat)).available, false);
    assert.equal(calls, 1);
    now = 60_001;
    globalThis.fetch = async () => { calls++; return Response.json({ available: true }); };
    assert.equal((await fetchSiteInfo(lng, lat)).available, true);
    assert.equal((await fetchSiteInfo(lng, lat)).available, true);
    assert.equal(calls, 2);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test("登記簿リンクは座標を4桁に丸めて出す／座標なしでは出さない", async () => {
  const { siteInfoHtml } = await import("./siteinfo.ts");
  const si = { available: true, info: {}, address: { pref: "兵庫県", city: "小野市", town: "中島町" } };
  const withPt = siteInfoHtml(si, 100, { lat: 34.85604, lng: 134.94706 });
  assert.ok(withPt.includes("https://kokonotoukibo.jp/#18/34.8560/134.9471"));
  assert.ok(withPt.includes("この場所の登記簿を取得する"));
  const withoutPt = siteInfoHtml(si, 100);
  assert.ok(!withoutPt.includes("kokonotoukibo"));
});
