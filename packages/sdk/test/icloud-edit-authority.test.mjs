import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptICloudEditBaseline,
  acceptICloudEditSuccessor,
  discoverICloudEditEvidence,
} from "../build/index.js";

const response = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const headers = { Authorization: "Bearer owner-session-fixture" };

test("owner discovery keeps session credentials in headers and preserves the non-admission snapshot", async () => {
  const snapshot = {
    complete: true,
    admissionGuaranteed: false,
    items: [
      {
        item: "owned-item",
        receipts: [],
        authority: null,
        holders: [],
        claims: [],
        incoming: [],
      },
    ],
  };
  const found = await discoverICloudEditEvidence(
    { assetId: "owned-asset" },
    {
      headers,
      fetch: async (url, options) => {
        assert.equal(
          url,
          "/api/icloud-sync/edits/evidence?assetId=owned-asset",
        );
        assert.equal(
          new Headers(options.headers).get("Authorization"),
          headers.Authorization,
        );
        assert.equal(options.body, undefined);
        return response(snapshot);
      },
    },
  );
  assert.deepEqual(found, snapshot);
});

test("administrative decision transport preserves exact opaque tokens and idempotency/version fences", async () => {
  const baseline = {
    requestId: "request",
    expectedGeneration: 0,
    receiptId: "receipt",
    holder: { kind: "device", id: "device" },
    sourceIncarnation: "incarnation",
    nativeVersion: "administrative-original",
    takeOver: false,
  };
  const successor = {
    requestId: "successor",
    expectedGeneration: 1,
    expectedVersionId: "version",
    reuseVersionId: "accepted-same-byte-version",
    channel: "device",
    resourceId: "resource",
    policy: "keep",
  };
  const ack = {
    decisionId: "request",
    generation: 1,
    versionId: "version",
    evidenceType: "administrative",
  };
  for (const [send, params, path, body] of [
    [
      acceptICloudEditBaseline,
      { iCloudEditBaselineDto: baseline },
      "baseline",
      baseline,
    ],
    [
      acceptICloudEditSuccessor,
      { iCloudEditSuccessorDto: successor },
      "successor",
      successor,
    ],
  ]) {
    const received = await send(params, {
      headers,
      fetch: async (url, options) => {
        assert.equal(url, "/api/icloud-sync/edits/" + path);
        assert.equal(options.method, "POST");
        assert.equal(
          new Headers(options.headers).get("Authorization"),
          headers.Authorization,
        );
        assert.deepEqual(JSON.parse(options.body), body);
        return response(ack);
      },
    });
    assert.deepEqual(received, ack);
  }
});
