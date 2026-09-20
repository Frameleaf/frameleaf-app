import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildInventory,
  parseDockerfilePins,
  parseMiseTools,
  parseWorkflowPins,
  renderJsonLines,
  renderMarkdown,
} from "./frameleaf-toolchain-inventory.mjs";

test("parses direct and nested mise tool declarations", () => {
  const content =
    '[tools]\nnode = "24.21.0"\n"npm:oazapfts" = "7.5.0"\n\n[tools."github:example/tool"]\nversion = "v1.2.3"\n';
  assert.deepEqual(parseMiseTools(content, "mise.toml"), [
    {
      category: "tool",
      declared: "24.21.0",
      kind: "exact",
      name: "node",
      source: "mise.toml",
    },
    {
      category: "tool",
      declared: "7.5.0",
      kind: "exact",
      name: "npm:oazapfts",
      source: "mise.toml",
    },
    {
      category: "tool",
      declared: "v1.2.3",
      kind: "exact",
      name: "github:example/tool",
      source: "mise.toml",
    },
  ]);
});

test("parses pinned workflow and container runtime sources", () => {
  const actionSha = "a".repeat(40);
  const imageSha = "b".repeat(64);
  assert.deepEqual(
    parseWorkflowPins(
      `jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@${actionSha}\n      - run: docker run ghcr.io/jdx/mise:2026.1@sha256:${imageSha}\n`,
      ".github/workflows/fork-integration.yml",
    ),
    [
      {
        category: "workflow-action",
        declared: actionSha,
        kind: "commit",
        name: "actions/checkout",
        source: ".github/workflows/fork-integration.yml",
      },
      {
        category: "workflow-runner",
        declared: "ubuntu-24.04",
        kind: "image-label",
        name: "github-hosted-runner",
        source: ".github/workflows/fork-integration.yml",
      },
      {
        category: "container-image",
        declared: `ghcr.io/jdx/mise:2026.1@sha256:${imageSha}`,
        kind: "tag-and-digest",
        name: "ghcr.io/jdx/mise",
        source: ".github/workflows/fork-integration.yml",
      },
    ],
  );
  assert.deepEqual(
    parseDockerfilePins(
      `FROM node:24@sha256:${imageSha} AS build\nFROM build AS final\n`,
      "server/Dockerfile",
    ),
    [
      {
        category: "container-image",
        declared: `node:24@sha256:${imageSha}`,
        kind: "tag-and-digest",
        name: "node",
        source: "server/Dockerfile",
      },
    ],
  );
});

