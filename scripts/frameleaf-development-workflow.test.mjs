import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { load } = createRequire(join(root, "server/package.json"))("js-yaml");
const workflow = (file) =>
  load(readFileSync(join(root, ".github/workflows", file), "utf8"));

test("explicit development diagnostics can capture a feature candidate without admitting pull requests or forks", () => {
  const condition = workflow(
    "development-validation.yml",
  ).jobs.development.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  for (const [repository, ref, event_name, expected] of [
    [
      "Frameleaf/frameleaf-app",
      "refs/heads/aj/power-workflows",
      "workflow_dispatch",
      true,
    ],
    ["Frameleaf/frameleaf-app", "refs/pull/539/merge", "pull_request", false],
    ["someone/frameleaf-app", "refs/heads/main", "workflow_dispatch", false],
    ["Frameleaf/frameleaf-app", "refs/heads/main", "push", true],
  ]) {
    assert.equal(
      runInNewContext(condition, { github: { repository, ref, event_name } }),
      expected,
    );
  }
});

test("development diagnostics are read-only and dispatchable through existing Test definition", () => {
  const entry = workflow("test.yml");
  assert.equal(
    entry.on.workflow_dispatch.inputs.development_validation.default,
    false,
  );
  assert.equal(entry.on.workflow_dispatch.inputs.candidate_sha, undefined);
  const call = entry.jobs["development-validation"];
  assert.equal(call.uses, "./.github/workflows/development-validation.yml");
  assert.match(call.if, /workflow_dispatch.*inputs\.development_validation/);
  assert.deepEqual(call.permissions, { contents: "read" });
  for (const [name, job] of Object.entries(entry.jobs)) {
    if (name !== "development-validation")
      assert.match(job.if, /!inputs\.development_validation/);
  }
  const definition = workflow("development-validation.yml");
  assert.deepEqual(Object.keys(definition.on).sort(), [
    "workflow_call",
    "workflow_dispatch",
  ]);
  assert.deepEqual(definition.permissions, { contents: "read" });
  const job = definition.jobs.development;
  assert.match(job.if, /Frameleaf\/frameleaf-app/);
  assert.match(job.if, /refs\/heads\/main/);
  assert.doesNotMatch(
    job.if,
    /master\/frameleaf-implementation|aj\/FL-333-pg19/,
  );
  assert.deepEqual(job.permissions, { contents: "read" });
  const checkout = job.steps.find(({ uses }) =>
    uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const commands = job.steps.map(({ run }) => run ?? "").join("\n");
  assert.doesNotMatch(
    commands,
    /git push|gh workflow|npm publish|docker push|sql-tools build|@immich\/sql-tools/,
  );
});

test("failed checks preserve diagnostics but cannot produce a successful development result", () => {
  const steps = workflow("development-validation.yml").jobs.development.steps;
  const required = [
    "lockfile",
    "install",
    "sdks",
    "types",
    "lint",
    "server",
    "postgres",
    "schema",
    "baseline_sql",
    "catalog",
    "openapi",
    "client",
    "queries",
  ];
  for (const id of required)
    assert.equal(
      steps.find((step) => step.id === id)["continue-on-error"],
      true,
    );
  assert.match(
    steps.find(({ id }) => id === "lockfile").run,
    /--lockfile-only --ignore-scripts/,
  );
  for (const id of [
    "types",
    "lint",
    "server",
    "catalog",
    "openapi",
    "queries",
  ]) {
    assert.match(steps.find((step) => step.id === id).if, /always\(\)/);
    assert.match(
      steps.find((step) => step.id === id).run,
      /set -(?:euo|o) pipefail/,
    );
  }
  const upload = steps.find(({ uses }) =>
    uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(upload.if, "${{ always() }}");
  assert.match(upload.with.path, /runner\.temp.*frameleaf-development/);
  const finalize = steps.at(-1);
  assert.equal(finalize.if, "${{ always() }}");
  for (const id of required) assert.ok(finalize.run.includes(`'${id}'`));
  assert.match(finalize.run, /\.outcome !== 'success'/);
  assert.match(finalize.run, /process\.exit\(1\)/);
  const catalog = steps.find(({ id }) => id === "catalog");
  assert.match(catalog.run, /snapshot-frameleaf-schema-catalog\.ts/);
  assert.match(catalog.run, /freeze-frameleaf-schema\.ts[\s\S]*--desired-only/);
  const schema = steps.find(({ id }) => id === "schema");
  assert.match(schema.run, /pnpm --dir server migrations:run/);
  const collect = steps.find(
    ({ name }) => name === "Collect generated files and outcomes",
  );
  assert.equal(collect.if, "${{ always() }}");
  assert.match(collect.run, /step-outcomes\.json/);
  assert.match(collect.run, /git diff --binary/);
});

test("fixture bootstrap uses the repository root even in server and e2e jobs", () => {
  for (const job of Object.values(workflow("test.yml").jobs)) {
    for (const step of job.steps ?? []) {
      if (step.run === "bash scripts/checkout-test-assets.sh")
        assert.equal(step["working-directory"], ".");
    }
  }
});
