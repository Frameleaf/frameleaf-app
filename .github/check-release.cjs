// Exercise the Deploy production workflow's admission, environment and secret boundaries (FL-142/145/146).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { load } = createRequire(
  path.resolve(__dirname, "../server/package.json"),
)("js-yaml");
const workflow = load(
  fs.readFileSync(
    path.join(__dirname, "workflows/deploy-production.yml"),
    "utf8",
  ),
);
assert(
  !fs.existsSync(path.join(__dirname, "workflows/fork-release.yml")),
  "The automatic release workflow is replaced by Deploy production",
);
assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
const inputs = workflow.on.workflow_dispatch.inputs;
assert.equal(inputs["dry-run"].default, true, "Dry run must be the default");
assert.deepEqual(inputs.action.options, ["release", "rollout", "withdraw"]);
assert.deepEqual(workflow.permissions, {});
assert.equal(workflow.concurrency.group, "frameleaf-release-promotion");
assert.equal(workflow.concurrency["cancel-in-progress"], false);

const repository = "Frameleaf/frameleaf-app";
const admitted = (
  job,
  { ref, action = "release", dryRun = false, repo = repository },
) =>
  vm.runInNewContext(
    workflow.jobs[job].if
      .replace(/^\$\{\{|\}\}$/g, "")
      .replaceAll("inputs.dry-run", 'inputs["dry-run"]'),
    {
      github: { repository: repo, ref },
      inputs: { action, "dry-run": dryRun },
    },
  );
let cases = 0;
for (const [job, ref, action, dryRun, allowed] of [
  ["candidate", "refs/heads/fork/main", "release", false, true],
  ["candidate", "refs/heads/fork/main", "release", true, true],
  ["candidate", "refs/heads/feature", "release", true, true],
  ["candidate", "refs/heads/feature", "release", false, false],
  ["candidate", "refs/heads/fork/main", "withdraw", false, false],
  ["release", "refs/heads/fork/main", "release", false, true],
  ["release", "refs/heads/fork/main", "release", true, false],
  ["release", "refs/heads/feature", "release", false, false],
  ["release", "refs/heads/fork/main", "rollout", false, false],
  ["flags-plan", "refs/heads/feature", "withdraw", true, true],
  ["flags-plan", "refs/heads/fork/main", "release", false, false],
  ["flags", "refs/heads/fork/main", "withdraw", false, true],
  ["flags", "refs/heads/fork/main", "rollout", false, true],
  ["flags", "refs/heads/fork/main", "withdraw", true, false],
  ["flags", "refs/heads/feature", "withdraw", false, false],
  ["flags", "refs/heads/fork/main", "release", false, false],
]) {
  assert.equal(
    admitted(job, { ref, action, dryRun }),
    allowed,
    `${job} ${ref} ${action} dry-run=${dryRun}`,
  );
  assert.equal(
    admitted(job, { ref, action, dryRun, repo: "attacker/frameleaf-app" }),
    false,
  );
  cases++;
}

// Only the production environment's jobs see the signing key, and only through the environment.
for (const [id, job] of Object.entries(workflow.jobs)) {
  const text = JSON.stringify(job);
  const writes = Object.values(job.permissions ?? {}).includes("write");
  if (text.includes("secrets.") || writes) {
    assert.equal(
      job.environment,
      "production",
      `${id}: writes and secrets need the production environment`,
    );
    assert(job.needs, `${id}: must follow verification`);
  }
  for (const step of job.steps ?? []) {
    assert.doesNotMatch(
      step.run ?? "",
      /secrets\.|COSIGN_(?:PRIVATE_KEY|PASSWORD)|\$\{\{\s*inputs/,
      `${id}: a secret or input is interpolated into a script`,
    );
    if (step.uses?.startsWith("actions/checkout@"))
      assert.equal(step.with["persist-credentials"], false);
  }
}
const release = workflow.jobs.release;
assert.deepEqual(release.needs, ["candidate", "deploy-test"]);
assert.equal(
  release.steps.find((s) => s.uses?.startsWith("actions/checkout@")).with.ref,
  "${{ needs.candidate.outputs.sha }}",
);
const promote = release.steps.at(-1);
assert.equal(promote.run, "node .github/frameleaf-release.cjs release");
assert.equal(promote.env.SIGN, "1");
assert.equal(
  promote.env.COSIGN_PRIVATE_KEY,
  "${{ secrets.COSIGN_PRIVATE_KEY }}",
);
assert.equal(promote.env.COSIGN_PASSWORD, "${{ secrets.COSIGN_PASSWORD }}");
assert.deepEqual(workflow.jobs["deploy-test"].needs, "candidate");
assert.equal(
  workflow.jobs["deploy-test"].steps.at(-1).run,
  "node .github/frameleaf-deploy-test.cjs",
);
assert.deepEqual(workflow.jobs["deploy-test"].permissions, {
  contents: "read",
  packages: "read",
});
assert.deepEqual(workflow.jobs.flags.needs, "flags-plan");
assert.equal(workflow.jobs["flags-plan"].steps.at(-1).env.DRY_RUN, "true");
assert(
  fs.existsSync(path.join(__dirname, "../cosign.pub")),
  "The cosign public key is committed",
);
console.log(
  `Deploy production admission (${cases} cases), environment, secret and ordering contracts passed.`,
);
