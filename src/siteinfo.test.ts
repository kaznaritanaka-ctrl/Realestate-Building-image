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
