import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSourceResourceGrant } from "../build/index.js";

const wire = JSON.parse(
  readFileSync(
    new URL(
      "../../../server/test/fixtures/source-resource/wire-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
test("source grant issuance preserves installation proof and keeps photo authentication in headers", async () => {
  const authorization = "Bearer synthetic-photo-session";
  const result = await createSourceResourceGrant(
    { sourceGrantRequestDto: wire.request },
    {
      headers: { Authorization: authorization },
      fetch: async (url, options) => {
        assert.equal(url, "/api/source-resources/grants");
        assert.equal(options.method, "POST");
        const headers = new Headers(options.headers);
        assert.equal(headers.get("authorization"), authorization);
        assert.equal(headers.get("x-frameleaf-desktop-proof"), null);
        assert.deepEqual(JSON.parse(options.body), wire.request);
        assert.ok(!options.body.includes("synthetic-photo-session"));
        return new Response(JSON.stringify(wire.response), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.deepEqual(result, wire.response);
  assert.deepEqual(result.scopes, ["source-original-read"]);
});
