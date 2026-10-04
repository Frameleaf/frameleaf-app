import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { load } = createRequire(join(root, "server/package.json"))("js-yaml");
const document = () =>
  load(
    readFileSync(
      join(root, ".github/workflows/frameleaf-cloud-consumers.yml"),
      "utf8",
    ),
  );

test("package credentials never reach repository checkout or consumer execution", () => {
  const workflow = document();
  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
  assert.deepEqual(workflow.permissions, {});
  const retrieval = workflow.jobs["registry-archive"];
  assert.deepEqual(retrieval.permissions, { packages: "read" });
  assert.match(
    retrieval.if,
    /github\.repository == 'Frameleaf\/frameleaf-app'/,
  );
  assert.equal(workflow.on.workflow_call, null);
  assert.doesNotMatch(retrieval.if, /inputs\.|workflow_dispatch|github\.ref/);
  assert.ok(
    retrieval.steps.every((step) => !step.uses?.startsWith("actions/checkout")),
  );
  const fetch = retrieval.steps.find((step) => step.id === "fetch");
  assert.equal(fetch.env.NODE_AUTH_TOKEN, "${{ github.token }}");
  assert.match(
    fetch.run,
    /npm pack @frameleaf\/cloud-contracts@0\.0\.5 .*--ignore-scripts/,
  );
  assert.doesNotMatch(fetch.run, /\$\{\{\s*(?:inputs|github\.event)/);
  const consumers = workflow.jobs.consumers;
  assert.deepEqual(consumers.permissions, { contents: "read" });
  assert.equal(consumers.needs, "registry-archive");
  assert.equal(
    consumers.steps.find((step) => step.uses?.startsWith("actions/checkout"))
      .with.ref,
    "${{ github.sha }}",
  );
  assert.ok(
    consumers.steps.every(
      (step) =>
        !JSON.stringify(step).match(/NODE_AUTH_TOKEN|secrets\.|github\.token/),
    ),
  );
  assert.ok(
    consumers.steps.some((step) =>
      step.run?.includes("test/lifecycle/run-installed-package.mjs"),
    ),
  );
  assert.equal(consumers.steps.at(-1).if, "${{ always() }}");
  const entry = load(
    readFileSync(join(root, ".github/workflows/test.yml"), "utf8"),
  );
  const call = entry.jobs["cloud-consumer-tests"];
  assert.match(call.if, /github\.repository == 'Frameleaf\/frameleaf-app'/);
  assert.match(call.if, /!inputs\.development_validation/);
  assert.equal(call.with, undefined);
  assert.equal(
    entry.on.workflow_dispatch.inputs.development_validation.type,
    "boolean",
  );
  assert.equal(entry.on.workflow_dispatch.inputs.candidate_sha, undefined);
  assert.equal(call.uses, "./.github/workflows/frameleaf-cloud-consumers.yml");
  assert.equal(call.secrets, undefined);
  for (const job of Object.values(entry.jobs)) {
    assert.doesNotMatch(job.if ?? "", /inputs\.candidate_sha/);
  }
});

test("ordinary consumers retain installed-package and SDK regression coverage", () => {
  const steps = document().jobs.consumers.steps;
  assert.match(
    steps.find((step) => step.name === "Install locked App test dependencies")
      .run,
    /--filter @immich\/sdk --filter @immich\/plugin-sdk/,
  );
  assert.match(
    steps.find((step) => step.name === "Build required SDKs").run,
    /@immich\/sdk build[\s\S]*@immich\/plugin-sdk build/,
  );
});

test("retrieval pins the same immutable archive as the consumer integrity manifest", () => {
  const manifest = JSON.parse(
    readFileSync(
      join(root, "server/test/lifecycle/contracts-package-receipt.json"),
      "utf8",
    ),
  );
  const fetch = document().jobs["registry-archive"].steps.find(
    (step) => step.id === "fetch",
  );
  for (const value of [
    manifest.sha256,
    manifest.integrity,
    String(manifest.bytes),
  ])
    assert.ok(fetch.run.includes(value));
  const dependencies = JSON.parse(
    readFileSync(
      join(root, "server/test/lifecycle/dependencies/package.json"),
      "utf8",
    ),
  );
  const lock = JSON.parse(
    readFileSync(
      join(root, "server/test/lifecycle/dependencies/package-lock.json"),
      "utf8",
    ),
  );
  assert.equal(dependencies.dependencies.zod, "4.6.5");
  assert.equal(lock.packages["node_modules/zod"].version, "4.6.5");
  assert.match(lock.packages["node_modules/zod"].integrity, /^sha512-/);
});
