// Exercise the actual workflow script without network access or repository writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { load } = createRequire(
  path.resolve(__dirname, "../server/package.json"),
)("js-yaml");
const { runInNewContext } = require("node:vm");
const workflow = load(
  fs.readFileSync(
    path.join(__dirname, "workflows/jira-development.yml"),
    "utf8",
  ),
);
assert.deepEqual(workflow.permissions, {});
assert.deepEqual(workflow.on.pull_request.branches, ["fork/main"]);
assert.ok(workflow.on.pull_request.types.includes("edited"));
const job = workflow.jobs["issue-key"];
assert.deepEqual(job.permissions, { contents: "read" });
assert.equal(job.steps.length, 1);
assert.match(job.steps[0].uses, /^actions\/github-script@[0-9a-f]{40}$/);
assert.ok(!job.steps[0].with.script.includes("${{"));

for (const [title, login, type, ref, pass] of [
  [
    "FL-118 Configure delivery",
    "developer",
    "User",
    "codex/FL-118-delivery",
    true,
  ],
  ["ci: [FL-118] configure delivery", "developer", "User", "feature", true],
  ["Fix link FL-8", "developer", "User", "feature", true],
  ["Configure delivery", "developer", "User", "codex/FL-118-delivery", false],
  ["FL-0 invalid key", "developer", "User", "feature", false],
  ["OTHERFL-118 not our key", "developer", "User", "feature", false],
  ["FL-118abc not a key", "developer", "User", "feature", false],
  ["fl-118 wrong case", "developer", "User", "feature", false],
  [
    "Update dependencies",
    "dependabot[bot]",
    "Bot",
    "dependabot/npm_and_yarn/lib",
    true,
  ],
  [
    "Update dependencies",
    "developer",
    "User",
    "dependabot/npm_and_yarn/lib",
    false,
  ],
  [
    "Update dependencies",
    "dependabot[bot]",
    "User",
    "dependabot/npm_and_yarn/lib",
    false,
  ],
  ["Update dependencies", "dependabot[bot]", "Bot", "feature", false],
  [
    "FL-118 $(echo should-not-execute) `globalThis.injected=true`",
    "developer",
    "User",
    "feature",
    true,
  ],
]) {
  const errors = [];
  const sandbox = {
    context: {
      payload: {
        pull_request: { title, user: { login, type }, head: { ref } },
      },
    },
    core: { setFailed: (message) => errors.push(message), notice: () => {} },
  };
  runInNewContext(`(function () { ${job.steps[0].with.script} })()`, sandbox, {
    timeout: 1000,
  });
  assert.equal(errors.length === 0, pass, title);
  assert.equal(sandbox.injected, undefined);
}
console.log(
  "Jira workflow policy: 13 fixtures passed; read-only permissions verified.",
);
