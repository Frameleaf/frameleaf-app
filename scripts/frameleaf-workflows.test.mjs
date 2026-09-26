import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
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
  "fork-release.yml",
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
  "Lint Web": ["test.yml", "web-lint", /pnpm lint/],
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
  }
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
  ]) {
    assert.ok(scripts.findIndex((step) => step.run === command) > install);
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
    "docker compose logs --no-color > docker-compose-logs.txt",
  );
  const artifact = steps.find((step) => step.name === "Archive Docker logs");
  assert.equal(artifact.if, "always()");
  assert.deepEqual(artifact.with.path.trim().split("\n"), [
    "e2e/docker-compose-logs.txt",
    "e2e/docker-diagnostics-after-api-tests.txt",
  ]);
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
});

test("locked Java and media tools include artifact URLs and checksums for hosted platforms", () => {
  const lockfile = readFileSync(path.join(root, "mise.lock"), "utf8");
  for (const tool of ["java", '"github:jellyfin/jellyfin-ffmpeg"']) {
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
  assert.equal(
    admission(publish.if, "Frameleaf/frameleaf-app", "", "release", {
      vars: { FRAMELEAF_ENABLE_CLI_PUBLISH: "true" },
    }),
    true,
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
