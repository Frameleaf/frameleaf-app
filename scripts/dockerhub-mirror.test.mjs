import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { load } = createRequire(path.join(root, "server/package.json"))(
  "js-yaml",
);
const helper = path.join(root, "scripts/configure-dockerhub-mirror.sh");
const workflows = {
  "check-openapi.yml": ["check-openapi"],
  "fork-integration.yml": ["machine-learning-containers"],
  "frameleaf-studio-engine.yml": ["lifecycle-evidence"],
  "manager.yml": ["manager"],
  "test.yml": [
    "server-medium-tests",
    "e2e-tests-server-cli",
    "e2e-tests-web",
    "sql-schema-up-to-date",
  ],
};

test("all Docker consumers configure the public mirror before builds, bootstrap or Testcontainers", () => {
  for (const [file, jobs] of Object.entries(workflows)) {
    const workflow = load(
      readFileSync(path.join(root, ".github/workflows", file), "utf8"),
    );
    for (const job of jobs) {
      const steps = workflow.jobs[job].steps;
      const setup = steps.findIndex(
        (step) => step.run === "bash scripts/configure-dockerhub-mirror.sh",
      );
      assert.ok(
        setup >= 0,
        `${file}/${job}: missing public mirror configuration`,
      );
      assert.equal(steps[setup]["working-directory"], ".");
      assert.equal(
        steps[setup].if,
        undefined,
        "fork PR validation also uses the public mirror",
      );
      const consumer = steps.findIndex(
        (step) =>
          /docker\/(?:setup-buildx|build-push)-action@/.test(step.uses ?? "") ||
          /\bdocker\s+(?:build|run|compose)|pnpm test:medium/.test(
            step.run ?? "",
          ) ||
          (file === "check-openapi.yml" &&
            step.name === "Verify SDK operation compatibility policy"),
      );
      assert.ok(
        consumer > setup,
        `${file}/${job}: mirror setup must precede its first consumer`,
      );
      assert.ok(
        !steps.some((step) => /oasdiff\/oasdiff-action/.test(step.uses ?? "")),
        "Docker action initialization cannot wait for setup",
      );
      for (const step of steps.filter((step) =>
        /docker\/setup-buildx-action@/.test(step.uses ?? ""),
      )) {
        assert.match(
          step.with?.["buildkitd-config-inline"] ?? "",
          /\[registry\."docker.io"\][\s\S]*mirrors\s*=\s*\["mirror.gcr.io"\]/,
        );
      }
    }
  }
});

// Only sudo/systemctl/Docker are replaced. The helper's Python merge, real file writes,
// permissions and active-configuration check execute against an owned fixture.
const runHelper = (
  contents,
  { reportedMirrors, restartFailure = false } = {},
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "frameleaf-mirror-"));
  const config = path.join(directory, "daemon.json");
  if (contents !== undefined) {
    writeFileSync(config, contents);
    chmodSync(config, 0o600);
  }
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
const config = process.env.MIRROR_FIXTURE_CONFIG;
if (path.basename(process.argv[1]) === 'sudo') {
  if (args[0] === 'python3' && args[1] === '-' && args[2] === '/etc/docker/daemon.json') {
    const result = cp.spawnSync('python3', ['-', config], { input: fs.readFileSync(0), stdio: ['pipe', 'inherit', 'inherit'] });
    process.exit(result.status ?? 1);
  }
  if (JSON.stringify(args) !== JSON.stringify(['systemctl', 'restart', 'docker'])) process.exit(91);
  if (process.env.MIRROR_RESTART_FAILURE === 'true') process.exit(92);
  fs.copyFileSync(config, config + '.active');
} else {
  if (JSON.stringify(args) !== JSON.stringify(['info', '--format', '{{json .RegistryConfig.Mirrors}}'])) process.exit(93);
  const active = JSON.parse(fs.readFileSync(config + '.active', 'utf8'));
  console.log(process.env.MIRROR_REPORTED ?? JSON.stringify(active['registry-mirrors']));
}
`;
  for (const command of ["sudo", "docker"]) {
    const file = path.join(directory, command);
    writeFileSync(file, stub);
    chmodSync(file, 0o755);
  }
  try {
    const result = spawnSync("bash", [helper], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        MIRROR_FIXTURE_CONFIG: config,
        MIRROR_RESTART_FAILURE: String(restartFailure),
        ...(reportedMirrors === undefined
          ? {}
          : { MIRROR_REPORTED: reportedMirrors }),
      },
    });
    assert.ifError(result.error);
    const final = (() => {
      try {
        return readFileSync(config, "utf8");
      } catch {
        return undefined;
      }
    })();
    return {
      ...result,
      final,
      mode: final === undefined ? undefined : statSync(config).mode & 0o777,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("mirror merge preserves daemon keys and existing mirror order, and is idempotent", () => {
  const original =
    '{"log-driver":"local","registry-mirrors":["https://existing.example"],"features":{"containerd-snapshotter":true},"insecure-registries":["127.0.0.1:5000"]}';
  const first = runHelper(original);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.final), {
    "log-driver": "local",
    "registry-mirrors": ["https://existing.example", "https://mirror.gcr.io"],
    features: { "containerd-snapshotter": true },
    "insecure-registries": ["127.0.0.1:5000"],
  });
  assert.deepEqual(Object.keys(JSON.parse(first.final)), [
    "log-driver",
    "registry-mirrors",
    "features",
    "insecure-registries",
  ]);
  assert.equal(first.mode, 0o600);
  const second = runHelper(first.final);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.final, first.final);
});

test("absent and empty daemon configs safely acquire the public mirror", () => {
  for (const original of [
    undefined,
    "",
    " \n",
    "{}",
    '{"registry-mirrors":[]}',
  ]) {
    const result = runHelper(original);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.final), {
      "registry-mirrors": ["https://mirror.gcr.io"],
    });
  }
});

test("invalid daemon configs fail without overwriting their bytes", () => {
  for (const original of [
    "{broken",
    "[]",
    '{"registry-mirrors":null}',
    '{"registry-mirrors":"https://other.example"}',
    '{"registry-mirrors":[42]}',
  ]) {
    const result = runHelper(original);
    assert.notEqual(result.status, 0);
    assert.equal(result.final, original);
  }
});

test("daemon restart or missing active mirror cannot silently pass", () => {
  assert.notEqual(runHelper("{}", { restartFailure: true }).status, 0);
  assert.notEqual(runHelper("{}", { reportedMirrors: "[]" }).status, 0);
  assert.notEqual(runHelper("{}", { reportedMirrors: "not-json" }).status, 0);
  assert.equal(
    runHelper("{}", { reportedMirrors: '["https://mirror.gcr.io/"]' }).status,
    0,
  );
});
