// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Frameleaf.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planChanges, validatePlanRequest } from "./jira-plan.mjs";
const repo = "Frameleaf/swift-app";
const pr = {
  number: 12,
  title: "FL-1 FIOS-2 update",
  state: "open",
  base: { repo: { full_name: repo } },
  head: { repo: { full_name: repo } },
  milestone: { title: "release: 1.2.3" },
};
test("only explicit release milestones create plans, using current PR metadata", () => {
  const result = planChanges(repo, { number: 12 }, pr);
  assert.deepEqual(result.receipt.issueKeys, ["FIOS-2", "FL-1"]);
  assert.equal(result.receipt.version, "1.2.3");
  assert.equal(
    planChanges(
      repo,
      { number: 12 },
      { ...pr, milestone: { title: "Sprint 4" } },
    ).receipt,
    null,
  );
});
test("fork PRs cannot use secret-bearing plan mutation", () => {
  assert.equal(
    planChanges(
      repo,
      { number: 12 },
      { ...pr, head: { repo: { full_name: "attacker/app" } } },
    ),
    null,
  );
});
test("removed milestones and closed unmerged PRs cancel their plans", () => {
  assert.deepEqual(
    planChanges(repo, { number: 12 }, { ...pr, milestone: null }).remove,
    ["FIOS-2", "FL-1"],
  );
  assert.equal(
    planChanges(repo, { number: 12 }, { ...pr, state: "closed", merged: false })
      .receipt,
    null,
  );
  assert(
    planChanges(repo, { number: 12 }, { ...pr, state: "closed", merged: true })
      .receipt,
  );
});
test("changed issue keys cancel old references but preserve current targets", () => {
  assert.deepEqual(
    planChanges(
      repo,
      { number: 12, changes: { title: { from: "FL-9 old title" } } },
      pr,
    ).remove,
    ["FL-9"],
  );
});
test("metadata artifacts cannot request changes for another PR or workflow", () => {
  const run = {
    path: ".github/workflows/jira-plan-request.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    pull_requests: [{ number: 12 }],
  };
  validatePlanRequest(run, { number: 12 });
  assert.throws(() => validatePlanRequest(run, { number: 13 }));
  assert.throws(() =>
    validatePlanRequest(
      { ...run, path: ".github/workflows/ci.yml" },
      { number: 12 },
    ),
  );
  assert.throws(() =>
    validatePlanRequest(
      { ...run, head_repository: { full_name: "attacker/app" } },
      { number: 12 },
    ),
  );
});
