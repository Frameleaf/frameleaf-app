import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeWorkerUrl,
  updateWorkerUrls,
  workerRequestPreview,
} from "../src/worker-settings.mjs";
test("endpoint validation accepts LAN/remote HTTP URLs without accepting embedded credentials or secret query strings", () => {
  assert.equal(
    normalizeWorkerUrl(" http://gpu.home.arpa:3003/ "),
    "http://gpu.home.arpa:3003",
  );
  assert.equal(
    normalizeWorkerUrl("https://example.invalid/ml/"),
    "https://example.invalid/ml",
  );
  assert.equal(normalizeWorkerUrl("http://[::1]:3003"), "http://[::1]:3003");
  for (const value of [
    "",
    "not-a-url",
    "file:///gpu",
    "javascript:alert(1)",
    "https://user:pass@example.invalid",
    "https://example.invalid?token=secret",
    "https://example.invalid#fragment",
    null,
  ])
    assert.equal(normalizeWorkerUrl(value), null);
});
test("updates reject canonical duplicates and stale edits while preserving endpoint order and source state", () => {
  const values = {
    advancedMlUrls: "http://first:3003\nhttps://second.invalid",
  };
  assert.throws(
    () =>
      updateWorkerUrls(values, {
        kind: "add",
        url: "https://SECOND.invalid:443/",
      }),
    /already/,
  );
  assert.throws(
    () =>
      updateWorkerUrls(values, {
        kind: "edit",
        original: "http://missing",
        url: "http://new",
      }),
    /elsewhere/,
  );
  assert.equal(
    updateWorkerUrls(values, {
      kind: "move",
      original: "https://second.invalid",
      direction: -1,
    }),
    "https://second.invalid\nhttp://first:3003",
  );
  assert.equal(
    updateWorkerUrls(values, {
      kind: "edit",
      original: "http://first:3003",
      url: "http://new:3003/",
    }),
    "http://new:3003\nhttps://second.invalid",
  );
  assert.equal(
    values.advancedMlUrls,
    "http://first:3003\nhttps://second.invalid",
  );
  assert.throws(
    () =>
      updateWorkerUrls(
        { advancedMlUrls: "http://only:3003" },
        { kind: "remove", original: "http://only:3003" },
      ),
    /at least one/,
  );
});
test("capability previews never report fabricated probe results or GPU qualification", () => {
  const preview = workerRequestPreview("https://example.invalid");
  assert.equal(preview.networkRequestSent, false);
  assert.equal(preview.qualified, false);
  assert.equal(preview.capabilities, null);
  assert.equal(preview.availableMemoryBytes, null);
  assert.throws(() =>
    workerRequestPreview("https://user:secret@example.invalid"),
  );
});
