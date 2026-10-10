// Read-only contract checks for hosted CI and the canonical container publisher.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { runInNewContext } = require("node:vm");
const { load } = createRequire(
  path.resolve(__dirname, "../server/package.json"),
)("js-yaml");
const { VARIANTS, validateBuildInput } = require("./frameleaf-release.cjs");
const directory = path.join(__dirname, "workflows");
const workflows = Object.fromEntries(
  fs
    .readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => [
      file,
      load(fs.readFileSync(path.join(directory, file), "utf8")),
    ]),
);
const hosted = new Set([
  "ubuntu-24.04",
  "ubuntu-24.04-arm",
  "windows-latest",
  "macos-26",
]);
let count = 0;
for (const [file, workflow] of Object.entries(workflows)) {
  assert(
    !JSON.stringify(workflow).match(
      /adamtaylor152|altran1502|secrets\.(PUSH_O_MATIC|DOCKERHUB|FDROID|CLOUDFLARE)/,
    ),
    `${file}: inherited identity, publishing destination or secret`,
  );
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const label = `${file}/${id}`;
    for (const step of job.steps || []) {
      if (step.uses && !step.uses.startsWith("./"))
        assert.match(
          step.uses,
          /@[a-f0-9]{40}$/,
          `${label}: action must be commit-pinned`,
        );
      if (step.uses?.startsWith("actions/checkout@"))
        assert.equal(
          step.with?.["persist-credentials"],
          false,
          `${label}: checkout must not retain credentials`,
        );
    }
    if (job.uses) {
      assert(
        job.uses.startsWith("./.github/workflows/"),
        `${label}: remote workflow could route execution elsewhere`,
      );
      assert(
        fs.existsSync(path.resolve(__dirname, "..", job.uses)),
        `${label}: missing local workflow`,
      );
    } else if (job["runs-on"] === "${{ matrix.runner }}") {
      if (
        file === "local-multi-runner-build.yml" &&
        (id === "build" || id === "publish")
      )
        assert.equal(
          job.strategy.matrix.include,
          "${{ fromJSON(needs.matrix.outputs.matrix) }}",
        );
      else if (file === "cli.yml" && id === "build")
        assert.deepEqual(
          job.strategy?.matrix,
          {
            include: [
              {
                runner: "ubuntu-24.04",
                architecture: "amd64",
                "node-architecture": "x64",
              },
              {
                runner: "ubuntu-24.04-arm",
                architecture: "arm64",
                "node-architecture": "arm64",
              },
            ],
          },
          `${label}: uncontrolled native CLI runner matrix`,
        );
      else {
        const runners = job.strategy?.matrix?.runner;
        assert(
          Array.isArray(runners) &&
            runners.length &&
            runners.every((runner) => hosted.has(runner)),
          `${label}: uncontrolled runner matrix`,
        );
      }
    } else
      assert(
        hosted.has(job["runs-on"]),
        `${label}: not a supported hosted runner`,
      );
    count++;
  }
}
const docker = workflows["docker.yml"];
assert.deepEqual(docker.on.push.branches, ["fork/main"]);
assert(
  !docker.on.pull_request && !docker.on.release,
  "Candidate publishing must not run on PR/release events",
);
// FL-142: the built images are archived (not pushed), deployment-tested, and only then pushed.
for (const name of ["server", "machine-learning"]) {
  assert.deepEqual(
    docker.jobs[name].needs,
    ["changes", "integration"],
    "Both quality gates must precede building",
  );
  assert.equal(
    docker.jobs[name].with.mode,
    "archive",
    `${name}: builds must not push before the deployment test`,
  );
}
assert(
  ["integration", "server", "machine-learning"].every((gate) =>
    docker.jobs["deploy-test"].needs.includes(gate),
  ),
  "The deployment test runs on the quality-gated builds",
);
for (const name of [
  "server-publish",
  "machine-learning-publish",
  "machine-learning-hardware",
  "retag-server",
  "retag-machine-learning",
]) {
  assert(
    docker.jobs[name].needs.includes("deploy-test"),
    `${name}: the deployment test must precede publishing`,
  );
  assert.match(
    docker.jobs[name].if,
    /needs\['deploy-test'\]\.result == 'success'/,
    `${name}: publishing requires a passed deployment test`,
  );
}
assert.equal(docker.jobs["server-publish"].with.mode, "publish");
assert.equal(docker.jobs["machine-learning-publish"].with.mode, "publish");
assert.equal(docker.jobs["machine-learning-hardware"].with.mode, "push");
assert.equal(
  docker.jobs.integration.uses,
  "./.github/workflows/fork-integration.yml",
);
assert(Object.hasOwn(workflows["fork-integration.yml"].on, "workflow_call"));
assert(
  !workflows["fork-integration.yml"].on.push,
  "Mainline integration is invoked by Docker only",
);
const cpu = docker.jobs["machine-learning"].with;
const ml = [
  {
    device: cpu.device,
    suffix: cpu.suffix,
    platforms: cpu.platforms,
    target: cpu.target,
  },
  ...docker.jobs["machine-learning-hardware"].strategy.matrix.include,
];
assert.deepEqual(
  ml.map(({ device, suffix, platforms, target }) => ({
    device,
    suffix,
    platforms,
    target,
  })),
  VARIANTS.slice(1).map((v) => ({
    device: v.device,
    suffix: v.suffix,
    platforms: v.platforms.join(","),
    target: v.target,
  })),
);
for (const spec of VARIANTS) {
  const input = {
    IMAGE: spec.image,
    SUFFIX: spec.suffix,
    DEVICE: spec.device,
    PLATFORMS: spec.platforms.join(","),
    TARGET: spec.target,
    CONTEXT: spec.context,
    DOCKERFILE: spec.dockerfile,
    SOURCE_SHA: "a".repeat(40),
    GITHUB_SHA: "a".repeat(40),
    GITHUB_REPOSITORY: "Frameleaf/frameleaf-app",
    GITHUB_REF: "refs/heads/fork/main",
    GITHUB_EVENT_NAME: "push",
  };
  const matrix = validateBuildInput(input);
  assert.deepEqual(
    matrix.map((row) => row.platform),
    spec.platforms,
  );
  assert(matrix.every((row) => hosted.has(row.runner)));
  for (const change of [
    { PLATFORMS: "linux/ppc64le" },
    { PLATFORMS: "linux/amd64,linux/amd64" },
    { TARGET: "attacker" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/feature" },
    { SOURCE_SHA: "b".repeat(40) },
  ])
    assert.throws(() => validateBuildInput({ ...input, ...change }));
}
const unraid = workflows["nsfw-unraid-docker.yml"];
assert.deepEqual(Object.keys(unraid.on), ["workflow_dispatch"]);
assert(
  !JSON.stringify(unraid).includes("packages:write") &&
    !JSON.stringify(unraid).match(/build-push-action|docker\/login-action/),
  "Unraid must not publish competing image tags",
);
const zizmor = workflows["org-zizmor.yml"];
assert(
  Object.values(zizmor.jobs).some((job) =>
    job.steps?.some((step) => /uvx zizmor==[\d.]+/.test(step.run || "")),
  ),
  "Zizmor must execute the real pinned scanner",
);
console.log(
  `Hosted runner, pinned-action, quality-gate and image-variant contracts passed for ${count} jobs.`,
);
