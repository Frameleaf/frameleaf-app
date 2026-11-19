const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createRequire } = require("node:module");
const { load } = createRequire(
  path.resolve(__dirname, "../../server/package.json"),
)("js-yaml");

test("NAS dispatch authenticates component and optional application before retaining installers", () => {
  const workflow = load(
    fs.readFileSync(
      path.join(__dirname, "../../.github/workflows/nas-packages.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const job = workflow.jobs.package;
  assert.match(job.if, /refs\/heads\/main/);
  const steps = job.steps;
  const manager = steps.findIndex((step) =>
    step.run?.includes("node packaging/nas/build-manager.cjs"),
  );
  const application = steps.findIndex((step) =>
    step.run?.includes("node packaging/nas/build.cjs"),
  );
  // FL-1683: Forgejo runs use Forgejo's fork of the upload action (the upstream one refuses non-GitHub servers).
  const upload = steps.findIndex((step) =>
    /^(?:actions|https:\/\/code\.forgejo\.org\/forgejo)\/upload-artifact@/.test(
      step.uses ?? "",
    ),
  );
  assert(manager >= 0 && application > manager && upload > application);
  assert.equal(steps[application].if, "inputs['application-tag'] != ''");
  assert.match(steps[manager].run, /\.tag == \$tag/);
  assert.match(steps[application].run, /isDraft or \.isPrerelease/);
  // FL-1683: on Forgejo, github.token cannot read GitHub releases, so `gh` reads them with the publish token.
  // That is the only secret, and only as the read token of a contents:read job.
  const secretRefs =
    JSON.stringify(workflow).match(/secrets\.[A-Za-z_]+/g) ?? [];
  assert(
    secretRefs.every((ref) => ref === "secrets.GH_PUBLISH_TOKEN"),
    secretRefs.join(", "),
  );
  for (const [name, value] of Object.entries(job.env ?? {}))
    if (String(value).includes("secrets.")) {
      assert(["GH_TOKEN", "GITHUB_TOKEN"].includes(name), name);
      assert.equal(value, "${{ secrets.GH_PUBLISH_TOKEN || github.token }}");
    }
  assert(
    !job.steps.some((step) => JSON.stringify(step).includes("secrets.")),
    "no step reads a secret directly",
  );
  assert(!JSON.stringify(workflow).includes("frameleaf-synology"));
  for (const step of steps) {
    if (step.uses?.startsWith("actions/checkout@"))
      assert.equal(step.with["persist-credentials"], false);
    assert.doesNotMatch(step.run ?? "", /\$\{\{.*inputs/);
  }
});
