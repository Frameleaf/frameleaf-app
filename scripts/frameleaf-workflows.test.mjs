import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { load } = createRequire(path.join(root, "server/package.json"))(
  "js-yaml",
);
const workflow = (name) =>
  load(readFileSync(path.join(root, ".github/workflows", name), "utf8"));
const excluded = new Set([
  "docker.yml",
  "local-multi-runner-build.yml",
  "deploy-production.yml",
  "fork-roundtrip.yml",
  "fork-integration.yml",
  "nsfw-unraid-docker.yml",
]);
const owned = readdirSync(path.join(root, ".github/workflows")).filter(
  (name) =>
    /\.ya?ml$/.test(name) &&
    !excluded.has(name) &&
    name !== "jira-issue-key.yml",
);
const required = {
  "Test & Lint Server": ["test.yml", "server-unit-tests", /ci-unit/],
  "Test Web": ["test.yml", "web-unit-tests", /ci-unit/],
  "Lint Web": [
    "test.yml",
    "web-lint",
    /^pnpm exec eslint \. --max-warnings 0 --concurrency 2$/m,
  ],
  "Medium Tests (Server)": ["test.yml", "server-medium-tests", /ci-medium/],
  "Unit Test CLI": ["test.yml", "cli-unit-tests", /ci-unit/],
  "SQL Schema Checks": ["test.yml", "sql-schema-up-to-date", /migrations:run/],
  ShellCheck: ["test.yml", "shellcheck", /ludeeus\/action-shellcheck@/],
  "Docs Build": ["docs-build.yml", "build", /pnpm build/],
  "OpenAPI Clients": ["test.yml", "generated-api-up-to-date", /open-api/],
};
const admission = (
  expression,
  repository,
  headRepo = "external/contributor",
  event = "pull_request",
  extra = {},
) =>
  runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
    github: {
      repository,
      event_name: event,
      event: {
        pull_request: { head: { repo: { full_name: headRepo } } },
        created: false,
      },
      ...extra.github,
    },
    vars: extra.vars ?? {},
    inputs: extra.inputs ?? {},
    always: () => true,
  });

