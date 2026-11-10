import assert from "node:assert/strict";
import test from "node:test";
import { streamServerLogs } from "../build/index.js";

test("server logs expose the open response stream without buffering it", { timeout: 1000 }, async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: sample\n\n"));
    },
  });
  const response = new Response(body);
  const actual = await streamServerLogs(
    { worker: "api", q: "job & queue" },
    {
      baseUrl: "https://frameleaf.test/api/",
      headers: { Authorization: "Bearer test-session" },
      fetch: async (url, init) => {
        const target = new URL(url);
        assert.equal(target.pathname, "/api/admin/logs/stream");
        assert.equal(target.searchParams.get("q"), "job & queue");
        assert.equal(target.searchParams.get("worker"), "api");
        assert.equal(init.headers.get("accept"), "text/event-stream");
        assert.equal(init.headers.get("authorization"), "Bearer test-session");
        return response;
      },
    },
  );
  assert.equal(actual, response);
  assert.equal(actual.bodyUsed, false);
  const reader = actual.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: sample\n\n");
  await reader.cancel();
});
