import assert from "node:assert/strict";
import test from "node:test";
import { jsonOnly, MalformedResponseError } from "../build/index.js";

const accept = { headers: { accept: "application/json" } };
const html = () =>
  new Response("<html>login</html>", {
    headers: { "content-type": "text/html" },
  });

test("Request headers select JSON validation when no init headers replace them", async () => {
  const request = new Request("https://example.test/api", accept);
  await assert.rejects(
    jsonOnly(async () => html())(request),
    MalformedResponseError,
  );
});

test("explicit init headers replace Request headers, including empty headers", async () => {
  const request = new Request("https://example.test/api", accept);
  const response = html();
  assert.equal(
    await jsonOnly(async () => response)(request, { headers: {} }),
    response,
  );
});

test("JSON response media types are case insensitive and retain structured suffixes", async () => {
  for (const contentType of [
    "APPLICATION/JSON; charset=utf-8",
    "application/problem+JSON",
  ]) {
    const response = new Response("{}", {
      headers: { "content-type": contentType },
    });
    assert.equal(
      await jsonOnly(async () => response)("https://example.test/api", accept),
      response,
    );
    assert.equal(response.bodyUsed, false);
  }
});

test("JSON Accept media types are case insensitive", async () => {
  await assert.rejects(
    jsonOnly(async () => html())("https://example.test/api", {
      headers: { accept: "APPLICATION/JSON" },
    }),
    MalformedResponseError,
  );
});

test("a JSON word in a non-JSON content type parameter cannot bypass validation", async () => {
  for (const contentType of [
    "text/html; profile=json",
    "application/notjson",
  ]) {
    const response = new Response("<html>login</html>", {
      headers: { "content-type": contentType },
    });
    await assert.rejects(
      jsonOnly(async () => response)("https://example.test/api", accept),
      (error) => {
        assert.ok(error instanceof MalformedResponseError);
        assert.equal(error.contentType, contentType);
        assert.equal(error.status, 200);
        return true;
      },
    );
  }
});

test("JSON words in Accept parameters do not turn a text request into a JSON request", async () => {
  const response = html();
  assert.equal(
    await jsonOnly(async () => response)("https://example.test/api", {
      headers: { accept: "text/html; profile=json" },
    }),
    response,
  );
});

test("204 and non-JSON requests retain the untouched response", async () => {
  const empty = new Response(null, { status: 204 });
  assert.equal(
    await jsonOnly(async () => empty)("https://example.test/api", accept),
    empty,
  );
  const text = html();
  assert.equal(
    await jsonOnly(async () => text)("https://example.test/api"),
    text,
  );
});

test("forwards fetch arguments and propagates transport failure without wrapping", async () => {
  const request = new Request("https://example.test/api");
  const options = { ...accept, signal: new AbortController().signal };
  const failure = new Error("transport failed");
  await assert.rejects(
    jsonOnly(async (input, init) => {
      assert.equal(input, request);
      assert.equal(init, options);
      throw failure;
    })(request, options),
    (error) => error === failure,
  );
});
