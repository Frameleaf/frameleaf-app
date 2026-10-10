import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("required medium tests use the production native runtime and complete suite", () => {
  const dockerfile = read("server/Dockerfile");
  const runner = dockerfile.match(
    /^FROM server AS medium-test\n([\s\S]*?)(?=^FROM )/m,
  )?.[1];
  assert.ok(
    runner,
    "medium-test must inherit the unpruned server and native base",
  );
  assert.match(runner, /COPY --from=plugins .*packages\/plugin-core\/dist/);
  assert.match(
    runner,
    /COPY --from=plugins .*packages\/plugin-core\/manifest.json/,
  );
  assert.match(runner, /WORKDIR \/usr\/src\/app\/server/);
  const command = JSON.parse(runner.match(/^CMD (\[.*\])$/m)[1]);
  assert.deepEqual(command.slice(0, 2), ["bash", "-ec"]);
  assert.match(command[2], /docker version/);
  assert.match(
    command[2],
    /require\("\/usr\/local\/lib\/frameleaf\/image-hdr.node"\)/,
  );
  assert.ok(command[2].endsWith("pnpm run test:medium --run"));
  assert.doesNotMatch(
    command[2],
    /--exclude|--testNamePattern|(?:^|\s)-t\s|\.spec\.ts/,
  );
  assert.equal(
    [...dockerfile.matchAll(/^FROM .* AS (\S+)$/gm)].at(-1)[1],
    "prod",
  );
  const base = (text) =>
    text.match(
      /^# BEGIN frameleaf-server-base\n[\s\S]*?^# END frameleaf-server-base$/m,
    )[0];
  assert.equal(base(dockerfile), base(read("server/Dockerfile.dev")));
  assert.match(
    dockerfile,
    /FRAMELEAF_HDR_ISO_TEST=1 node --test image-hdr.test.mjs/,
  );
  assert.match(
    dockerfile,
    /ghcr.io\/jdx\/mise:2026.9.9@sha256:a88f300ef4365494b88f8eefd271bb92ba467d4a41835739a714426207215730/,
  );
});

test("normal medium job supplies only owned fixture paths and cleans its container", () => {
  const workflow = read(".github/workflows/test.yml");
  const job = workflow
    .split("  server-medium-tests:\n")[1]
    .split("  e2e-tests-server-cli:\n")[0];
  assert.match(job, /target: medium-test/);
  assert.match(job, /load: true/);
  assert.match(job, /cache-from: type=gha,scope=server-medium/);
  assert.match(job, /bash scripts\/checkout-test-assets.sh/);
  assert.match(job, /docker_cli=\$\(readlink -f "\$\(command -v docker\)"\)/);
  assert.match(
    job,
    /src="\$docker_cli",dst=\/usr\/local\/bin\/docker,readonly/,
  );
  assert.match(
    job,
    /src="\$GITHUB_WORKSPACE\/docker\/postgres",dst=\/usr\/src\/app\/docker\/postgres,readonly/,
  );
  assert.match(
    job,
    /src="\$GITHUB_WORKSPACE\/e2e\/src",dst=\/usr\/src\/app\/e2e\/src,readonly/,
  );
  assert.match(
    job,
    /src="\$GITHUB_WORKSPACE\/e2e\/test-assets",dst=\/usr\/src\/app\/e2e\/test-assets,readonly/,
  );
  assert.match(job, /--network host/);
  assert.match(job, /DOCKER_HOST=unix:\/\/\/var\/run\/docker.sock/);
  assert.match(job, /TESTCONTAINERS_HOST_OVERRIDE=localhost/);
  assert.match(
    job,
    /TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=\/var\/run\/docker.sock/,
  );
  assert.match(job, /docker run --rm --pull never --name "\$MEDIUM_CONTAINER"/);
  assert.match(job, /if: always\(\)[\s\S]*docker rm -f "\$MEDIUM_CONTAINER"/);
  assert.match(job, /timeout-minutes: 90/);
  assert.doesNotMatch(
    job,
    /node_modules|server\/dist|RYUK_DISABLED|--privileged|pnpm.*(?:-t |--exclude)/,
  );
  assert.doesNotMatch(job, /run: mise run ci-medium/);
});

