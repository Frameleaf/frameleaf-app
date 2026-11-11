import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath =
  "machine-learning/frameleaf_ml/models/assistant-planner-models.json";

export function defaultPlanner(manifest) {
  assert(
    Array.isArray(manifest),
    "Expected an Assistant planner manifest array",
  );
  if (manifest.length === 0) return null;
  for (const entry of manifest) {
    assert(
      entry &&
        typeof entry === "object" &&
        typeof entry.name === "string" &&
        /^[a-z0-9][a-z0-9_-]*$/.test(entry.name) &&
        (entry.default === undefined || typeof entry.default === "boolean"),
      "Invalid Assistant planner entry",
    );
  }
  assert.equal(
    new Set(manifest.map(({ name }) => name)).size,
    manifest.length,
    "Duplicate Assistant planner name",
  );
  const defaults = manifest.filter((entry) => entry.default);
  assert.equal(
    defaults.length,
    1,
    "Expected exactly one default Assistant planner",
  );
  const [planner] = defaults;
  assert.equal(
    planner.runtime,
    "transformers",
    "The hosted CPU qualification image requires a Transformers planner",
  );
  assert(
    planner.files &&
      typeof planner.files === "object" &&
      !Array.isArray(planner.files) &&
      Object.entries(planner.files).length > 0 &&
      Object.entries(planner.files).every(
        ([file, digest]) =>
          file.startsWith("textual/") &&
          file
            .split("/")
            .every((part) => part && part !== "." && part !== "..") &&
          typeof digest === "string" &&
          /^[a-f0-9]{64}$/.test(digest),
      ),
    "The default Assistant planner must pin its model files by SHA-256",
  );
  return planner;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
}

function sourcePlanner(source) {
  assert.match(
    source ?? "",
    /^[a-f0-9]{40}$/,
    "Expected the exact candidate SHA",
  );
  assert.equal(
    run("git", ["rev-parse", "HEAD"]).trim(),
    source,
    "Wrong candidate checkout",
  );
  return defaultPlanner(
    JSON.parse(run("git", ["show", `${source}:${manifestPath}`])),
  );
}

export function assertArchiveIdentity(labels, source) {
  assert.equal(
    labels["org.opencontainers.image.source"],
    "https://github.com/Frameleaf/frameleaf-app",
    "Wrong ML image source repository",
  );
  assert.equal(
    labels["org.opencontainers.image.revision"],
    source,
    "Wrong ML image source revision",
  );
  assert.equal(
    labels["org.frameleaf.build.variant"],
    "cpu",
    "Wrong ML image runtime variant",
  );
}

export function workerEndpoint(mapping) {
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(mapping.trim());
  assert(
    match && Number(match[1]) <= 65535,
    "Expected a loopback-only worker port",
  );
  return `http://127.0.0.1:${match[1]}`;
}

async function waitForWorker(endpoint) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = await fetch(`${endpoint}/ping`, {
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return;
    await sleep(1000);
  }
  throw new Error("The disposable Assistant worker did not start");
}

export async function qualify(
  source,
  planner,
  env,
  { execute = run, loadArchive, ready = waitForWorker } = {},
) {
  assert(planner, "The candidate must pin a default Assistant planner");
  loadArchive ??= (await import("./frameleaf-deploy-test.cjs")).default
    .loadArchive;
  const { verifyQualification } = await import("./assistant-qualification.mjs");
  const directory = mkdtempSync(
    path.join(env.RUNNER_TEMP, "assistant-qualification-"),
  );
  const archive = path.join(env.RUNNER_TEMP, "ml", "image.tar");
  const reportPath = path.join(directory, "report.json");
  const worker = path.basename(directory);
  let started = false;
  try {
    const image = await loadArchive(archive, "assistant", directory);
    const workerImageDigest = /@(sha256:[a-f0-9]{64})$/.exec(image)?.[1];
    assert(workerImageDigest, "Expected the tested ML archive's exact digest");
    const labels = JSON.parse(
      execute("docker", [
        "image",
        "inspect",
        "--format",
        "{{json .Config.Labels}}",
        image,
      ]),
    );
    assertArchiveIdentity(labels, source);
    execute("docker", [
      "run",
      "--detach",
      "--pull",
      "never",
      "--name",
      worker,
      "--publish",
      "127.0.0.1::3003",
      image,
    ]);
    started = true;
    const endpoint = workerEndpoint(
      execute("docker", ["port", worker, "3003/tcp"]),
    );
    await ready(endpoint);
    // A fresh image-local cache forces the production downloader to verify every pinned file.
    execute(
      "docker",
      [
        "exec",
        "--user",
        "10001:10001",
        "--env",
        "HOME=/home/frameleaf",
        worker,
        "python",
        "-c",
        "from frameleaf_ml.models.assistant_planner import AssistantPlannerModel; import sys; AssistantPlannerModel(sys.argv[1]).download()",
        planner.name,
      ],
      { stdio: "inherit", timeout: 10 * 60_000 },
    );
    execute("pnpm", ["--filter", "frameleaf", "test:assistant-eval"], {
      stdio: "inherit",
      env: {
        ...env,
        FRAMELEAF_ASSISTANT_EVAL_MODE: "qualification",
        FRAMELEAF_ASSISTANT_PLANNER_URL: endpoint,
        FRAMELEAF_ASSISTANT_QUALIFICATION_REPORT: reportPath,
      },
    });
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    verifyQualification(report, source, planner.name);
    writeFileSync(
      path.join(env.RUNNER_TEMP, "assistant-qualification-evidence.json"),
      `${JSON.stringify({ workerImageDigest, report }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Assistant qualification passed\n\nWorker: \`${image}\`\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
    );
  } finally {
    if (started)
      execute("docker", ["rm", "--force", "--volumes", worker], {
        stdio: "ignore",
      });
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { GITHUB_SHA, GITHUB_OUTPUT } = process.env;
  const planner = sourcePlanner(GITHUB_SHA);
  if (process.argv[2] === "plan") {
    appendFileSync(GITHUB_OUTPUT, `required=${planner !== null}\n`);
  } else {
    assert.equal(process.argv[2], "qualify", "Expected plan or qualify");
    await qualify(GITHUB_SHA, planner, process.env);
  }
}
