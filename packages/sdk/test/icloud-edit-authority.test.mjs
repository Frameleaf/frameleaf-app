import assert from "node:assert/strict";
import test from "node:test";
import * as sdk from "../build/index.js";
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

test("additive original-revert intent preserves existing generated enum exports", () => {
  assert.deepEqual(sdk.Kind3, {
    Plan: "plan",
    Supporter: "supporter",
    Credit: "credit",
  });
  assert.deepEqual(sdk.Kind4, { EventStory: "event_story" });
  assert.deepEqual(sdk.Kind5, { YearInReview: "year_in_review" });
  assert.deepEqual(sdk.Kind6, { PetStory: "pet_story" });
  assert.deepEqual(sdk.Kind7, { Birthday: "birthday" });
  assert.deepEqual(sdk.Kind8, { PersonRecap: "person_recap" });
  assert.deepEqual(sdk.Kind9, { Print: "print", Web: "web", Social: "social" });
  assert.deepEqual(sdk.Kind10, {
    CloudBackupActivation: "cloud-backup-activation",
    StudioRender: "studio-render",
  });
  assert.deepEqual(sdk.Kind11, {
    Album: "album",
    SmartAlbum: "smart-album",
    SavedSearch: "saved-search",
    Person: "person",
    Pet: "pet",
    Memory: "memory",
    Builtin: "builtin",
  });
  assert.deepEqual(sdk.Kind12, { Space: "space" });
  assert.deepEqual(sdk.ICloudEditOriginalRevertKind, {
    OriginalRevert: "original-revert",
  });
  assert.deepEqual(sdk.ICloudEditRetentionPolicy, {
    Keep: "keep",
    Supersede: "supersede",
  });
});

test("explicit original revert transports publication CAS and retention without changing administrative defaults", async () => {
  const baseline = {
    requestId: "original-revert-request",
    expectedGeneration: 3,
    receiptId: "verified-original-receipt",
    holder: { kind: "device", id: "device" },
    sourceIncarnation: "incarnation",
    nativeVersion: "opaque-original-version",
    takeOver: false,
    intent: {
      kind: "original-revert",
      expectedPublicationId: "publication",
      retention: "keep",
    },
  };
  const ack = {
    decisionId: baseline.requestId,
    generation: 4,
    versionId: "original",
    evidenceType: "administrative",
  };
  const received = await acceptICloudEditBaseline(
    { iCloudEditBaselineDto: baseline },
    {
      headers,
      fetch: async (url, options) => {
        assert.equal(url, "/api/icloud-sync/edits/baseline");
        assert.equal(options.method, "POST");
        assert.equal(
          new Headers(options.headers).get("Authorization"),
          headers.Authorization,
        );
        assert.deepEqual(JSON.parse(options.body), baseline);
        return response(ack);
      },
    },
  );
  assert.deepEqual(received, ack);
});

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

test("supersede transports explicit local publication CAS including null without provider order", async () => {
  for (const expectedPublicationId of [null, "local-publication-fixture"]) {
    const body = {
      requestId: "supersede-request",
      expectedGeneration: 2,
      expectedVersionId: "canonical-version",
      channel: "device",
      resourceId: "verified-resource",
      policy: "supersede",
      expectedPublicationId,
    };
    let called = false;
    await acceptICloudEditSuccessor(
      { iCloudEditSuccessorDto: body },
      {
        headers,
        fetch: async (url, init) => {
          called = true;
          assert.equal(
            new URL(url, "http://fixture").pathname,
            "/api/icloud-sync/edits/successor",
          );
          assert.deepEqual(JSON.parse(init.body), body);
          return response({
            decisionId: body.requestId,
            generation: 2,
            versionId: "accepted-version",
            evidenceType: "administrative",
          });
        },
      },
    );
    assert.equal(called, true);
  }
});
