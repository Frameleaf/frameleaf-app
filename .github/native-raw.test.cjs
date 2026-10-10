const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const { load } = createRequire(resolve(__dirname, "../server/package.json"))(
  "js-yaml",
);

test("host pnpm setup and cache run only for the LibRaw validation path", () => {
  const workflow = load(
    readFileSync(resolve(__dirname, "workflows/fork-integration.yml"), "utf8"),
  );
  const steps = workflow.jobs["native-raw"].steps;
  const hostActions = ["pnpm/action-setup", "actions/setup-node"];
  for (const engine of ["libraw", "darktable"]) {
    const selected = steps.filter(
      (step) => !step.if || step.if === `inputs.raw_engine == '${engine}'`,
    );
    assert.deepEqual(
      selected
        .map((step) => step.uses?.split("@")[0])
        .filter((action) => hostActions.includes(action)),
      engine === "libraw" ? hostActions : [],
      `${engine} must only schedule host package setup when it installs dependencies`,
    );
    assert.equal(
      selected.some((step) => step.run === "pnpm install --frozen-lockfile"),
      engine === "libraw",
    );
  }
  const node = steps.find((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  assert.equal(node.with.cache, "pnpm", "LibRaw retains its dependency cache");
});

test("manual full RAW validation builds candidate production native runtime on both architectures", () => {
  const workflow = load(
    readFileSync(resolve(__dirname, "workflows/fork-integration.yml"), "utf8"),
  );
  const job = workflow.jobs["native-raw"];
  assert.match(job.if, /workflow_dispatch.*inputs.raw_engine != 'none'/);
  assert.ok(!job["continue-on-error"]);
  assert.ok(job.steps.every((step) => !step["continue-on-error"]));
  assert.deepEqual(
    job.strategy.matrix.include.map(({ platform }) => platform),
    ["linux/amd64", "linux/arm64"],
  );
  const steps = job.steps.filter(
    ({ if: condition }) => condition === "inputs.raw_engine == 'darktable'",
  );
  const commands = steps.map(({ run }) => run || "").join("\n");
  assert.match(commands, /--target native-raw-validation/);
  assert.match(commands, /--platform "\$RAW_PLATFORM"/);
  assert.match(commands, /--no-cache/);
  assert.doesNotMatch(commands, /AppImage|vitest.config.darktable/);
  assert.match(commands, /--network none/);
  assert.match(commands, /test-assets\/formats\/raw,dst=\/fixtures,readonly/);
  assert.match(
    commands,
    /verify-darktable-develop\.mjs[\s\S]*5496 3670[^\n]*calibrated/,
  );
  assert.doesNotMatch(commands, /continue-on-error|\|\| true/);
  const dockerfile = readFileSync(
    resolve(__dirname, "../server/Dockerfile"),
    "utf8",
  );
  const stage = dockerfile
    .split("FROM base-server-prod AS native-raw-validation")[1]
    ?.split("\nFROM ")[0];
  assert.ok(stage, "Validation must use the production runtime base");
  assert.match(stage, /COPY --from=server \/output\/server-pruned \.\/server/);
  assert.match(stage, /verify-darktable\.mjs verify \/usr\/local/);
  assert.match(stage, /import.*darktable-renderer\.js/);
  assert.doesNotMatch(stage, /--from=(web|studio-engine)/);
});
