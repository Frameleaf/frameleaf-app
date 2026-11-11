import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertArchiveIdentity,
  defaultPlanner,
  plannerVariant,
  qualify,
  workerEndpoint,
} from "./assistant-deploy-gate.mjs";

import cases from "../server/test/assistant-eval/cases.json" with { type: "json" };
import library from "../server/test/assistant-eval/library.json" with { type: "json" };

const planner = {
  name: "fixture",
  runtime: "transformers",
  default: true,
  files: { "textual/config.json": "a".repeat(64) },
};

test("only an empty manifest can bypass live qualification", () => {
  assert.equal(defaultPlanner([]), null);
  assert.equal(defaultPlanner([planner]), planner);
  for (const manifest of [
    {},
    [null],
    [{ ...planner, default: "true" }],
    [{ ...planner, default: false }],
    [planner, { ...planner, name: "second" }],
    [planner, { ...planner, default: false }],
  ]) {
    assert.throws(() => defaultPlanner(manifest));
  }
});

test("default planner must use a supported runtime and pinned files", () => {
  assert.equal(plannerVariant(defaultPlanner([planner]).runtime), "cpu");
  assert.equal(
    plannerVariant(
      defaultPlanner([{ ...planner, runtime: "openvino" }]).runtime,
    ),
    "openvino",
  );
  assert.throws(
    () => defaultPlanner([{ ...planner, runtime: "llama.cpp" }]),
    /Unsupported Assistant planner runtime/,
  );
  for (const files of [
    undefined,
    {},
    { "textual/config.json": "unpinned" },
    { "textual/../config.json": "a".repeat(64) },
  ]) {
    assert.throws(() => defaultPlanner([{ ...planner, files }]), /SHA-256/);
  }
});

test("qualification requires the exact candidate ML runtime image", () => {
  const source = "a".repeat(40);
  const labels = {
    "org.opencontainers.image.source":
      "https://github.com/Frameleaf/frameleaf-app",
    "org.opencontainers.image.revision": source,
    "org.frameleaf.build.variant": "cpu",
  };
  assert.doesNotThrow(() => assertArchiveIdentity(labels, source, "cpu"));
  assert.throws(
    () => assertArchiveIdentity(labels, source, "openvino"),
    /runtime variant/,
  );
  assert.doesNotThrow(() =>
    assertArchiveIdentity(
      { ...labels, "org.frameleaf.build.variant": "openvino-openvino" },
      source,
      "openvino",
    ),
  );
  for (const label of Object.keys(labels)) {
    assert.throws(() =>
      assertArchiveIdentity({ ...labels, [label]: "wrong" }, source, "cpu"),
    );
  }
});

test("qualification accepts only a single Docker IPv4 loopback port", () => {
  assert.equal(workerEndpoint("127.0.0.1:32768\n"), "http://127.0.0.1:32768");
  for (const address of [
    "0.0.0.0:3003",
    "localhost:3003",
    "127.0.0.1:65536",
    "127.0.0.1:3003\n[::]:3003",
  ]) {
    assert.throws(() => workerEndpoint(address), /loopback/);
  }
});

