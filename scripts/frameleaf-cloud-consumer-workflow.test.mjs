import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.match(retrieval.if, /refs\/heads\/master\/frameleaf-implementation/);
  assert.match(retrieval.if, /inputs\.candidate_sha == github\.sha/);
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
  const call = entry.jobs["cloud-consumer-qualification"];
  assert.match(call.if, /github\.event_name == 'workflow_dispatch'/);
  assert.equal(call.uses, "./.github/workflows/frameleaf-cloud-consumers.yml");
  assert.equal(call.secrets, undefined);
  for (const [name, job] of Object.entries(entry.jobs)) {
    if (!name.startsWith("cloud-consumer-"))
      assert.match(job.if, /inputs\.candidate_sha == ''/);
  }
});

test("invalid qualification requests fail without credentials or source execution", () => {
  const entry = load(
    readFileSync(join(root, ".github/workflows/test.yml"), "utf8"),
  );
  const validation = entry.jobs["cloud-consumer-request"];
  assert.deepEqual(validation.permissions, {});
  assert.equal(validation.steps.length, 1);
  const step = validation.steps[0];
  assert.equal(step.uses, undefined);
  assert.equal(
    entry.jobs["cloud-consumer-qualification"].needs,
    "cloud-consumer-request",
  );
  const candidate = "a".repeat(40);
  const environment = {
    FRAMELEAF_REQUEST_REPOSITORY: "Frameleaf/frameleaf-app",
    FRAMELEAF_REQUEST_REF: "refs/heads/master/frameleaf-implementation",
    FRAMELEAF_REQUEST_SHA: candidate,
    FRAMELEAF_REQUEST_HEAD: candidate,
  };
  const run = (changes) =>
    spawnSync("bash", ["-e", "-c", step.run], {
      env: { ...process.env, ...environment, ...changes },
      encoding: "utf8",
    });
  assert.equal(run({}).status, 0);
  for (const changes of [
    { FRAMELEAF_REQUEST_SHA: "b".repeat(40) },
    { FRAMELEAF_REQUEST_REF: "refs/heads/fork/main" },
    { FRAMELEAF_REQUEST_REPOSITORY: "external/contributor" },
    { FRAMELEAF_REQUEST_SHA: "bad;$(exit 0)" },
  ])
    assert.notEqual(run(changes).status, 0);
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

test("retrieval pins the same immutable archive as the consumer receipt", () => {
  const receipt = JSON.parse(
    readFileSync(
      join(root, "server/test/lifecycle/contracts-package-receipt.json"),
      "utf8",
    ),
  );
  const fetch = document().jobs["registry-archive"].steps.find(
    (step) => step.id === "fetch",
  );
  for (const value of [
    receipt.sha256,
    receipt.integrity,
    String(receipt.bytes),
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