const assertPrimaryWebLint = (job) => {
  const lint = job.steps.find((step) => step.name === "Run linter");
  assert.ok(lint, "Lint Web requires its primary linter step");
  assert.equal(
    lint.run,
    "pnpm exec eslint . --max-warnings 0 --concurrency 2",
  );
  assert.equal(lint.if, "${{ !cancelled() }}");
  assert.equal(lint["continue-on-error"], undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(
    lint["working-directory"] ?? job.defaults?.run?.["working-directory"],
    "./web",
  );
};

test("all nine protected check contexts execute real commands on external fork/main PRs", () => {
  for (const [name, [file, id, command]] of Object.entries(required)) {
    const w = workflow(file);
    const j = w.jobs[id];
    assert.equal(j.name, name);
    assert.ok(w.on.pull_request.branches.includes("fork/main"));
    assert.equal(
      w.on.pull_request.paths,
      undefined,
      `${name} must not remain pending due to path filters`,
    );
    assert.equal(
      j.needs,
      undefined,
      `${name} must not depend on an upstream pre-job`,
    );
    assert.equal(admission(j.if, "Frameleaf/frameleaf-app"), true);
    assert.equal(admission(j.if, "immich-app/immich"), false);
    assert.deepEqual(j.permissions, { contents: "read" });
    assert.match(j.steps.map((s) => s.run ?? s.uses ?? "").join("\n"), command);
    assert.equal(
      j.steps.some((s) => s["continue-on-error"]),
      false,
    );
    if (id === "web-lint") assertPrimaryWebLint(j);
  }
});

test("the primary web lint gate cannot be replaced by diagnostics or weakened", () => {
  const job = workflow("test.yml").jobs["web-lint"];
  const command = "pnpm exec eslint . --max-warnings 0 --concurrency 2";
  for (const change of [
    { run: `${command} || true` },
    { run: command.replace("--max-warnings 0", "--max-warnings 1") },
    { run: command.replace("--concurrency 2", "--concurrency auto") },
    { run: command.replace("eslint .", "eslint src") },
    { if: "failure()" },
    { if: "false" },
    { "continue-on-error": true },
    { "working-directory": "./server" },
  ]) {
    const changed = structuredClone(job);
    Object.assign(
      changed.steps.find((step) => step.name === "Run linter"),
      change,
    );
    assert.throws(() => assertPrimaryWebLint(changed));
  }
  const diagnosticsOnly = structuredClone(job);
  diagnosticsOnly.steps = diagnosticsOnly.steps.filter(
    (step) => step.name !== "Run linter",
  );
  assert.throws(() => assertPrimaryWebLint(diagnosticsOnly));
  assert.throws(() =>
    assertPrimaryWebLint({ ...job, "continue-on-error": true }),
  );
});

test("standalone script tests install their locked JavaScript dependencies first", () => {
  const scripts = workflow("test.yml").jobs["script-unit-tests"].steps;
  const install = scripts.findIndex(
    (step) =>
      step.run ===
      "pnpm --filter @immich/scripts --filter immich install --frozen-lockfile",
  );
  assert.ok(install >= 0);
  for (const command of [
    "pnpm --filter @immich/scripts test",
    "node --test scripts/frameleaf-workflows.test.mjs",
    "node --test scripts/frameleaf-branding.test.mjs",
    "node --test scripts/frameleaf-legacy-names.test.mjs",
  ]) {
    assert.ok(scripts.findIndex((step) => step.run === command) > install);
  }
});

test("roundtrip certification runs for cutover, handoff and migration service changes", () => {
  const paths = workflow("fork-roundtrip.yml").on.pull_request.paths;
  for (const file of [
    "server/src/services/database.service.ts",
    "server/src/services/fork-handoff.service.ts",
    "server/src/services/fork-schema-cutover.service.ts",
    "server/src/services/fork-schema-migration.service.ts",
  ]) {
    assert.ok(
      paths.some((pattern) => path.matchesGlob(file, pattern)),
      `${file} must trigger the official-container roundtrip proof`,
    );
    const spec = file.replace(/\.ts$/, ".spec.ts");
    assert.equal(
      paths.some((pattern) => path.matchesGlob(spec, pattern)),
      false,
      `${spec} must not trigger container lanes for a test-only change`,
    );
  }
});

test("server E2E diagnostics preserve the failure state before maintenance", () => {
  const steps = workflow("test.yml").jobs["e2e-tests-server-cli"].steps;
  const api = steps.findIndex(
    (step) => step.name === "Run e2e tests (api & cli)",
  );
  const capture = steps[api + 1];
  assert.equal(capture.name, "Capture server diagnostics after API tests");
  assert.equal(capture.if, "always()");
  assert.equal(capture["working-directory"], "./e2e");
  assert.equal(steps[api + 2].name, "Run e2e tests (maintenance)");
  assert.match(capture.run, /docker compose ps --all --quiet/u);
  assert.ok(
    capture.run.includes(
      "docker inspect --format '{{json .Name}} {{json .State}} {{json .RestartCount}}'",
    ),
  );
  assert.match(capture.run, /docker compose logs --no-color --timestamps/u);
  assert.match(capture.run, /> docker-diagnostics-after-api-tests\.txt 2>&1/u);
  assert.doesNotMatch(
    capture.run,
    /docker stats|dmesg|free -h|df -h|\.Config|\.Env/u,
  );
  assert.equal(
    steps.find((step) => step.name === "Capture Docker logs").run,
    // FL-201: the logs include the fake Frameleaf Cloud service the consent specs run against.
    "docker compose -f docker-compose.yml -f docker-compose.frameleaf-cloud-fixture.yml logs --no-color > docker-compose-logs.txt",
  );
  const artifact = steps.find((step) => step.name === "Archive Docker logs");
  assert.equal(artifact.if, "always()");
  assert.deepEqual(artifact.with.path.trim().split("\n"), [
    "e2e/docker-compose-logs.txt",
    "e2e/docker-diagnostics-after-api-tests.txt",
    "e2e/docker-diagnostics-after-maintenance-tests.txt",
    "e2e/docker-upload-transport-logs.txt",
    "e2e/docker-buddy-diagnostics.txt",
    "e2e/buddy-evidence.json",
    "e2e/docker-cloud-accounting-logs.txt",
  ]);
});

test("Buddy acceptance runs only on x64 and refuses unsuccessful fixture prerequisites", () => {
  const job = workflow("test.yml").jobs["e2e-tests-server-cli"];
  const prepare = job.steps.find((step) => step.id === "buddy-prepare");
  const start = job.steps.find((step) => step.id === "buddy-fixture");
  const acceptance = job.steps.find((step) => step.id === "buddy-test");
  for (const step of [prepare, start, acceptance]) {
    assert.ok(step);
    assert.equal(step["continue-on-error"], undefined);
    // A failed earlier step must still enter the fail-closed prerequisite check.
    for (const runner of ["ubuntu-24.04", "ubuntu-24.04-arm"]) {
      for (const cancelled of [false, true]) {
        const admitted = runInNewContext(
          step.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""),
          { matrix: { runner }, cancelled: () => cancelled },
        );
        assert.equal(admitted, runner === "ubuntu-24.04" && !cancelled);
      }
    }
  }
  assert.equal(prepare.run, "bash buddy-fixture-tls.sh");
  assert.equal(start.env.BUDDY_PREPARE_OUTCOME, "${{ steps.buddy-prepare.outcome }}");
  assert.equal(acceptance.env.BUDDY_FIXTURE_OUTCOME, "${{ steps.buddy-fixture.outcome }}");
  assert.equal(acceptance.env.FRAMELEAF_BUDDY_BACKUP, "true");
  assert.equal(acceptance["working-directory"], "./server");
  assert.match(acceptance.run, /pnpm exec vitest run --config test\/vitest\.config\.buddy\.mjs/);
  assert.equal(job["continue-on-error"], undefined);
  for (const [step, key] of [
    [start, "BUDDY_PREPARE_OUTCOME"],
    [acceptance, "BUDDY_FIXTURE_OUTCOME"],
  ]) {
    for (const outcome of ["failure", "skipped", "cancelled", ""]) {
      const result = spawnSync("bash", ["-e", "-c", step.run], {
        encoding: "utf8",
        env: { ...process.env, [key]: outcome },
      });
      assert.equal(result.status, 1, `${step.id}:${outcome}`);
      assert.match(result.stdout, /::error::Two-server Buddy/);
      assert.equal(result.stderr, "", "must refuse before Docker or test execution");
    }
  }
});