test("plan reads the exact candidate commit and fails for a different checkout", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "assistant-deploy-plan-"));
  try {
    const root = new URL("../", import.meta.url);
    const source = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const manifest = JSON.parse(
      execFileSync(
        "git",
        [
          "show",
          `${source}:machine-learning/frameleaf_ml/models/assistant-planner-models.json`,
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    const output = path.join(directory, "output");
    const run = (sha) =>
      execFileSync(
        process.execPath,
        [".github/assistant-deploy-gate.mjs", "plan"],
        {
          cwd: root,
          env: { ...process.env, GITHUB_SHA: sha, GITHUB_OUTPUT: output },
          stdio: "pipe",
        },
      );
    run(source);
    const pin = defaultPlanner(manifest);
    const variant = pin ? plannerVariant(pin.runtime) : "";
    assert.equal(
      readFileSync(output, "utf8"),
      `required=${manifest.length > 0}\nvariant=${variant}\n`,
    );
    assert.throws(() => run("0".repeat(40)), /Wrong candidate checkout/);
    assert.equal(
      readFileSync(output, "utf8"),
      `required=${manifest.length > 0}\nvariant=${variant}\n`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const [runtime, variant, imageVariant] of [
  ["transformers", "cpu", "cpu"],
  ["openvino", "openvino", "openvino-openvino"],
]) {
  test(`${runtime} qualification requires a fresh report from the same worker invocation`, () =>
    checkQualification(runtime, variant, imageVariant));
}

async function checkQualification(runtime, variant, imageVariant) {
  const temp = mkdtempSync(path.join(tmpdir(), "assistant-deploy-live-"));
  const source = "a".repeat(40);
  const image = `127.0.0.1:5000/deploy-test/assistant@sha256:${"b".repeat(64)}`;
  const summary = path.join(temp, "summary");
  const output = path.join(temp, "output");
  const manifestDigest = `sha256:${"c".repeat(64)}`;
  const evidence = path.join(temp, "assistant-qualification-evidence.json");
  const report = {
    workerModel: planner.name,
    source,
    mode: "qualification",
    cases: cases.length,
    assets: library.length,
    corpusDigest: createHash("sha256")
      .update(JSON.stringify([cases, library]))
      .digest("hex"),
    plannerAnswers: cases.length,
    protectedHits: 0,
    filterAccuracy: 1,
    recallAt24: 1,
    faithfulness: 1,
    p95Ms: 6000,
  };
  try {
    for (const scenario of [
      "no-report",
      "stale",
      "failed",
      "passing",
      "duplicate",
    ]) {
      const calls = [];
      const dependencies = {
        async loadArchive(file) {
          assert.equal(file, path.join(temp, "ml", "image.tar"));
          return image;
        },
        async ready(endpoint) {
          assert.equal(endpoint, "http://127.0.0.1:32768");
        },
        execute(command, args, options) {
          calls.push(`${command} ${args[0]}`);
          if (command === "oras") {
            assert.deepEqual(args, [
              "manifest",
              "fetch",
              "--plain-http",
              image,
            ]);
            return JSON.stringify({
              manifests: [
                {
                  platform: { os: "linux", architecture: "amd64" },
                  digest: manifestDigest,
                },
                {
                  platform: { os: "unknown", architecture: "unknown" },
                  digest: `sha256:${"d".repeat(64)}`,
                },
              ],
            });
          }
          if (args[0] === "image")
            return JSON.stringify({
              "org.opencontainers.image.source":
                "https://github.com/Frameleaf/frameleaf-app",
              "org.opencontainers.image.revision": source,
              "org.frameleaf.build.variant": imageVariant,
            });
          if (args[0] === "run") {
            assert.equal(args.at(-1), image);
            assert.ok(args.includes("127.0.0.1::3003"));
            assert.equal(args[args.indexOf("--platform") + 1], "linux/amd64");
            assert.ok(!args.includes("--device") && !args.includes("--gpus"));
          }
          if (args[0] === "port") return "127.0.0.1:32768";
          if (command === "pnpm") {
            const env = options.env;
            assert.equal(env.FRAMELEAF_ASSISTANT_EVAL_MODE, "qualification");
            assert.equal(
              env.FRAMELEAF_ASSISTANT_PLANNER_URL,
              "http://127.0.0.1:32768",
            );
            const output = env.FRAMELEAF_ASSISTANT_QUALIFICATION_REPORT;
            assert.equal(existsSync(output), false);
            if (scenario === "failed") throw new Error("Evaluator failed");
            if (scenario !== "no-report") {
              writeFileSync(
                output,
                JSON.stringify({
                  ...report,
                  source: scenario === "stale" ? "0".repeat(40) : source,
                }),
              );
            }
          }
          return "";
        },
      };
      const result = qualify(
        source,
        { ...planner, runtime },
        {
          RUNNER_TEMP: temp,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_OUTPUT: output,
          FRAMELEAF_ASSISTANT_QUALIFICATION_REPORT: "/injected-report.json",
          FRAMELEAF_ASSISTANT_PLANNER_URL: "https://injected.example",
        },
        dependencies,
      );
      if (scenario === "passing") {
        await result;
        assert.ok(readFileSync(summary, "utf8").includes(image));
        assert.deepEqual(JSON.parse(readFileSync(evidence, "utf8")), {
          workerVariant: variant,
          workerImageDigest: `sha256:${"b".repeat(64)}`,
          workerManifestDigest: manifestDigest,
          report,
        });
        assert.equal(
          readFileSync(output, "utf8"),
          `amd64-manifest=${manifestDigest}\n`,
        );
      } else if (scenario === "duplicate") {
        const original = readFileSync(evidence, "utf8");
        const originalSummary = readFileSync(summary, "utf8");
        const originalOutput = readFileSync(output, "utf8");
        await assert.rejects(result, /EEXIST/);
        assert.equal(readFileSync(evidence, "utf8"), original);
        assert.equal(readFileSync(summary, "utf8"), originalSummary);
        assert.equal(readFileSync(output, "utf8"), originalOutput);
      } else {
        await assert.rejects(result, /ENOENT|source mismatch|Evaluator failed/);
        assert.equal(existsSync(summary), false);
        assert.equal(existsSync(evidence), false);
        assert.equal(existsSync(output), false);
      }
      assert.deepEqual(calls, [
        "oras manifest",
        "docker image",
        "docker run",
        "docker port",
        "docker exec",
        "pnpm --filter",
        "docker rm",
      ]);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
