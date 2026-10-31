// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Frameleaf.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cancelPlan,
  issueKeys,
  jiraClient,
  syncRelease,
  validateReceipt,
} from "./jira-release.mjs";

test("Jira accepts empty successful property writes and keeps JSON readback strict", async (t) => {
  let response;
  t.mock.method(globalThis, "fetch", async () => response);
  const request = jiraClient({
    JIRA_EMAIL: "test@example.invalid",
    JIRA_API_TOKEN: "synthetic-test-token",
  });
  const path = "/rest/api/3/issue/FC-1/properties/frameleaf.shipment.10";
  for (const status of [201, 200, 204]) {
    response = new Response(null, { status });
    assert.equal(
      await request(path, "PUT", { sourceSha: "a".repeat(40) }),
      null,
    );
  }
  response = new Response('{"value":{"sourceSha":"verified"}}');
  assert.deepEqual(await request(path), { value: { sourceSha: "verified" } });
  for (const [method, body] of [
    ["GET", ""],
    ["PUT", "{"],
    ["POST", ""],
  ]) {
    response = new Response(body, { status: method === "POST" ? 201 : 200 });
    await assert.rejects(request(path, method), SyntaxError);
  }
  response = new Response("private response content", { status: 403 });
  await assert.rejects(
    request(path, "PUT"),
    (error) =>
      error.status === 403 &&
      !error.message.includes("private response content"),
  );
});

