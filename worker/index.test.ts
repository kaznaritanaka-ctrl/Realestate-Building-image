import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.ts";

const context = { waitUntil(_promise: Promise<unknown>) {} };
const assets = { fetch: async () => new Response(null, { status: 404 }) };

function withEmptyCache() {
  (globalThis as unknown as { caches: unknown }).caches = {
    default: { match: async () => undefined, put: async () => undefined },
  };
}

test("event rejects an oversized body before it reaches D1", async () => {
  let writes = 0;
  const body = JSON.stringify({ sid: "a".repeat(16), name: "run", props: { area: "x".repeat(2100) } });
  const response = await worker.fetch(new Request("https://example.test/api/event", { method: "POST", body }), {
    ASSETS: assets,
    DB: { prepare() { writes++; throw new Error("Unexpected D1 write"); } },
  }, context);
  assert.equal(response.status, 413);
  assert.equal(writes, 0);
  const ordinary = await worker.fetch(new Request("https://example.test/api/event", {
    method: "POST", body: JSON.stringify({ sid: "a".repeat(16), name: "run" }),
  }), { ASSETS: assets }, context);
  assert.equal(ordinary.status, 204);
});

test("site-info requires a limiter, blocks denied calls, and allows a budgeted lookup", async () => {
  withEmptyCache();
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; throw new Error("Unexpected upstream call"); };
  const url = "https://example.test/api/site-info?lat=35&lng=139&only=XKT001";
  try {
    const missing = await worker.fetch(new Request(url), { ASSETS: assets, REINFOLIB_KEY: "test-key" }, context);
    assert.equal(missing.status, 503);
    let reservations = 0;
    const limited = await worker.fetch(new Request(url), {
      ASSETS: assets, REINFOLIB_KEY: "test-key",
      REINFOLIB_RATE_LIMIT: { async limit({ key }) { assert.equal(key, "reinfolib-upstream"); reservations++; return { success: false }; } },
    }, context);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json() as { reason: string }).reason, "rate_limited");
    assert.equal(reservations, 1);
    assert.equal(upstreamCalls, 0);
    globalThis.fetch = async () => { upstreamCalls++; return Response.json({ features: [] }); };
    const allowed = await worker.fetch(new Request(url), {
      ASSETS: assets, REINFOLIB_KEY: "test-key",
      REINFOLIB_RATE_LIMIT: { async limit() { reservations++; return { success: true }; } },
    }, context);
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as { available: boolean }).available, true);
    assert.equal(reservations, 2);
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("zoning shares the same upstream limiter", async () => {
  withEmptyCache();
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; throw new Error("Unexpected upstream call"); };
  try {
    let reservationKey = "";
    const response = await worker.fetch(new Request("https://example.test/api/zoning?lat=35&lng=139"), {
      ASSETS: assets, REINFOLIB_KEY: "test-key",
      REINFOLIB_RATE_LIMIT: { async limit({ key }) { reservationKey = key; return { success: false }; } },
    }, context);
    assert.equal(response.status, 429);
    assert.equal(reservationKey, "reinfolib-upstream");
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
