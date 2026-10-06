import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
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
  for (const repository of ["Frameleaf/frameleaf-app", "immich-app/immich"]) {
    for (const event_name of ["pull_request", "push", "workflow_dispatch"]) {
      for (const development_validation of [false, true]) {
        assert.equal(
          runInNewContext(call.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
            github: { repository, event_name },
            inputs: { development_validation },
          }),
          repository === "Frameleaf/frameleaf-app" &&
            (event_name !== "workflow_dispatch" || !development_validation),
        );
      }
    }
  }
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

const assertConsumerCoverage = (job) => {
  const steps = job.steps;
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  const required = [
    "Install locked App test dependencies",
    "Build required SDKs",
    "Install isolated locked Cloud test dependency",
    "Receive verified archive",
    "Validate credential isolation and package pins",
    "Test actual Library consumers against installed registry bytes",
    "Run existing discovery, push and scheduling regressions",
  ];
  let previous = -1;
  for (const name of required) {
    const index = steps.findIndex((step) => step.name === name);
    assert.ok(
      index > previous,
      `Required consumer step must execute in order: ${name}`,
    );
    assert.equal(steps[index].if, undefined);
    assert.equal(steps[index]["continue-on-error"], undefined);
    assert.doesNotMatch(steps[index].run ?? "", /\|\| true|exit 0/);
    previous = index;
  }
  assert.match(
    steps.find((step) => step.name === "Install locked App test dependencies")
      .run,
    /--filter @frameleaf\/sdk --filter @frameleaf\/plugin-sdk/,
  );
  assert.match(
    steps.find((step) => step.name === "Build required SDKs").run,
    /@frameleaf\/sdk build[\s\S]*@frameleaf\/plugin-sdk build/,
  );
  const installed = steps.find(
    (step) =>
      step.name ===
      "Test actual Library consumers against installed registry bytes",
  );
  assert.equal(installed.run, "node test/lifecycle/run-installed-package.mjs");
  assert.equal(installed["working-directory"], "server");
  assert.deepEqual(installed.env, {
    FRAMELEAF_CLOUD_LIFECYCLE_TGZ:
      "${{ runner.temp }}/cloud-contracts/frameleaf-cloud-contracts-0.0.5.tgz",
    FRAMELEAF_CLOUD_LIFECYCLE_NODE_MODULES:
      "${{ runner.temp }}/cloud-test-dependencies/node_modules",
  });
  assert.equal(
    steps.find(
      (step) => step.name === "Validate credential isolation and package pins",
    ).run,
    "node --test scripts/frameleaf-cloud-consumer-workflow.test.mjs",
  );
  const regressions = steps.find(
    (step) =>
      step.name === "Run existing discovery, push and scheduling regressions",
  );
  assert.equal(regressions["working-directory"], "server");
  assert.equal(
    regressions.run.trim(),
    [
      "pnpm test frameleaf-push.spec.ts frameleaf-cloud-push.repository.spec.ts frameleaf-cloud-contracts.spec.ts",
      "pnpm test cloud-ml-job.service.spec.ts -t 'long-polls a started job|waits out a read'",
    ].join("\n"),
  );
};

test("ordinary consumers retain installed-package and SDK regression coverage", () => {
  assertConsumerCoverage(document().jobs.consumers);
});

test("consumer coverage rejects omitted, skipped or masked installed-package and scheduling tests", () => {
  const job = document().jobs.consumers;
  for (const name of [
    "Test actual Library consumers against installed registry bytes",
    "Run existing discovery, push and scheduling regressions",
  ]) {
    const missing = structuredClone(job);
    missing.steps = missing.steps.filter((step) => step.name !== name);
    assert.throws(() => assertConsumerCoverage(missing));
    for (const change of [
      { run: "exit 0" },
      { if: "false" },
      { "continue-on-error": true },
    ]) {
      const changed = structuredClone(job);
      Object.assign(
        changed.steps.find((step) => step.name === name),
        change,
      );
      assert.throws(() => assertConsumerCoverage(changed));
    }
  }
  const partial = structuredClone(job);
  partial.steps.find(
    (step) =>
      step.name === "Run existing discovery, push and scheduling regressions",
  ).run =
    "pnpm test frameleaf-push.spec.ts frameleaf-cloud-push.repository.spec.ts frameleaf-cloud-contracts.spec.ts";
  assert.throws(() => assertConsumerCoverage(partial));
  assert.throws(() => assertConsumerCoverage({ ...job, if: "false" }));
  assert.throws(() =>
    assertConsumerCoverage({ ...job, "continue-on-error": true }),
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