// These contracts evaluate the registered dispatch guards and the fixed native
// command; they do not execute Docker or replace the real medium database setup.
const { createRequire } = await import("node:module");
const { existsSync } = await import("node:fs");
const { runInNewContext } = await import("node:vm");
const { load } = createRequire(
  new URL("../server/package.json", import.meta.url),
)("js-yaml");
const readWorkflow = (file) => {
  assert.ok(
    existsSync(new URL(`../.github/workflows/${file}`, import.meta.url)),
    "required reusable workflow is missing",
  );
  return load(read(`.github/workflows/${file}`));
};
const selectedJobs = (
  workflow,
  event,
  development = false,
  medium = false,
  repository = "Frameleaf/frameleaf-app",
) =>
  Object.entries(workflow.jobs)
    .filter(([, job]) =>
      runInNewContext(job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
        github: { event_name: event, repository },
        inputs: {
          development_validation: development,
          medium_publication_regression: medium,
        },
        always: () => true,
      }),
    )
    .map(([id]) => id)
    .sort();

test("registered Test dispatch isolates the fixed medium regression without changing PR or default jobs", () => {
  const workflow = readWorkflow("test.yml");
  assert.deepEqual(
    workflow.on.workflow_dispatch.inputs.medium_publication_regression,
    {
      description:
        "Run only the retained-video publication native PostgreSQL medium regression and controls",
      required: false,
      default: false,
      type: "boolean",
    },
  );
  const ordinary = [
    "cli-unit-tests",
    "cli-unit-tests-win",
    "cloud-consumer-tests",
    "e2e-tests-lint",
    "e2e-tests-server-cli",
    "e2e-tests-web",
    "generated-api-up-to-date",
    "github-files-formatting",
    "i18n-tests",
    "ml-unit-tests",
    "script-unit-tests",
    "server-medium-tests",
    "server-unit-tests",
    "shellcheck",
    "sql-schema-up-to-date",
    "success-check-e2e",
    "web-lint",
    "web-unit-tests",
  ];
  for (const event of ["pull_request", "push"])
    for (const development of [false, true])
      for (const medium of [false, true])
        assert.deepEqual(
          selectedJobs(workflow, event, development, medium),
          ordinary,
        );
  for (const [development, medium, expected] of [
    [false, false, ordinary],
    [true, false, ["development-validation"]],
    [false, true, ["medium-publication-regression"]],
    [true, true, ["medium-publication-regression"]],
  ])
    assert.deepEqual(
      selectedJobs(workflow, "workflow_dispatch", development, medium),
      expected,
    );
  assert.deepEqual(
    selectedJobs(workflow, "workflow_dispatch", false, true, "other/fork"),
    [],
  );
  assert.deepEqual(workflow.jobs["medium-publication-regression"], {
    if: "${{ github.repository == 'Frameleaf/frameleaf-app' && github.event_name == 'workflow_dispatch' && inputs.medium_publication_regression }}",
    uses: "./.github/workflows/medium-video-publication.yml",
    permissions: { contents: "read" },
  });
});

const validateFocusedRunner = (workflow) => {
  assert.deepEqual(workflow.on, { workflow_call: null });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["medium-publication"]);
  const job = workflow.jobs["medium-publication"];
  const normal = readWorkflow("test.yml").jobs["server-medium-tests"];
  assert.equal(job.if, "${{ github.repository == 'Frameleaf/frameleaf-app' }}");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 90);
  assert.deepEqual(job.env, normal.env);
  assert.deepEqual(job.defaults, normal.defaults);
  assert.deepEqual(job.permissions, normal.permissions);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.steps.length, 7);
  assert.deepEqual(job.steps.slice(0, 5), normal.steps.slice(0, 5));
  const run = job.steps[5];
  const cleanup = job.steps[6];
  assert.equal(run.if, "${{ !cancelled() }}");
  assert.equal(run["working-directory"], ".");
  assert.equal(run["continue-on-error"], undefined);
  assert.deepEqual(run.env, normal.steps[5].env);
  const prefix = normal.steps[5].run.slice(
    0,
    normal.steps[5].run.indexOf('"$MEDIUM_IMAGE"'),
  );
  assert.ok(
    run.run.startsWith(prefix),
    "keep native CLI/socket/fixture mounts and Testcontainers setup",
  );
  const match = run.run
    .slice(prefix.length)
    .match(/^"\$MEDIUM_IMAGE" bash -ec '([^']*)'\n$/);
  assert.ok(match, "fixed failing bash command after the built native image");
  assert.equal(
    match[1],
    String.raw`docker version --format "{{.Client.Version}} {{.Server.Version}}"; node -e "console.log(require(\"/usr/local/lib/frameleaf/image-hdr.node\").capabilities())"; test -f test/medium/specs/repositories/video-publication.spec.ts; test -f test/medium/specs/repositories/retained-video-entry-publication.spec.ts; pnpm run test:medium --run test/medium/specs/repositories/video-publication.spec.ts test/medium/specs/repositories/retained-video-entry-publication.spec.ts`,
  );
  assert.deepEqual(cleanup, normal.steps[6]);
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /\$\{\{\s*inputs\.|passWithNoTests|RYUK_DISABLED|--privileged|--exclude|testNamePattern/,
  );
  return match[1];
};

