// Exercise the actual workflow admission and API-only checks before checkout.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { load } = createRequire(
  path.resolve(__dirname, "../server/package.json"),
)("js-yaml");
const workflow = load(
  fs.readFileSync(path.join(__dirname, "workflows/fork-release.yml"), "utf8"),
);
const release = workflow.jobs.release;
const repository = "Frameleaf/frameleaf-app";
const sha = "a".repeat(40);
const run = {
  id: 123,
  event: "push",
  status: "completed",
  conclusion: "success",
  path: ".github/workflows/docker.yml",
  head_repository: { full_name: repository },
  head_branch: "fork/main",
  head_sha: sha,
};
for (const [event_name, ref, workflow_run, allowed] of [
  ["workflow_run", "refs/heads/fork/main", run, true],
  [
    "workflow_run",
    "refs/heads/fork/main",
    { ...run, event: "workflow_dispatch" },
    true,
  ],
  [
    "workflow_run",
    "refs/heads/fork/main",
    { ...run, event: "pull_request" },
    false,
  ],
  [
    "workflow_run",
    "refs/heads/fork/main",
    { ...run, head_repository: { full_name: "attacker/app" } },
    false,
  ],
  [
    "workflow_run",
    "refs/heads/fork/main",
    { ...run, head_branch: "feature" },
    false,
  ],
  [
    "workflow_run",
    "refs/heads/fork/main",
    { ...run, conclusion: "failure" },
    false,
  ],
  ["workflow_dispatch", "refs/heads/fork/main", undefined, true],
  ["workflow_dispatch", "refs/heads/feature", undefined, false],
]) {
  assert.equal(
    vm.runInNewContext(release.if.replace(/^\$\{\{|\}\}$/g, ""), {
      github: { repository, event_name, ref, event: { workflow_run } },
    }),
    allowed,
  );
}
const resolve = release.steps.findIndex((step) => step.id === "sha");
const checkout = release.steps.findIndex((step) =>
  step.uses?.startsWith("actions/checkout@"),
);
assert(resolve >= 0 && resolve < checkout, "Must verify trust before checkout");
assert.equal(release.steps[checkout].with.ref, "${{ steps.sha.outputs.sha }}");
assert.equal(release.steps[checkout].with["persist-credentials"], false);
assert.equal(workflow.concurrency["cancel-in-progress"], false);
(async () => {
  let count = 0;
  for (const eventName of ["workflow_run", "workflow_dispatch"]) {
    for (const [change, mainline, allowed] of [
      [{}, sha, true],
      [{}, "b".repeat(40), false],
      [{ path: ".github/workflows/untrusted.yml" }, sha, false],
      [{ status: "in_progress" }, sha, false],
      [{ conclusion: "failure" }, sha, false],
      [{ head_sha: "b".repeat(40) }, sha, false],
      [{ head_repository: { full_name: "attacker/app" } }, sha, false],
      [{ event: "pull_request" }, sha, false],
      [{ head_branch: "feature" }, sha, false],
    ]) {
      const outputs = {};
      const queried = { ...run, ...change };
      const execution = vm.runInNewContext(
        `(async()=>{${release.steps[resolve].with.script}})()`,
        {
          context: {
            eventName,
            sha,
            payload: { workflow_run: run },
            repo: { owner: "Frameleaf", repo: "frameleaf-app" },
          },
          core: {
            setOutput: (key, value) => {
              outputs[key] = value;
            },
          },
          github: {
            paginate: async () => [queried],
            rest: {
              git: {
                getRef: async ({ ref }) => {
                  assert.equal(ref, "heads/fork/main");
                  return { data: { object: { sha: mainline } } };
                },
              },
              actions: {
                getWorkflowRun: async ({ run_id }) => {
                  assert.equal(run_id, 123);
                  return { data: queried };
                },
                listWorkflowRuns: () => {},
              },
            },
          },
        },
      );
      if (allowed) {
        await execution;
        assert.deepEqual(outputs, { sha, run: "123" });
      } else {
        await assert.rejects(execution);
        assert.deepEqual(outputs, {});
      }
      count++;
    }
  }
  console.log(
    `Release admission and ${count} exact-SHA certified-run cases passed, including manual-dispatch bypass rejection.`,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