const receipt = {
  mode: "shipped",
  version: "1.2.3",
  sourceSha: "a".repeat(40),
  previousSha: "b".repeat(40),
  evidenceUrl: "https://github.com/Frameleaf/frameleaf-app/actions/runs/12",
  releasedAt: "2026-10-28T12:00:00Z",
  channel: "library-release",
  issueKeys: ["FL-1"],
};
function fixture({
  versions = [],
  issueVersions = [],
  deferred = [],
  failReadback = false,
} = {}) {
  const state = {
    versions: structuredClone(versions),
    issueVersions: structuredClone(issueVersions),
    properties: {},
    links: new Map(),
    writes: [],
  };
  async function request(path, method = "GET", body) {
    if (method !== "GET")
      state.writes.push({ path, method, body: structuredClone(body) });
    if (path.includes("/properties/")) {
      if (method === "PUT") {
        state.properties[path] = structuredClone(body);
        return null;
      }
      if (!state.properties[path])
        throw Object.assign(new Error("not found"), { status: 404 });
      return { value: structuredClone(state.properties[path]) };
    }
    if (path.includes("/remotelink")) {
      state.links.set(body.globalId, body);
      return {};
    }
    if (path.startsWith("/rest/api/3/project/"))
      return { values: structuredClone(state.versions), isLast: true };
    if (path === "/rest/api/3/search/jql")
      return { issues: deferred.map((key) => ({ key })), isLast: true };
    if (path === "/rest/api/3/version" && method === "POST") {
      const version = { id: "10", ...body };
      state.versions.push(version);
      return structuredClone(version);
    }
    if (path.startsWith("/rest/api/3/version/")) {
      const v = state.versions.find((x) => x.id === path.split("/").at(-1));
      // Jira trims trailing whitespace from version descriptions.
      if (method === "PUT")
        Object.assign(v, body, { description: body.description?.trimEnd() });
      return structuredClone(v);
    }
    if (path.startsWith("/rest/api/3/issue/")) {
      if (method === "PUT") {
        for (const update of body.update.fixVersions) {
          if (update.add)
            state.issueVersions.push(
              structuredClone(
                state.versions.find((v) => v.id === update.add.id),
              ),
            );
          if (update.remove)
            state.issueVersions = state.issueVersions.filter(
              (v) => v.id !== update.remove.id,
            );
        }
        return null;
      }
      return {
        fields: {
          project: { key: "FL" },
          fixVersions:
            failReadback && state.writes.length
              ? []
              : structuredClone(state.issueVersions),
        },
      };
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  }
  return { state, request };
}
test("issue extraction is bounded to the product projects and deduplicates", () => {
  assert.deepEqual(
    issueKeys("FL-1 FL-1 FIOS-2 FC-9 XFL-3 badFL-4 FL-5suffix", ["FL", "FIOS"]),
    ["FIOS-2", "FL-1"],
  );
});
test("rejects missing source, wrong channel, invalid keys and unsafe evidence before writes", () => {
  for (const patch of [
    { sourceSha: "" },
    { channel: "staging" },
    { issueKeys: ["FC-1"] },
    { evidenceUrl: "http://example.org" },
  ]) {
    assert.throws(() => validateReceipt({ ...receipt, ...patch }, "Library"));
  }
});
test("adds shipped version without replacing historical versions and verifies evidence", async () => {
  const { state, request } = fixture({
    issueVersions: [{ id: "7", name: "Existing", released: true }],
  });
  await syncRelease(receipt, { product: "Library", request });
  assert.deepEqual(
    state.issueVersions.map((v) => v.id),
    ["7", "10"],
  );
  assert.equal(state.versions[0].released, true);
  assert.equal(state.versions[0].releaseDate, "2026-10-28");
  assert.equal(state.links.size, 1);
  assert.equal(Object.values(state.properties)[0].sourceSha, receipt.sourceSha);
});
test("retry does not duplicate versions, fixVersions or release links", async () => {
  const { state, request } = fixture();
  await syncRelease(receipt, { product: "Library", request });
  await syncRelease(receipt, { product: "Library", request });
  assert.equal(state.versions.length, 1);
  assert.equal(state.issueVersions.length, 1);
  assert.equal(state.links.size, 1);
});
test("will not release a planned version containing deferred issues", async () => {
  const { state, request } = fixture({
    versions: [{ id: "10", name: "Library 1.2.3", released: false }],
    deferred: ["FL-2"],
  });
  await assert.rejects(
    syncRelease(receipt, { product: "Library", request }),
    /deferred issues/,
  );
  assert(!state.writes.some((w) => w.method === "PUT"));
});
test("read-back failure leaves the version unreleased for a safe retry", async () => {
  const { state, request } = fixture({ failReadback: true });
  await assert.rejects(
    syncRelease(receipt, { product: "Library", request }),
    /read-back/,
  );
  assert.equal(state.versions[0].released, false);
});
test("refuses reuse of a released version for a different source", async () => {
  const { request } = fixture({
    versions: [
      {
        id: "10",
        name: "Library 1.2.3",
        released: true,
        description: `Source: ${"c".repeat(40)}\n`,
      },
    ],
  });
  await assert.rejects(
    syncRelease(receipt, { product: "Library", request }),
    /different or unknown source/,
  );
});
test("explicit milestones create unreleased plans and do not create shipment links", async () => {
  const { state, request } = fixture();
  await syncRelease(
    {
      mode: "planned",
      version: "1.2.3",
      issueKeys: ["FL-1"],
      planKey: "Frameleaf/frameleaf-app#123",
      evidenceUrl: "https://github.com/Frameleaf/frameleaf-app/pull/123",
    },
    { product: "Library", request },
  );
  assert.equal(state.versions[0].released, false);
  assert.equal(state.links.size, 0);
  assert.deepEqual(Object.values(state.properties)[0].refs, {
    "Frameleaf/frameleaf-app#123": "10",
  });
});
test("moving a plan removes only a bot-owned unused unreleased target", async () => {
  const f = fixture({
    versions: [
      { id: "9", name: "Library 1.2.2", released: false },
      { id: "10", name: "Library 1.2.3", released: false },
    ],
    issueVersions: [
      { id: "7", released: true },
      { id: "9", released: false },
    ],
  });
  f.state.properties[
    "/rest/api/3/issue/FL-1/properties/frameleaf.release-plans.library"
  ] = { refs: { "Frameleaf/frameleaf-app#123": "9" }, owned: ["9"] };
  await syncRelease(
    {
      mode: "planned",
      version: "1.2.3",
      issueKeys: ["FL-1"],
      planKey: "Frameleaf/frameleaf-app#123",
      evidenceUrl: "https://github.com/Frameleaf/frameleaf-app/pull/123",
    },
    { product: "Library", request: f.request },
  );
  assert.deepEqual(
    f.state.issueVersions.map((v) => v.id),
    ["7", "10"],
  );
});
test("empty release range makes no Jira mutations", async () => {
  const { state, request } = fixture();
  assert.equal(
    (
      await syncRelease(
        { ...receipt, issueKeys: [] },
        { product: "Library", request },
      )
    ).issues,
    0,
  );
  assert.deepEqual(state.writes, []);
});
test("a planned target cannot attach new work to an already shipped version", async () => {
  const f = fixture({
    versions: [{ id: "10", name: "Library 1.2.3", released: true }],
  });
  const planned = {
    mode: "planned",
    version: "1.2.3",
    issueKeys: ["FL-1"],
    planKey: "Frameleaf/frameleaf-app#123",
    evidenceUrl: "https://github.com/Frameleaf/frameleaf-app/pull/123",
  };
  await assert.rejects(
    syncRelease(planned, { product: "Library", request: f.request }),
    /already released/,
  );
  assert.deepEqual(f.state.writes, []);
});
test("a failed ledger completion retains ownership for retry and cancellation", async () => {
  const f = fixture();
  const planned = {
    mode: "planned",
    version: "1.2.3",
    issueKeys: ["FL-1"],
    planKey: "Frameleaf/frameleaf-app#123",
    evidenceUrl: "https://github.com/Frameleaf/frameleaf-app/pull/123",
  };
  let propertyWrites = 0;
  const request = async (path, method, body) => {
    if (
      path.includes("/properties/") &&
      method === "PUT" &&
      ++propertyWrites === 2
    )
      throw new Error("interrupted");
    return f.request(path, method, body);
  };
  await assert.rejects(
    syncRelease(planned, { product: "Library", request }),
    /interrupted/,
  );
  await syncRelease(planned, { product: "Library", request: f.request });
  await cancelPlan(["FL-1"], planned.planKey, {
    product: "Library",
    request: f.request,
  });
  assert.deepEqual(f.state.issueVersions, []);
});
test("cancelling one of two PR references preserves their shared planned version", async () => {
  const f = fixture();
  const planned = {
    mode: "planned",
    version: "1.2.3",
    issueKeys: ["FL-1"],
    planKey: "Frameleaf/frameleaf-app#123",
    evidenceUrl: "https://github.com/Frameleaf/frameleaf-app/pull/123",
  };
  await syncRelease(planned, { product: "Library", request: f.request });
  await syncRelease(
    { ...planned, planKey: "Frameleaf/frameleaf-app#124" },
    { product: "Library", request: f.request },
  );
  await cancelPlan(["FL-1"], planned.planKey, {
    product: "Library",
    request: f.request,
  });
  assert.equal(f.state.issueVersions.length, 1);
});
test("concurrent version creation still checks for deferred issues before release", async () => {
  const f = fixture({ deferred: ["FL-2"] });
  const request = async (path, method, body) => {
    if (path === "/rest/api/3/version" && method === "POST") {
      f.state.versions.push({
        id: "10",
        name: "Library 1.2.3",
        released: false,
      });
      throw Object.assign(new Error("conflict"), { status: 400 });
    }
    return f.request(path, method, body);
  };
  await assert.rejects(
    syncRelease(receipt, { product: "Library", request }),
    /deferred/,
  );
  assert.equal(f.state.versions[0].released, false);
});
test("cancellation drains an interrupted retarget without losing historical versions", async () => {
  const f = fixture({
    versions: [{ id: "10", name: "Library 1.2.3", released: false }],
    issueVersions: [
      { id: "7", released: true },
      { id: "9", released: false },
    ],
  });
  const key = "Frameleaf/frameleaf-app#123";
  f.state.properties[
    "/rest/api/3/issue/FL-1/properties/frameleaf.release-plans.library"
  ] = { refs: { [key]: "9" }, owned: ["9"] };
  const request = async (path, method, body) => {
    if (path === "/rest/api/3/issue/FL-1" && method === "PUT")
      throw new Error("interrupted issue write");
    return f.request(path, method, body);
  };
  await assert.rejects(
    syncRelease(
      {
        mode: "planned",
        version: "1.2.3",
        issueKeys: ["FL-1"],
        planKey: key,
        evidenceUrl: "https://github.com/Frameleaf/frameleaf-app/pull/123",
      },
      { product: "Library", request },
    ),
    /interrupted/,
  );
  await cancelPlan(["FL-1"], key, { product: "Library", request: f.request });
  assert.deepEqual(
    f.state.issueVersions.map((v) => v.id),
    ["7"],
  );
});
