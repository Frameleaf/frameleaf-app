import test from "node:test";
import assert from "node:assert/strict";
import {
  getWorkflowActionOutcome,
  getWorkflowActionSurface,
  getWorkflowReview,
  workflowCoverage,
  workflowIds,
  workflowStates,
} from "../src/high-risk-workflows.mjs";

test("covers every high-risk flow in every required decision state", () => {
  assert.deepEqual(workflowIds, [
    "album",
    "people",
    "recovery",
    "studio",
    "tablet",
  ]);
  assert.deepEqual(workflowStates, [
    "normal",
    "empty",
    "forbidden",
    "stale",
    "retry",
    "keyboard",
    "narrow",
  ]);
  assert.equal(workflowCoverage().length, 35);
  for (const { flowId, stateId } of workflowCoverage()) {
    const review = getWorkflowReview(flowId, stateId);
    assert.equal(review.flowId, flowId);
    assert.equal(review.stateId, stateId);
    assert.ok(review.state.label);
    assert.ok(review.state.summary);
    assert.ok(review.state.primary);
    assert.ok(review.state.secondary);
    assert.equal(review.steps.length, 3);
    assert.ok(review.warning);
  }
});

test("forbidden states disclose no flow facts through the state response", () => {
  for (const flowId of workflowIds) {
    const review = getWorkflowReview(flowId, "forbidden");
    assert.match(review.state.summary, /Do not reveal names, previews, counts/);
    assert.equal(review.state.tone, "blocked");
    assert.deepEqual(review.facts, []);
    assert.equal(review.scope, "Unavailable");
    assert.doesNotMatch(
      JSON.stringify(review),
      /Emma|Jamie|Taylor|revision 19|missing original/i,
    );
  }
});

test("stale and retry states require recovery instead of silent overwrite", () => {
  for (const flowId of workflowIds) {
    assert.equal(
      getWorkflowReview(flowId, "stale").state.primary,
      "Review changes",
    );
    const retry = getWorkflowReview(flowId, "retry");
    if (flowId === "recovery") {
      assert.equal(retry.state.primary, "Retry unresolved 2");
      assert.match(retry.state.summary, /1 finding was recovered/);
      assert.doesNotMatch(retry.state.summary, /changed nothing/);
    } else {
      assert.equal(retry.state.primary, "Retry");
      assert.match(retry.state.summary, /changed nothing/);
    }
  }
});

test("every rendered action has an explicit non-production outcome", () => {
  for (const { flowId, stateId } of workflowCoverage()) {
    for (const kind of ["primary", "secondary"]) {
      const outcome = getWorkflowActionOutcome(flowId, stateId, kind);
      assert.ok(outcome, `${flowId}/${stateId}/${kind}`);
      assert.match(
        outcome,
        /unchanged|changing|nothing|review|opened|retained|cleared|dismissed|cancelled|closed|applied|recovered|returned/i,
        `${flowId}/${stateId}/${kind}`,
      );
    }
  }
});

test("recovery partial failure preserves published and unchanged findings", () => {
  assert.equal(
    getWorkflowActionOutcome("recovery", "retry", "primary"),
    "Retry review opened for 2 unchanged findings. Lake morning.mov remains recovered.",
  );
  assert.equal(
    getWorkflowActionOutcome("recovery", "retry", "secondary"),
    "Results closed. Lake morning.mov remains recovered; the other findings remain unchanged.",
  );
  const retry = getWorkflowActionSurface("recovery", "retry", "primary");
  assert.equal(retry.id, "recovery-retry-checkpoint");
  assert.equal(retry.items.length, 2);
  assert.match(retry.summary, /stays recovered outside this retry checkpoint/);
  assert.doesNotMatch(retry.items.join(" "), /Lake morning/);
});

test("bounded action surfaces encode invite and revision review structure", () => {
  assert.deepEqual(getWorkflowActionSurface("album", "normal", "primary"), {
    id: "invite-review",
    title: "Invite collaborator review",
    summary: "Choose an identity and role before any invitation can be sent.",
    items: [
      "No recipient selected",
      "Role not selected",
      "Album remains unchanged",
    ],
  });
  const revision = getWorkflowActionSurface("studio", "stale", "primary");
  assert.equal(revision.id, "revision-comparison");
  assert.match(
    revision.items.join(" "),
    /revision 18.*revision 19.*Overwrite blocked/,
  );
  assert.equal(getWorkflowActionSurface("album", "normal", "secondary"), null);
});