test("Buddy cleanup is always admitted on x64 and refuses an unowned directory", () => {
  const steps = workflow("test.yml").jobs["e2e-tests-server-cli"].steps;
  const capture = steps.find((step) => step.name === "Capture redacted Buddy diagnostics");
  const cleanup = steps.find((step) => step.name === "Remove the owned Buddy fixture");
  for (const step of [capture, cleanup]) {
    assert.ok(step);
    assert.equal(step["continue-on-error"], undefined);
    for (const runner of ["ubuntu-24.04", "ubuntu-24.04-arm"]) {
      assert.equal(
        runInNewContext(step.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
          matrix: { runner }, always: () => true,
        }),
        runner === "ubuntu-24.04",
      );
    }
  }
  assert.match(cleanup.run, /test -f "\$BUDDY_ROOT\/\.fl310-buddy-fixture"/);
  assert.match(cleanup.run, /docker compose -f docker-compose\.buddy\.yml down --volumes --remove-orphans/);
  const dir = mkdtempSync(path.join(tmpdir(), "frameleaf-unowned-buddy-"));
  try {
    // Even a marker cannot authorize deleting a path outside the owned prefix.
    writeFileSync(path.join(dir, ".fl310-buddy-fixture"), "");
    const result = spawnSync("bash", ["-e", "-c", cleanup.run], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: tmpdir(), BUDDY_ROOT: dir },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "", "must refuse before Docker or deletion");
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Buddy artifacts retain sanitized state and evidence rather than raw logs or credentials", () => {
  const steps = workflow("test.yml").jobs["e2e-tests-server-cli"].steps;
  const capture = steps.find((step) => step.name === "Capture redacted Buddy diagnostics");
  assert.match(capture.run, /status=\{\{\.State\.Status\}\} exit=\{\{\.State\.ExitCode\}\} restarts=\{\{\.RestartCount\}\} image=\{\{\.Image\}\}/);
  assert.match(capture.run, /\{\{index \.Config\.Labels "com\.docker\.compose\.service"\}\}/);
  assert.doesNotMatch(capture.run, /docker (?:compose[^\n]* logs|logs|inspect(?! --format))|\.Config\.(?:Env|Cmd)|printenv|\benv\b|cat |tar /);
  assert.match(capture.run, /> docker-buddy-diagnostics\.txt 2>&1/);
  assert.match(capture.run, /cp "\$BUDDY_ROOT\/evidence\/buddy\.json" buddy-evidence\.json/);
  const paths = steps.find((step) => step.name === "Archive Docker logs").with.path.trim().split("\n");
  assert.deepEqual(paths.filter((entry) => entry.includes("buddy")), [
    "e2e/docker-buddy-diagnostics.txt",
    "e2e/buddy-evidence.json",
  ]);
});

