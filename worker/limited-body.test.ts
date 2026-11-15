import { test } from "node:test";
import assert from "node:assert/strict";
import { readTextUpTo } from "./limited-body.ts";

const request = (body: BodyInit, headers?: HeadersInit) =>
  new Request("https://example.test/api/event", { method: "POST", body, headers, duplex: "half" } as RequestInit & { duplex: string });

test("accepts an event body at the byte limit", async () => {
  assert.equal(await readTextUpTo(request("a".repeat(2000)), 2000), "a".repeat(2000));
});

test("rejects an oversized declared body before reading it", async () => {
  assert.equal(await readTextUpTo(request("a", { "content-length": "2001" }), 2000), null);
});

test("rejects an oversized streamed body even without Content-Length", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("a".repeat(1500)));
      controller.enqueue(new TextEncoder().encode("b".repeat(501)));
      controller.close();
    },
  });
  assert.equal(await readTextUpTo(request(body), 2000), null);
});

test("counts UTF-8 bytes rather than characters", async () => {
  assert.equal(await readTextUpTo(request("あ".repeat(667)), 2000), null);
});