test("builds deterministic evidence and distinguishes resolved, missing, and non-probed tools", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "frameleaf-toolchain-"));
  const bin = path.join(repository, "bin");
  try {
    execFileSync("git", ["-C", repository, "init", "--initial-branch=main"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    execFileSync("git", [
      "-C",
      repository,
      "config",
      "user.email",
      "test@example.com",
    ]);
    mkdirSync(path.join(repository, ".github/workflows"), { recursive: true });
    mkdirSync(path.join(repository, "icloud-bridge"), { recursive: true });
    mkdirSync(path.join(repository, "machine-learning"), { recursive: true });
    mkdirSync(path.join(repository, "mobile/android/gradle/wrapper"), {
      recursive: true,
    });
    mkdirSync(path.join(repository, "mobile/ios"), { recursive: true });
    mkdirSync(path.join(repository, "packages/cli"), { recursive: true });
    mkdirSync(path.join(repository, "packages/e2e-auth-server"), {
      recursive: true,
    });
    mkdirSync(path.join(repository, "server"), { recursive: true });
    mkdirSync(path.join(repository, "deployment"));
    mkdirSync(path.join(repository, "docs"));
    mkdirSync(bin);
    writeFileSync(
      path.join(repository, "mise.toml"),
      '[tools]\nnode = "1.2.3"\npnpm = "9.0.0"\n',
    );
    for (const file of [
      "deployment/mise.toml",
      "docs/mise.toml",
      "machine-learning/mise.toml",
      "mobile/mise.toml",
    ])
      writeFileSync(path.join(repository, file), "");
    writeFileSync(path.join(repository, ".nvmrc"), "1.2.3\n");
    writeFileSync(
      path.join(repository, "package.json"),
      '{"packageManager":"pnpm@9.0.0","engines":{"pnpm":">=9"}}',
    );
    writeFileSync(
      path.join(repository, "machine-learning/.python-version"),
      "3.13\n",
    );
    writeFileSync(
      path.join(repository, "machine-learning/pyproject.toml"),
      'requires-python = ">=3.12,<4"\n',
    );
    writeFileSync(
      path.join(repository, "mobile/pubspec.yaml"),
      "environment:\n  sdk: '>=3.12 <4'\n  flutter: 3.47.2\n",
    );
    writeFileSync(
      path.join(
        repository,
        "mobile/android/gradle/wrapper/gradle-wrapper.properties",
      ),
      "distributionUrl=gradle-8.14-all.zip\n",
    );
    writeFileSync(
      path.join(repository, "mobile/ios/Podfile.lock"),
      "COCOAPODS: 1.17.0\n",
    );
    writeFileSync(
      path.join(repository, "mobile/android/Gemfile.lock"),
      "BUNDLED WITH\n   2.3.7\n",
    );
    for (const file of [
      "mise.lock",
      "pnpm-lock.yaml",
      "machine-learning/uv.lock",
      "mobile/pubspec.lock",
    ]) {
      writeFileSync(path.join(repository, file), `${file}\n`);
    }
    const imageSha = "b".repeat(64);
    writeFileSync(
      path.join(repository, ".github/workflows/fork-integration.yml"),
      `jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)}\n`,
    );
    for (const file of [
      "icloud-bridge/Dockerfile",
      "machine-learning/Dockerfile",
      "packages/cli/Dockerfile",
      "packages/e2e-auth-server/Dockerfile",
      "server/Dockerfile",
      "server/Dockerfile.dev",
    ]) {
      writeFileSync(
        path.join(repository, file),
        `FROM node:24@sha256:${imageSha}\n`,
      );
    }
    writeFileSync(
      path.join(bin, "node"),
      "#!/bin/sh\nprintf 'v1.2.3 token=literal-secret %s /Users/private/work\\n' \"$FRAMELEAF_TEST_SECRET\"\n",
      { mode: 0o755 },
    );
    const unsafeSentinel = path.join(repository, "unsafe-wrapper-executed");
    writeFileSync(
      path.join(bin, "flutter"),
      `#!/bin/sh\nprintf touched > '${unsafeSentinel}'\n`,
      { mode: 0o755 },
    );
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "fixture"]);
    const baseline = execFileSync(
      "git",
      ["-C", repository, "rev-parse", "HEAD"],
      {
        encoding: "utf8",
      },
    ).trim();
    const tree = execFileSync("git", ["-C", repository, "write-tree"], {
      encoding: "utf8",
    }).trim();
    const unrelatedBaseline = execFileSync(
      "git",
      ["-C", repository, "commit-tree", tree],
      { encoding: "utf8", input: "unrelated baseline\n" },
    ).trim();
    assert.throws(
      () => buildInventory(repository, bin, "0".repeat(40)),
      /Expected baseline is not a commit/,
    );
    assert.throws(
      () => buildInventory(repository, bin, baseline.slice(0, 12)),
      /Expected baseline must be a full lowercase 40-character commit SHA/,
    );
    assert.throws(
      () => buildInventory(repository, bin, unrelatedBaseline),
      /Expected baseline is not an ancestor of current HEAD/,
    );

    const priorSecret = process.env.FRAMELEAF_TEST_SECRET;
    process.env.FRAMELEAF_TEST_SECRET = "environment-secret";
    const first = buildInventory(repository, bin, baseline);
    const second = buildInventory(repository, bin, baseline);
    if (priorSecret === undefined) delete process.env.FRAMELEAF_TEST_SECRET;
    else process.env.FRAMELEAF_TEST_SECRET = priorSecret;
    assert.deepEqual(first, second);
    assert.equal(
      first.resolutions.find((item) => item.name === "node").status,
      "resolved",
    );
    assert.equal(
      first.resolutions.find((item) => item.name === "node").comparisonStatus,
      "matches",
    );
    assert.equal(
      first.resolutions.find((item) => item.name === "pnpm").status,
      "missing-not-probed",
    );
    assert.equal(
      first.resolutions.find((item) => item.name === "pnpm").comparisonStatus,
      "unavailable",
    );
    assert.equal(
      first.resolutions.find((item) => item.name === "flutter").status,
      "present-not-probed",
    );
    assert.equal(
      first.resolutions.find((item) => item.name === "node").versionOutput,
      "version 1.2.3",
    );
    assert.equal(
      first.resolutions.find((item) => item.name === "node").executableIdentity,
      "$PATH[0]/node",
    );
    assert.equal(existsSync(unsafeSentinel), false);
    assert.equal(first.summary.probeFailedCount, 0);
    const evidence = renderJsonLines(first);
    assert.equal(evidence, renderJsonLines(second));
    assert.equal(evidence.includes(repository), false);
    assert.equal(evidence.includes("literal-secret"), false);
    assert.equal(evidence.includes("environment-secret"), false);
    assert.equal(first.summary.workflowActionPinCount, 1);
    assert.equal(first.summary.containerPinCount, 6);

    const deliveryPath = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const deliveryReport = buildInventory(repository, deliveryPath, baseline);
    const inventoryDirectory = path.join(repository, "scripts");
    const evidenceDirectory = path.join(repository, "docs/developer/evidence");
    mkdirSync(inventoryDirectory, { recursive: true });
    mkdirSync(evidenceDirectory, { recursive: true });
    const deliveredScript = path.join(
      inventoryDirectory,
      "frameleaf-toolchain-inventory.mjs",
    );
    const sourceScript = fileURLToPath(
      new URL("./frameleaf-toolchain-inventory.mjs", import.meta.url),
    );
    const outputJsonl = path.join(evidenceDirectory, "toolchain.jsonl");
    const outputMarkdown = path.join(evidenceDirectory, "toolchain.md");
    writeFileSync(deliveredScript, readFileSync(sourceScript));
    writeFileSync(outputJsonl, renderJsonLines(deliveryReport));
    writeFileSync(outputMarkdown, renderMarkdown(deliveryReport));
    execFileSync("git", ["-C", repository, "add", "scripts", "docs/developer"]);
    execFileSync("git", [
      "-C",
      repository,
      "commit",
      "-m",
      "deliver inventory evidence",
    ]);
    execFileSync(
      process.execPath,
      [
        deliveredScript,
        "--repository",
        repository,
        "--expected-baseline",
        baseline,
        "--output-jsonl",
        outputJsonl,
        "--output-markdown",
        outputMarkdown,
        "--check",
      ],
      { env: { PATH: deliveryPath } },
    );

    const jsonlBeforeMutation = readFileSync(outputJsonl);
    const markdownBeforeMutation = readFileSync(outputMarkdown);
    const mutationBin = path.join(repository, "mutation-bin");
    mkdirSync(mutationBin);
    writeFileSync(
      path.join(mutationBin, "node"),
      `#!/bin/sh\nprintf '[tools]\\nnode = "8.8.8"\\n' > '${path.join(repository, "mise.toml")}'; /bin/sleep 0.2\nprintf 'v1.2.4\\n'\n`,
      { mode: 0o755 },
    );
    const mutationPath = `${mutationBin}${path.delimiter}${deliveryPath}`;
    const mutationRun = spawnSync(
      process.execPath,
      [
        deliveredScript,
        "--repository",
        repository,
        "--expected-baseline",
        baseline,
        "--output-jsonl",
        outputJsonl,
        "--output-markdown",
        outputMarkdown,
      ],
      { encoding: "utf8", env: { PATH: mutationPath } },
    );
    assert.notEqual(
      mutationRun.status,
      0,
      `mutation run unexpectedly succeeded; stdout=${mutationRun.stdout}; mise.toml=${readFileSync(path.join(repository, "mise.toml"), "utf8")}; evidence=${readFileSync(outputJsonl, "utf8")}`,
    );
    assert.match(
      mutationRun.stderr,
      /Toolchain source changed during inventory generation: mise\.toml/,
    );
    assert.deepEqual(readFileSync(outputJsonl), jsonlBeforeMutation);
    assert.deepEqual(readFileSync(outputMarkdown), markdownBeforeMutation);

    writeFileSync(
      path.join(repository, "mise.toml"),
      '[tools]\nnode = "9.9.9"\n',
    );
    assert.throws(
      () => buildInventory(repository, bin, baseline),
      /Toolchain source differs from reviewed baseline: mise\.toml/,
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});