test("API generation refuses artifacts recreated outside Git tracking", () => {
  const artifacts = [
    "open-api/immich-openapi-specs.json",
    "packages/sdk/src/fetch-client.ts",
  ];
  for (const [file, job, generation] of [
    ["test.yml", "generated-api-up-to-date", "Run API generation"],
    [
      "fork-integration.yml",
      "integration",
      "Verify OpenAPI and TypeScript client freshness",
    ],
  ]) {
    const steps = workflow(file).jobs[job].steps;
    const guard = steps.findIndex(
      (step) => step.name === "Verify generated API artifacts are tracked",
    );
    assert.ok(
      guard >= 0 && guard < steps.findIndex((step) => step.name === generation),
    );
    const dir = mkdtempSync(path.join(tmpdir(), "frameleaf-api-tracking-"));
    try {
      execFileSync("git", ["init", "--quiet", dir]);
      for (const artifact of artifacts) {
        mkdirSync(path.dirname(path.join(dir, artifact)), { recursive: true });
        writeFileSync(path.join(dir, artifact), "generated content\n");
      }
      execFileSync("git", ["add", "--", ...artifacts], { cwd: dir });
      assert.equal(
        spawnSync("bash", ["-e", "-c", steps[guard].run], { cwd: dir }).status,
        0,
      );
      for (const artifact of artifacts) {
        execFileSync("git", ["rm", "--cached", "--", artifact], { cwd: dir });
        // A regenerated untracked file is invisible to the existing freshness diff.
        assert.equal(
          spawnSync("git", ["diff", "--exit-code", "--", artifact], { cwd: dir })
            .status,
          0,
        );
        assert.notEqual(
          spawnSync("bash", ["-e", "-c", steps[guard].run], { cwd: dir }).status,
          0,
        );
        execFileSync("git", ["add", "--", artifact], { cwd: dir });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("retired mobile workflows and jobs remain absent", () => {
  for (const file of [
    "build-mobile.yml",
    "fdroid.yml",
    "static_analysis.yml",
  ]) {
    assert.equal(existsSync(path.join(root, ".github/workflows", file)), false);
  }
  assert.equal(workflow("test.yml").jobs["mobile-unit-tests"], undefined);
  assert.equal(workflow("fork-integration.yml").jobs["mobile"], undefined);
  const apiGeneration = workflow("test.yml").jobs[
    "generated-api-up-to-date"
  ].steps.find((step) => step.name === "Run API generation").run;
  assert.doesNotMatch(
    apiGeneration,
    /open-api-dart|generate-dart|\/\/:open-api(?:\s|$)/u,
  );
  assert.match(apiGeneration, /\/\/server:sync-open-api/u);
  assert.match(apiGeneration, /\/\/:open-api-typescript/u);
  const mise = readFileSync(path.join(root, "mise.toml"), "utf8");
  assert.doesNotMatch(mise, /open-api-dart|openapi-generator-cli|^java\s*=/mu);
  for (const retired of [
    "mobile",
    "fastlane",
    ".devcontainer/mobile",
    "open-api/openapitools.json",
    "open-api/templates",
    "open-api/bin/generate-dart-sdk.sh",
  ]) {
    assert.equal(existsSync(path.join(root, retired)), false, retired);
  }
});

test("locked media tools include artifact URLs and checksums for hosted platforms", () => {
  const lockfile = readFileSync(path.join(root, "mise.lock"), "utf8");
  for (const tool of ['"github:jellyfin/jellyfin-ffmpeg"']) {
    for (const platform of ["linux-x64", "linux-arm64", "windows-x64"]) {
      const section = `[tools.${tool}."platforms.${platform}"]`;
      assert.ok(
        lockfile.includes(section),
        `${tool} requires ${platform} lock metadata`,
      );
      const fields = lockfile.split(section)[1].split(/\n\[/)[0];
      assert.match(fields, /checksum = "sha256:[a-f0-9]{64}"/);
      assert.match(fields, /url = "https:\/\//);
    }
  }
});

test("owned workflows have no upstream service secrets, write-trigger PR execution, unpinned actions or retained checkout credentials", () => {
  for (const file of owned) {
    const w = workflow(file);
    assert.equal(w.on.pull_request_target, undefined, file);
    for (const [id, j] of Object.entries(w.jobs)) {
      assert.doesNotMatch(
        JSON.stringify(j),
        /PUSH_O_MATIC|WEBLATE_TOKEN|FDROID_REPO_TOKEN|CLOUDFLARE_API_TOKEN|APP_STORE_CONNECT|KEY_JKS/,
      );
      for (const step of j.steps ?? []) {
        if (step.uses && !step.uses.startsWith("./"))
          assert.match(step.uses, /@[a-f0-9]{40}$/, `${file}:${id}`);
        if (step.uses?.startsWith("actions/checkout@"))
          assert.equal(step.with["persist-credentials"], false);
      }
      if (id !== "publish" && id !== "publish-results")
        assert.ok(
          Object.values(j.permissions ?? {}).every((value) => value === "read"),
          file,
        );
    }
  }
});

test("legacy publishing and upstream mutations are inert and cannot inherit secrets", () => {
  const mise = readFileSync(path.join(root, "mise.toml"), "utf8");
  assert.doesNotMatch(mise, /^\[tasks\.release\]$/mu);
  const disabled = [
    "sdk.yml",
    "docs-deploy.yml",
    "docs-destroy.yml",
    "weblate-lock.yml",
    "merge-translations.yml",
    "prepare-release.yml",
    "draft-release.yml",
    "backport.yml",
    "auto-close.yml",
    "close-duplicates.yml",
    "fix-format.yml",
    "cache-cleanup.yml",
    "pr-labeler.yml",
    "pr-label-validation.yml",
    "preview-label.yaml",
    "org-pr-require-conventional-commit.yml",
  ];
  for (const file of disabled) {
    const w = workflow(file);
    assert.deepEqual(Object.keys(w.on), ["workflow_dispatch"]);
    assert.deepEqual(w.permissions, {});
    assert.deepEqual(Object.keys(w.jobs), ["disabled"]);
    assert.equal(
      admission(w.jobs.disabled.if, "Frameleaf/frameleaf-app"),
      true,
    );
    assert.equal(admission(w.jobs.disabled.if, "immich-app/immich"), false);
    assert.deepEqual(w.jobs.disabled.permissions, {});
    assert.ok(
      w.jobs.disabled.steps.every(
        (step) => !step.uses && step.run.startsWith("printf '%s\\n' "),
      ),
    );
    assert.equal(JSON.stringify(w).includes("secrets."), false);
  }
});

test("OpenAPI compares immutable same-repository base commits, not the moving target branch", () => {
  const w = workflow("check-openapi.yml");
  assert.deepEqual(w.on.pull_request.branches, ["fork/main", "master/frameleaf-implementation"]);
  assert.ok(w.on.pull_request.types.includes("edited"));
  const steps = w.jobs["check-openapi"].steps;
  const baseline = steps.find((s) => s.name === "Checkout exact PR base");
  assert.equal(baseline.with.repository, "Frameleaf/frameleaf-app");
  assert.equal(
    baseline.with.ref,
    "${{ github.event.pull_request.base.sha || inputs.base_sha }}",
  );
  assert.equal(w.on.workflow_dispatch.inputs.base_sha.required, true);
  assert.equal(
    steps.find((s) => s.name === "Check for breaking API changes").with.base,
    ".frameleaf-api-base/open-api/immich-openapi-specs.json",
  );
  const guard = steps.find(
    (s) => s.name === "Validate immutable comparison commit",
  ).run;
  for (const [value, expected] of [
    ["a".repeat(40), 0],
    ["fork/main", 1],
    ["$(echo bad)", 1],
    ["", 1],
  ]) {
    assert.equal(
      spawnSync("bash", ["-e", "-c", guard], {
        env: { ...process.env, BASE_SHA: value },
      }).status,
      expected,
    );
  }
});

test("migration authority validation runs on Frameleaf and failures cannot be converted to success", () => {
  const j = workflow("migration-order.yml").jobs["migration-order"];
  assert.equal(admission(j.if, "Frameleaf/frameleaf-app"), true);
  const verify = j.steps.find(
    (s) => s.name === "Verify fork migration ORDER by authority",
  );
  assert.equal(verify.if, undefined);
  assert.match(verify.run, /check-fork-migration-order\.test\.mjs/);
  assert.match(verify.run, /migrations:verify-order/);
  assert.match(
    verify.run,
    /check-fork-migration-order\.mjs "\$BASELINE" "\$ORDER"/,
  );
  const sql = workflow("test.yml").jobs["sql-schema-up-to-date"];
  const generate = sql.steps.find((s) => s.name === "Generate new migrations");
  assert.equal(
    generate.run,
    "pnpm --filter immich migrations:generate src/schema/migrations/TestMigration",
  );
  assert.equal(generate["continue-on-error"], undefined);
});

test("CLI has one opt-in GHCR publisher and read-only no-push PR builds", () => {
  const w = workflow("cli.yml");
  const publish = w.jobs.publish;
  assert.equal(admission(publish.if, "Frameleaf/frameleaf-app"), false);
  assert.equal(
    admission(publish.if, "Frameleaf/frameleaf-app", "", "release"),
    false,
  );
  // FL-191: releases are created with the workflow token and never trigger this workflow, so
  // publication is only the gated manual dispatch; promotion checks that the image exists.
  assert.equal(w.on.release, undefined);
  assert.equal(
    admission(publish.if, "Frameleaf/frameleaf-app", "", "release", {
      vars: { FRAMELEAF_ENABLE_CLI_PUBLISH: "true" },
    }),
    false,
  );
  assert.equal(
    admission(publish.if, "immich-app/immich", "", "release", {
      vars: { FRAMELEAF_ENABLE_CLI_PUBLISH: "true" },
    }),
    false,
  );
  assert.equal(admission(w.jobs.build.if, "Frameleaf/frameleaf-app"), true);
  assert.equal(
    admission(publish.if, "Frameleaf/frameleaf-app", "", "workflow_dispatch", {
      vars: { FRAMELEAF_ENABLE_CLI_PUBLISH: "true" },
      inputs: { publish: true },
      github: {
        repository: "Frameleaf/frameleaf-app",
        event_name: "workflow_dispatch",
        ref: "refs/heads/fork/main",
      },
    }),
    true,
  );
  assert.equal(
    admission(publish.if, "Frameleaf/frameleaf-app", "", "workflow_dispatch", {
      vars: { FRAMELEAF_ENABLE_CLI_PUBLISH: "true" },
      inputs: { publish: true },
      github: {
        repository: "Frameleaf/frameleaf-app",
        event_name: "workflow_dispatch",
        ref: "refs/heads/other",
      },
    }),
    false,
  );
  assert.equal(w.on.workflow_dispatch.inputs.publish.default, false);
  assert.deepEqual(w.jobs.build.permissions, { contents: "read" });
  assert.equal(
    w.jobs.build.steps.find((s) => s.name === "Build without publishing").with
      .push,
    false,
  );
  assert.equal(
    publish.steps.find((s) => s.name === "Container tags").with.images,
    "ghcr.io/frameleaf/frameleaf-cli",
  );
  assert.doesNotMatch(
    JSON.stringify(w),
    /npm publish|ci-publish|docker\.io|immich-cli/,
  );
  const guardIndex = publish.steps.findIndex(
    (s) => s.name === "Verify release commit is the current delivery branch",
  );
  assert.ok(
    guardIndex <
      publish.steps.findIndex(
        (s) => s.name === "Login to owned GHCR namespace",
      ),
  );
  assert.ok(
    guardIndex < publish.steps.findIndex((s) => s.name === "Set up QEMU"),
  );
});

test("CLI release guard rejects a stale tag, wrong checkout or non-SHA input before any publish", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "frameleaf-cli-guard-"));
  const guard = workflow("cli.yml").jobs.publish.steps.find(
    (s) => s.name === "Verify release commit is the current delivery branch",
  ).run;
  writeFileSync(
    path.join(dir, "git"),
    '#!/bin/sh\ncase "$*" in\n"fetch --no-tags origin refs/heads/fork/main") exit 0;;\n"rev-parse FETCH_HEAD") printf "%s\\n" "$TEST_BRANCH_SHA";;\n"rev-parse HEAD") printf "%s\\n" "$TEST_HEAD_SHA";;\n*) exit 9;;\nesac\n',
    { mode: 0o755 },
  );
  try {
    const sha = "a".repeat(40);
    const other = "b".repeat(40);
    for (const [candidate, branch, head, expected] of [
      [sha, sha, sha, 0],
      [sha, other, sha, 1],
      [sha, sha, other, 1],
      ["fork/main", sha, sha, 1],
    ]) {
      const r = spawnSync("bash", ["-e", "-c", guard], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          CANDIDATE_SHA: candidate,
          TEST_BRANCH_SHA: branch,
          TEST_HEAD_SHA: head,
        },
      });
      assert.equal(r.status, expected, r.stderr?.toString());
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Zizmor is a pinned failing scanner rather than a skipped success, and CodeQL needs no PR write permission", () => {
  const j = workflow("org-zizmor.yml").jobs.zizmor;
  assert.equal(admission(j.if, "Frameleaf/frameleaf-app"), true);
  assert.deepEqual(j.permissions, { contents: "read" });
  const step = j.steps.find((s) => s.name === "Audit workflow security");
  assert.match(step.run, /zizmor==1\.30\.1 --offline --format=github/);
  assert.match(step.run, /\.github\/workflows$/);
  assert.equal(step["continue-on-error"], undefined);
  assert.doesNotMatch(step.run, /\|\| true|--no-exit-codes|--format=sarif/);
  const codeql = workflow("codeql-analysis.yml").jobs.analyze;
  assert.deepEqual(codeql.permissions, { contents: "read" });
  assert.equal(
    codeql.steps.find((s) =>
      s.uses?.startsWith("github/codeql-action/analyze@"),
    ).with.upload,
    false,
  );
  const upload = workflow("codeql-analysis.yml").jobs["publish-results"];
  assert.equal(admission(upload.if, "Frameleaf/frameleaf-app"), false);
  assert.equal(
    admission(upload.if, "Frameleaf/frameleaf-app", "", "push", {
      github: {
        repository: "Frameleaf/frameleaf-app",
        event_name: "push",
        ref: "refs/heads/fork/main",
      },
    }),
    true,
  );
  assert.ok(
    upload.steps.every(
      (step) => !step.run && !step.uses.startsWith("actions/checkout@"),
    ),
  );
  assert.deepEqual(upload.needs, ["analyze"]);
});

test("all inline bash steps remain syntactically valid", () => {
  for (const file of owned) {
    for (const [id, j] of Object.entries(workflow(file).jobs)) {
      if (j["runs-on"] === "windows-latest") continue;
      for (const s of j.steps ?? []) {
        if (!s.run || (s.shell && s.shell !== "bash")) continue;
        const script = s.run.replace(/\$\{\{[\s\S]*?\}\}/g, "EXPRESSION");
        try {
          execFileSync("bash", ["-n"], {
            input: script,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (e) {
          assert.fail(`${file}:${id}:${s.name}: ${e.stderr}`);
        }
      }
    }
  }
});

test("integration image is a guarded manual pre-release that never writes release-pipeline tags", () => {
  const w = workflow("integration-image.yml");
  // A workflow off the default branch cannot be dispatched: pushes to the integration branch build it.
  assert.deepEqual(Object.keys(w.on), ["push", "workflow_dispatch"]);
  assert.deepEqual(w.on.push, {
    branches: ["master/frameleaf-implementation"],
  });
  assert.equal(w.on.workflow_dispatch, null);
  assert.deepEqual(w.concurrency, {
    group: "integration-image",
    // A running build finishes; GitHub keeps only the newest queued run in the group.
    "cancel-in-progress": false,
  });
  assert.deepEqual(w.permissions, {});
  assert.equal(w.env.IMAGE, "ghcr.io/frameleaf/frameleaf-server");
  assert.equal(w.env.DATABASE_IMAGE, "ghcr.io/frameleaf/frameleaf-postgres");
  assert.deepEqual(Object.keys(w.jobs), [
    "guard",
    "build",
    "deploy-test",
    "publish",
  ]);
  assert.deepEqual(w.jobs.guard.permissions, {});
  // FL-142: nothing is pushed before the deployment test; only publish can write packages.
  for (const [id, packages] of [
    ["build", "read"],
    ["deploy-test", "read"],
    ["publish", "write"],
  ]) {
    const j = w.jobs[id];
    assert.deepEqual(j.permissions, { contents: "read", packages });
    const dispatch = (repository, ref, event = "workflow_dispatch") =>
      admission(j.if, repository, "", event, {
        github: { repository, event_name: event, ref },
      });
    const branch = "refs/heads/master/frameleaf-implementation";
    assert.equal(dispatch("Frameleaf/frameleaf-app", branch), true, id);
    assert.equal(dispatch("Frameleaf/frameleaf-app", branch, "push"), true, id);
    for (const [repository, ref, event] of [
      ["Frameleaf/frameleaf-app", "refs/heads/fork/main"],
      ["Frameleaf/frameleaf-app", "refs/heads/fork/main", "push"],
      ["Frameleaf/frameleaf-app", "refs/heads/feature"],
      ["Frameleaf/frameleaf-app", "refs/tags/frameleaf-v1"],
      ["someone/frameleaf-app", branch],
      ["someone/frameleaf-app", branch, "push"],
      ["Frameleaf/frameleaf-app", branch, "pull_request"],
      ["Frameleaf/frameleaf-app", branch, "workflow_run"],
    ])
      assert.equal(dispatch(repository, ref, event), false, `${id} ${ref}`);
  }
  assert.deepEqual(w.jobs.build.needs, "guard");
  assert.deepEqual(w.jobs["deploy-test"].needs, "build");
  assert.deepEqual(w.jobs.publish.needs, "deploy-test");
  assert.equal(
    w.jobs["deploy-test"].steps.at(-1).run,
    "node .github/frameleaf-deploy-test.cjs",
  );
  assert.deepEqual(w.jobs["deploy-test"].strategy.matrix.runner, [
    "ubuntu-24.04",
    "ubuntu-24.04-arm",
  ]);
  const guard = w.jobs.guard.steps[0].run;
  const sha = "a".repeat(40);
  for (const [repository, ref, event, expected] of [
    [
      "Frameleaf/frameleaf-app",
      "refs/heads/master/frameleaf-implementation",
      "workflow_dispatch",
      0,
    ],
    ["Frameleaf/frameleaf-app", "refs/heads/fork/main", "workflow_dispatch", 1],
    [
      "attacker/frameleaf-app",
      "refs/heads/master/frameleaf-implementation",
      "workflow_dispatch",
      1,
    ],
    [
      "Frameleaf/frameleaf-app",
      "refs/heads/master/frameleaf-implementation",
      "push",
      0,
    ],
    ["Frameleaf/frameleaf-app", "refs/heads/fork/main", "push", 1],
    [
      "Frameleaf/frameleaf-app",
      "refs/heads/master/frameleaf-implementation",
      "pull_request",
      1,
    ],
  ])
    assert.equal(
      spawnSync("bash", ["-c", guard], {
        env: {
          ...process.env,
          REPOSITORY: repository,
          REF: ref,
          EVENT: event,
          SHA: sha,
        },
      }).status,
      expected,
      `${repository} ${ref} ${event}`,
    );

  // Same build as Deploy's server image: Dockerfile, target, device, native platforms.
  const deploy = workflow("docker.yml").jobs.server.with;
  const build = w.jobs.build.steps.find((s) => s.id === "build").with;
  assert.equal(build.file, deploy.dockerfile);
  assert.equal(build.context, deploy.context);
  assert.equal(build.target, deploy.target);
  assert.match(
    build["build-args"],
    new RegExp(`^DEVICE=${deploy.device}$`, "m"),
  );
  assert.deepEqual(
    w.jobs.build.strategy.matrix.include.map((row) => row.platform).join(","),
    deploy.platforms,
  );
  assert.match(build.outputs, /^type=oci,dest=/);
  assert.doesNotMatch(build.outputs, /push=true|type=image|type=registry/);
  const push = w.jobs.publish.steps.find((s) =>
    /oras cp --from-oci-layout/.test(s.run ?? ""),
  ).run;
  assert.match(push, /oras resolve/);
  assert.match(push, /^\s*push server "\$IMAGE" ""$/m);
  assert.match(push, /^\s*push database "\$DATABASE_IMAGE" \/postgres$/m);

  // The database image is built from docker/postgres on the same runners, tested by the same
  // deployment test (DATABASE_ARCHIVE), and only then pushed: the pushed digest is the tested one.
  const database = w.jobs.build.steps.find((s) => s.id === "database").with;
  assert.equal(database.context, "docker/postgres");
  assert.equal(database.file, "docker/postgres/Dockerfile");
  assert.equal(database.platforms, "${{ matrix.platform }}");
  assert.match(
    database.outputs,
    /^type=oci,dest=\$\{\{ runner\.temp \}\}\/archive\/postgres\/image\.tar,/,
  );
  assert.equal(database["cache-to"], undefined);
  assert.match(
    database.labels,
    /^org\.opencontainers\.image\.version=integration-\$\{\{ github\.sha \}\}$/m,
  );
  assert.match(
    database.labels,
    /^org\.opencontainers\.image\.description=Pre-release integration build, not a release$/m,
  );
  assert.equal(
    w.jobs["deploy-test"].steps.at(-1).env.DATABASE_ARCHIVE,
    "${{ runner.temp }}/server/postgres/image.tar",
  );
  assert.equal(
    build["cache-to"],
    undefined,
    "must not write the Deploy build cache",
  );
  assert.match(
    build.labels,
    /^org\.opencontainers\.image\.version=integration-\$\{\{ github\.sha \}\}$/m,
  );
  assert.match(
    build.labels,
    /^org\.opencontainers\.image\.description=Pre-release integration build, not a release$/m,
  );
  assert.match(
    build["build-args"],
    /^BUILD_IMAGE=integration-\$\{\{ github\.sha \}\}$/m,
  );

  const publish = w.jobs.publish.steps.find((s) => s.id === "manifest").run;
  const tags = [...publish.matchAll(/--tag "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tags, ["${IMAGE_REF}:${full}", "${IMAGE_REF}:${short}"]);
  assert.match(publish, /for name in server database; do/);
  assert.match(publish, /full="integration-\$\{SHA\}"/);
  assert.match(publish, /short="integration-\$\{SHA:0:12\}"/);
  assert.doesNotMatch(
    JSON.stringify(w),
    /:latest|:release|:edge|frameleaf-v|commit-\$|type=registry[^"]*mode=max/,
  );
});

test("only the integration image compiles the integration build channel (extra licence keys)", () => {
  // Owner decision 2026-09-27: an integration build may trust extra licence-signing keys from
  // FRAMELEAF_LICENSE_EXTRA_JWKS_FILE; a release build never does. The channel is a Docker build
  // argument compiled into the server, set by integration-image.yml and by nothing else.
  const channelSource = "server/src/utils/frameleaf-build-channel.ts";
  const releaseLine =
    "export const FRAMELEAF_BUILD_CHANNEL: FrameleafBuildChannel = 'release' as FrameleafBuildChannel;";
  const integrationLine =
    "export const FRAMELEAF_BUILD_CHANNEL: FrameleafBuildChannel = 'integration' as FrameleafBuildChannel;";
  const source = readFileSync(path.join(root, channelSource), "utf8");
  assert.equal(
    source
      .split("\n")
      .filter((line) => line.startsWith("export const FRAMELEAF_BUILD_CHANNEL"))
      .length,
    1,
  );
  assert.ok(
    source.split("\n").includes(releaseLine),
    "the source must say release",
  );

  // Every file that drives a build (.github, docker/, Dockerfiles, compose, mise, package scripts):
  // only integration-image.yml may name the argument, and it sets exactly integration.
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const buildFiles = tracked.filter(
    (file) =>
      file.startsWith(".github/") ||
      file.startsWith("docker/") ||
      /(^|\/)Dockerfile[^/]*$/.test(file) ||
      /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(file) ||
      /(^|\/)mise\.toml$/.test(file) ||
      /(^|\/)package\.json$/.test(file) ||
      /\.(sh|bake\.hcl)$/.test(file),
  );
  const naming = buildFiles.filter((file) =>
    readFileSync(path.join(root, file), "utf8").includes(
      "FRAMELEAF_BUILD_CHANNEL",
    ),
  );
  assert.deepEqual(naming.sort(), [
    ".github/workflows/integration-image.yml",
    "server/Dockerfile",
  ]);

  const build = workflow("integration-image.yml").jobs.build.steps.find(
    (s) => s.id === "build",
  ).with;
  const channelArgs = build["build-args"]
    .split("\n")
    .filter((line) => line.includes("FRAMELEAF_BUILD_CHANNEL"));
  assert.deepEqual(channelArgs, ["FRAMELEAF_BUILD_CHANNEL=integration"]);
  // Release builds (Deploy -> local-multi-runner-build, Deploy production) pass no channel.
  for (const name of [
    "docker.yml",
    "local-multi-runner-build.yml",
    "deploy-production.yml",
  ])
    assert.doesNotMatch(
      readFileSync(path.join(root, ".github/workflows", name), "utf8"),
      /FRAMELEAF_BUILD_CHANNEL/,
    );

  // The Dockerfile defaults to release and rewrites only that one line; run its step as written.
  const dockerfile = readFileSync(path.join(root, "server/Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG FRAMELEAF_BUILD_CHANNEL=release$/m);
  assert.equal(
    (dockerfile.match(/^ARG FRAMELEAF_BUILD_CHANNEL/gm) ?? []).length,
    1,
  );
  assert.doesNotMatch(
    dockerfile,
    /^ENV .*FRAMELEAF_BUILD_CHANNEL/m,
    "never a runtime environment variable",
  );
  const step = dockerfile
    .split(/^ARG FRAMELEAF_BUILD_CHANNEL=release\n/m)[1]
    .split(/\n(?=RUN |FROM |COPY |ARG |ENV )/)[0]
    .replace(/^RUN /, "")
    .replaceAll("\\\n", "\n");
  const dir = mkdtempSync(path.join(tmpdir(), "frameleaf-channel-"));
  try {
    const run = (channel) => {
      mkdirSync(path.join(dir, "server/src/utils"), { recursive: true });
      writeFileSync(path.join(dir, channelSource), source);
      const status = spawnSync("sh", ["-c", step], {
        cwd: dir,
        env: { ...process.env, FRAMELEAF_BUILD_CHANNEL: channel },
      }).status;
      return {
        status,
        lines: readFileSync(path.join(dir, channelSource), "utf8").split("\n"),
      };
    };
    const release = run("release");
    assert.equal(release.status, 0);
    assert.ok(release.lines.includes(releaseLine));
    const integration = run("integration");
    assert.equal(integration.status, 0);
    assert.ok(integration.lines.includes(integrationLine));
    assert.ok(!integration.lines.includes(releaseLine));
    for (const channel of ["", "Integration", "production", "integration "])
      assert.notEqual(
        run(channel).status,
        0,
        `channel ${JSON.stringify(channel)}`,
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
