import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
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
const jobs = load(
  readFileSync(path.join(root, ".github/workflows/test.yml"), "utf8"),
).jobs;
const job = jobs["server-medium-scale-tests"];
const run = job.steps.find(
  (step) => step.name === "Run the medium scale suite in the native runner",
);
const capture = job.steps.find(
  (step) => step.name === "Capture medium scale diagnostics",
);
const upload = job.steps.find(
  (step) => step.with?.name === "medium-scale-diagnostics",
);
const cleanup = job.steps.find(
  (step) => step.name === "Remove medium runner after failure or cancellation",
);

test("scale diagnostics retain the runner and always capture/upload before forced cleanup", () => {
  assert.doesNotMatch(run.run, /docker run --rm/);
  assert.equal(job["timeout-minutes"], 90);
  assert.equal(run.env.FRAMELEAF_MEDIUM_SUITE, "scale");
  assert.equal(run.env.FRAMELEAF_MEDIUM_DIAGNOSTICS, "1");
  assert.match(run.run, /--env FRAMELEAF_MEDIUM_DIAGNOSTICS/);
  assert.match(run.run, /"\$MEDIUM_IMAGE" \|\| medium_exit_status=\$\?/);
  assert.match(run.run, /exit "\$medium_exit_status"/);
  assert.equal(run["continue-on-error"], undefined);
  for (const step of [capture, upload, cleanup])
    assert.equal(step.if, "always()");
  assert.ok(job.steps.indexOf(run) < job.steps.indexOf(capture));
  assert.ok(job.steps.indexOf(capture) < job.steps.indexOf(upload));
  assert.ok(job.steps.indexOf(upload) < job.steps.indexOf(cleanup));
  assert.match(cleanup.run, /docker rm -f/);
  assert.deepEqual(upload.with.path.trim().split("\n"), [
    "${{ runner.temp }}/frameleaf-medium-scale-reports/container-state.json",
    "${{ runner.temp }}/frameleaf-medium-scale-reports/vitest.xml",
  ]);
  assert.equal(upload.with["retention-days"], 3);
  assert.equal(
    jobs["server-medium-tests"].steps.some(
      (step) => step.env?.FRAMELEAF_MEDIUM_DIAGNOSTICS,
    ),
    false,
  );
  const fields = [...capture.run.matchAll(/\.State\.(\w+)/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    fields,
    [
      "Error",
      "ExitCode",
      "FinishedAt",
      "OOMKilled",
      "Running",
      "StartedAt",
      "Status",
    ].sort(),
  );
  assert.doesNotMatch(
    capture.run,
    /docker (?:logs|exec)|\.Config|\.Env|\.Labels/,
  );
});

test("runner status survives diagnostics and missing, active or oversized reports are explicit", () => {
  assert.ok(capture, "capture step must exist");
  const directory = mkdtempSync(path.join(tmpdir(), "medium-diagnostics-"));
  const bin = path.join(directory, "bin");
  const reports = path.join(directory, "frameleaf-medium-scale-reports");
  mkdirSync(bin);
  mkdirSync(reports);
  const calls = path.join(directory, "calls");
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/bash
echo "$1" >> "$CALLS"
case "$1" in
  run) exit "$TEST_EXIT" ;;
  inspect) [ "$#" = 4 ] && [ "$2" = --format ] && [ "$4" = owned-scale ] || exit 98
    [ "$NO_CONTAINER" != 1 ] || exit 1; printf '%s\\n' "$FAKE_STATE" ;;
  rm) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "readlink"),
    '#!/bin/bash\nprintf "%s\\n" "$2"\n',
    { mode: 0o755 },
  );
  const state = {
    ExitCode: 137,
    OOMKilled: false,
    Error: "",
    StartedAt: "start",
    FinishedAt: "",
    Status: "running",
    Running: true,
  };
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: directory,
    GITHUB_WORKSPACE: directory,
    MEDIUM_CONTAINER: "owned-scale",
    MEDIUM_IMAGE: "owned-image",
    CALLS: calls,
    FAKE_STATE: JSON.stringify(state),
    NO_CONTAINER: "0",
  };
  const execute = (script, extra = {}) =>
    spawnSync("bash", ["-e", "-c", script], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  try {
    for (const status of [0, 1, 75, 137]) {
      // Stub only the socket preflight; no Docker daemon or platform process is involved.
      const result = execute(
        'test() { if [[ "$1" == -S ]]; then return 0; else builtin test "$@"; fi; }\n' +
          run.run,
        { TEST_EXIT: String(status) },
      );
      assert.equal(result.status, status, result.stderr);
      assert.equal(execute(capture.run).status, 0);
      const captured = JSON.parse(
        readFileSync(path.join(reports, "container-state.json"), "utf8"),
      );
      assert.deepEqual(captured.container, state);
      assert.deepEqual(captured.testReport, { status: "missing" });
      assert.equal(execute(cleanup.run).status, 0);
    }
    // Cancellation can leave the container running: do not manufacture a completed test result.
    assert.equal(execute(capture.run, { NO_CONTAINER: "1" }).status, 0);
    assert.deepEqual(
      JSON.parse(
        readFileSync(path.join(reports, "container-state.json"), "utf8"),
      ).container,
      { status: "unavailable" },
    );
    writeFileSync(path.join(reports, "vitest.xml"), "<testsuites/>");
    assert.equal(execute(capture.run).status, 0);
    assert.deepEqual(
      JSON.parse(
        readFileSync(path.join(reports, "container-state.json"), "utf8"),
      ).testReport,
      { status: "present", bytes: 13 },
    );
    truncateSync(path.join(reports, "vitest.xml"), 8 * 1024 * 1024 + 1);
    assert.equal(execute(capture.run).status, 0);
    assert.deepEqual(
      JSON.parse(
        readFileSync(path.join(reports, "container-state.json"), "utf8"),
      ).testReport,
      { status: "oversize", bytes: 8 * 1024 * 1024 + 1 },
    );
    assert.equal(existsSync(path.join(reports, "vitest.xml")), false);
    assert.match(readFileSync(calls, "utf8"), /run\ninspect\nrm/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("medium reporter is opt-in for scale only and retains the console reporter", () => {
  const source = readFileSync(
    path.join(root, "server/test/vitest.config.medium.mjs"),
    "utf8",
  )
    .replace(/^import .*;\n/gm, "")
    .replace(/const serverRoot = .*;/, "const serverRoot = '/server';")
    .replace("export default defineConfig(", "result = defineConfig(");
  const config = (env) => {
    const context = {
      process: { env },
      defineConfig: (value) => value,
      mediumSuite: () => ({ include: ["unchanged-suite"], exclude: [] }),
      configDefaults: { exclude: [] },
      swc: { vite: () => ({}) },
      result: undefined,
    };
    runInNewContext(source, context);
    return JSON.parse(JSON.stringify(context.result.test));
  };
  const baseline = config({});
  assert.equal(baseline.reporters, undefined);
  assert.deepEqual(
    config({
      FRAMELEAF_MEDIUM_SUITE: "core",
      FRAMELEAF_MEDIUM_DIAGNOSTICS: "1",
    }),
    baseline,
  );
  assert.deepEqual(config({ FRAMELEAF_MEDIUM_SUITE: "scale" }), baseline);
  const enabled = config({
    FRAMELEAF_MEDIUM_SUITE: "scale",
    FRAMELEAF_MEDIUM_DIAGNOSTICS: "1",
  });
  assert.deepEqual(enabled.reporters, [
    "default",
    [
      "junit",
      {
        outputFile: "/tmp/frameleaf-medium-scale-reports/vitest.xml",
        includeConsoleOutput: false,
      },
    ],
  ]);
  delete enabled.reporters;
  assert.deepEqual(enabled, baseline);
});
