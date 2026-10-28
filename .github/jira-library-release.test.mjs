// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { libraryReceipt } from "./jira-library-release.mjs";

const repository = "Frameleaf/frameleaf-app";
const source = `https://github.com/${repository}`;
const previousSha = "a".repeat(40);
const sourceSha = "b".repeat(40);

function fixture() {
  const run = {
    id: 42,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    path: ".github/workflows/deploy-production.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: "c".repeat(40),
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    run_started_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T11:00:00Z",
  };
  const releases = [
    {
      tag_name: "frameleaf-v1.2.0",
      published_at: "2026-10-01T10:50:00Z",
      assets: [{ name: "release-manifest.json", id: 2 }],
    },
    {
      tag_name: "frameleaf-v1.1.0",
      published_at: "2026-09-01T10:50:00Z",
      assets: [{ name: "release-manifest.json", id: 1 }],
    },
  ].map((release) => ({ ...release, draft: false, prerelease: false }));
  const manifests = {
    1: {
      schemaVersion: 3,
      repository,
      tag: "frameleaf-v1.1.0",
      sourceCommit: previousSha,
      deploymentRun: `${source}/actions/runs/41`,
    },
    2: {
      schemaVersion: 3,
      repository,
      tag: "frameleaf-v1.2.0",
      sourceCommit: sourceSha,
      deploymentRun: `${source}/actions/runs/42`,
    },
  };
  const jobs = [
    {
      name: "Promote, sign and publish",
      status: "completed",
      conclusion: "success",
    },
  ];
  const calls = [];
  const collected = [];
  const request = async (path) => {
    calls.push(path);
    if (path === "actions/runs/42") return { ...run };
    if (path.startsWith("actions/runs/42/attempts/")) return { jobs };
    if (path.startsWith("releases?")) return releases;
    if (path.startsWith("releases/assets/"))
      return manifests[path.split("/").at(-1)];
    if (path.startsWith("commits/"))
      return { sha: path.endsWith("1.1.0") ? previousSha : sourceSha };
    throw new Error(`Unexpected request ${path}`);
  };
  return {
    run,
    releases,
    manifests,
    jobs,
    calls,
    collected,
    options: {
      runId: "42",
      request,
      collectIssueKeys: async (...range) => {
        collected.push(range);
        return ["FL-123"];
      },
    },
  };
}

test("ships the manifest source, not the workflow head, using the preceding Library release", async () => {
  const f = fixture();
  assert.deepEqual(await libraryReceipt(f.options), {
    version: "1.2.0",
    sourceSha,
    previousSha,
    issueKeys: ["FL-123"],
    evidenceUrl: `${source}/releases/tag/frameleaf-v1.2.0`,
    releasedAt: "2026-10-01T10:50:00Z",
    channel: "library-release",
    mode: "shipped",
  });
  assert.deepEqual(f.collected, [[previousSha, sourceSha]]);
});

test("dry runs, rollout and withdrawal runs never produce shipment receipts", async () => {
  for (const jobs of [
    [],
    [{ name: "Promote, sign and publish", conclusion: "skipped" }],
  ]) {
    const f = fixture();
    f.jobs.splice(0, f.jobs.length, ...jobs);
    assert.equal(await libraryReceipt(f.options), null);
    assert.equal(
      f.calls.some((path) => path.startsWith("releases")),
      false,
    );
  }
});

test("rejects failed, foreign, off-main and unrelated successful workflows", async () => {
  for (const change of [
    { conclusion: "failure" },
    { status: "in_progress" },
    { repository: { full_name: "other/repository" } },
    { head_repository: { full_name: "other/repository" } },
    { path: ".github/workflows/test.yml" },
    { head_branch: "feature" },
    { event: "pull_request" },
  ]) {
    const f = fixture();
    Object.assign(f.run, change);
    await assert.rejects(libraryReceipt(f.options));
    assert.deepEqual(f.collected, []);
  }
});

test("requires exact deployment receipt and publication in this attempt", async () => {
  for (const change of [
    "different-run",
    "before-run",
    "after-run",
    "draft",
    "prerelease",
    "manager",
  ]) {
    const f = fixture();
    if (change === "different-run")
      f.manifests[2].deploymentRun = `${source}/actions/runs/41`;
    if (change === "before-run")
      f.releases[0].published_at = "2026-10-01T09:00:00Z";
    if (change === "after-run")
      f.releases[0].published_at = "2026-10-01T12:00:00Z";
    if (change === "draft") f.releases[0].draft = true;
    if (change === "prerelease") f.releases[0].prerelease = true;
    if (change === "manager") f.releases[0].tag_name = "manager-v1.2.0";
    assert.equal(await libraryReceipt(f.options), null, change);
    assert.deepEqual(f.collected, []);
  }
});

test("rejects malformed, foreign or tag-mismatched release manifests", async () => {
  for (const change of [
    { schemaVersion: 2 },
    { repository: "other/repository" },
    { tag: "frameleaf-v9.0.0" },
    { sourceCommit: "bad" },
    { sourceCommit: "d".repeat(40) },
  ]) {
    const f = fixture();
    Object.assign(f.manifests[2], change);
    await assert.rejects(libraryReceipt(f.options));
  }
  const f = fixture();
  f.releases[0].assets = [];
  await assert.rejects(libraryReceipt(f.options), /manifest/);
});

test("requires an explicit baseline for the first release and never scans all history", async () => {
  const f = fixture();
  f.releases.pop();
  await assert.rejects(libraryReceipt(f.options), /JIRA_RELEASE_BASE_SHA/);
  assert.deepEqual(f.collected, []);
  const receipt = await libraryReceipt({
    ...f.options,
    baselineSha: previousSha,
  });
  assert.equal(receipt.previousSha, previousSha);
  assert.deepEqual(f.collected, [[previousSha, sourceSha]]);
});

test("does not silently skip an invalid previous release or override it with the bootstrap SHA", async () => {
  const f = fixture();
  f.manifests[1].sourceCommit = "bad";
  await assert.rejects(
    libraryReceipt({ ...f.options, baselineSha: previousSha }),
    /source commit/,
  );
});

test("propagates ancestry failures before returning a receipt", async () => {
  const f = fixture();
  f.options.collectIssueKeys = async () => {
    throw new Error("not an ancestor");
  };
  await assert.rejects(libraryReceipt(f.options), /not an ancestor/);
});

test("rejects a run whose attempt changes while collecting evidence", async () => {
  const f = fixture();
  f.options.collectIssueKeys = async () => {
    f.run.run_attempt = 2;
    return [];
  };
  await assert.rejects(libraryReceipt(f.options), /attempt changed/);
});

test("reads all release pages before selecting the baseline", async () => {
  const f = fixture();
  const request = f.options.request;
  f.options.request = async (path) => {
    if (path === "releases?per_page=100&page=1")
      return Array.from({ length: 100 }, () => ({
        tag_name: "manager-v1.0.0",
      }));
    if (path === "releases?per_page=100&page=2") return f.releases;
    return request(path);
  };
  assert.equal((await libraryReceipt(f.options)).previousSha, previousSha);
});