test("focused reusable medium runner retains native setup, real globalSetup and failure cleanup", () => {
  validateFocusedRunner(readWorkflow("medium-video-publication.yml"));
  const config = read("server/test/vitest.config.medium.mjs");
  assert.match(config, /globalSetup: \['test\/medium\/globalSetup.ts'\]/);
  assert.match(
    read("server/test/medium/globalSetup.ts"),
    /GenericContainer.fromDockerfile\(postgresImageContext\)/,
  );
  assert.match(
    read("server/test/medium/globalSetup.ts"),
    /await databaseRepository.runMigrations\(\)/,
  );
});

test("focused medium contract rejects selector, ABI, setup, cleanup and input bypasses", () => {
  const original = readWorkflow("medium-video-publication.yml");
  for (const mutate of [
    (w) => {
      w.jobs["medium-publication"].steps[5].run = w.jobs[
        "medium-publication"
      ].steps[5].run.replace(
        " test/medium/specs/repositories/video-publication.spec.ts",
        "",
      );
    },
    (w) => {
      w.jobs["medium-publication"].steps[5].run = w.jobs[
        "medium-publication"
      ].steps[5].run.replace(/node -e .*?; pnpm/, "pnpm");
    },
    (w) => {
      w.jobs["medium-publication"].steps[5].run = w.jobs[
        "medium-publication"
      ].steps[5].run.replace(
        "pnpm run test:medium",
        "pnpm exec vitest --config fake.mjs",
      );
    },
    (w) => {
      w.jobs["medium-publication"].steps.pop();
    },
    (w) => {
      w.on.workflow_call = { inputs: { command: { type: "string" } } };
    },
    (w) => {
      w.jobs["medium-publication"].steps[5]["continue-on-error"] = true;
    },
  ]) {
    const faulty = structuredClone(original);
    mutate(faulty);
    assert.throws(() => validateFocusedRunner(faulty), assert.AssertionError);
  }
});

// Run only the literal inner shell with inert command executables. This checks
// the workflow's fail-fast shell boundary, not Docker, native ABI or SQL behavior.
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
  await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { spawnSync } = await import("node:child_process");
for (const failedCommand of ["docker", "node", "pnpm"]) {
  test(`focused command propagates ${failedCommand} prerequisite/test failure`, () => {
    const command = validateFocusedRunner(
      readWorkflow("medium-video-publication.yml"),
    );
    const directory = mkdtempSync(join(tmpdir(), "frameleaf-medium-contract-"));
    try {
      const fixtures = join(directory, "test/medium/specs/repositories");
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(join(fixtures, "video-publication.spec.ts"), "");
      writeFileSync(
        join(fixtures, "retained-video-entry-publication.spec.ts"),
        "",
      );
      for (const name of ["docker", "node", "pnpm"])
        writeFileSync(
          join(directory, name),
          `#!/bin/sh\nexit ${name === failedCommand ? 17 : 0}\n`,
          { mode: 0o755 },
        );
      const result = spawnSync("/bin/bash", ["-ec", command], {
        encoding: "utf8",
        cwd: directory,
        env: { PATH: directory },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 17, result.stderr);
      if (failedCommand !== "pnpm") {
        // A lost -e would silently turn an earlier native prerequisite failure
        // into a green run when the final test command succeeds.
        const bypass = spawnSync("/bin/bash", ["-c", command], {
          encoding: "utf8",
          cwd: directory,
          env: { PATH: directory },
        });
        assert.equal(bypass.status, 0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("focused command refuses an absent new regression instead of passing only existing controls", () => {
  const command = validateFocusedRunner(
    readWorkflow("medium-video-publication.yml"),
  );
  const directory = mkdtempSync(
    join(tmpdir(), "frameleaf-medium-missing-contract-"),
  );
  try {
    const fixtures = join(directory, "test/medium/specs/repositories");
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(join(fixtures, "video-publication.spec.ts"), "");
    for (const name of ["docker", "node", "pnpm"])
      writeFileSync(join(directory, name), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
    const result = spawnSync("/bin/bash", ["-ec", command], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: directory },
    });
    assert.equal(result.error, undefined);
    assert.notEqual(
      result.status,
      0,
      "missing regression file must fail before Vitest can select only the other file",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
