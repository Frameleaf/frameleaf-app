#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MISE_FILES = [
  "mise.toml",
  "deployment/mise.toml",
  "docs/mise.toml",
  "machine-learning/mise.toml",
  "mobile/mise.toml",
];

const LOCK_SOURCES = [
  "mise.lock",
  "pnpm-lock.yaml",
  "machine-learning/uv.lock",
  "mobile/pubspec.lock",
];
const WORKFLOW_SOURCES = [".github/workflows/fork-integration.yml"];
const CONTAINER_SOURCES = [
  "icloud-bridge/Dockerfile",
  "machine-learning/Dockerfile",
  "packages/cli/Dockerfile",
  "packages/e2e-auth-server/Dockerfile",
  "server/Dockerfile",
  "server/Dockerfile.dev",
];

const PROBES = {
  "aqua:flutter/flutter": {
    commands: ["flutter"],
    args: ["--version"],
    safe: false,
  },
  "github:CQLabs/homebrew-dcm": {
    commands: ["dcm"],
    args: ["--version"],
    safe: false,
  },
  "github:extism/cli": {
    commands: ["extism"],
    args: ["--version"],
    safe: false,
  },
  "github:extism/js-pdk": {
    commands: ["extism-js"],
    args: ["--version"],
    safe: false,
  },
  "github:jellyfin/jellyfin-ffmpeg": {
    commands: ["ffmpeg"],
    args: ["-version"],
    safe: true,
  },
  "github:webassembly/binaryen": {
    commands: ["wasm-opt"],
    args: ["--version"],
  },
  bundler: { commands: ["bundle"], args: ["--version"], safe: true },
  cocoapods: { commands: ["pod"], args: ["--version"], safe: false },
  flutter: { commands: ["flutter"], args: ["--version"], safe: false },
  gradle: { commands: ["gradle"], args: ["--version"], safe: false },
  java: { commands: ["java"], args: ["-version"], safe: true },
  node: { commands: ["node"], args: ["--version"], safe: true },
  "npm:@openapitools/openapi-generator-cli": {
    commands: ["openapi-generator-cli"],
    args: ["version"],
  },
  "npm:oazapfts": { commands: ["oazapfts"], args: ["--version"] },
  opentofu: { commands: ["tofu"], args: ["version"] },
  pnpm: { commands: ["pnpm"], args: ["--version"], safe: false },
  python: { commands: ["python3", "python"], args: ["--version"], safe: true },
  terragrunt: { commands: ["terragrunt"], args: ["--version"] },
  uv: { commands: ["uv"], args: ["--version"], safe: true },
  wrangler: { commands: ["wrangler"], args: ["--version"] },
};

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function source(repository, filePath, expectedBaseline) {
  const bytes = readFileSync(path.join(repository, filePath));
  const baselineBytes = execFileSync("git", [
    "-C",
    repository,
    "show",
    `${expectedBaseline}:${filePath}`,
  ]);
  if (!bytes.equals(baselineBytes))
    throw new Error(
      `Toolchain source differs from reviewed baseline: ${filePath}`,
    );
  return {
    bytes,
    content: bytes.toString("utf8"),
    filePath,
    sha256: sha256(bytes),
  };
}

export function parseMiseTools(content, filePath) {
  const declarations = [];
  let section = "";
  let nestedTool = null;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      nestedTool = section.match(/^tools\."([^"]+)"$/)?.[1] ?? null;
      continue;
    }
    if (section === "tools") {
      const match = line.match(/^(?:"([^"]+)"|([^=\s]+))\s*=\s*"([^"]+)"$/);
      if (match) {
        declarations.push({
          category: "tool",
          declared: match[3],
          kind: "exact",
          name: match[1] ?? match[2],
          source: filePath,
        });
      }
    } else if (nestedTool) {
      const match = line.match(/^version\s*=\s*"([^"]+)"$/);
      if (match)
        declarations.push({
          category: "tool",
          declared: match[1],
          kind: "exact",
          name: nestedTool,
          source: filePath,
        });
    }
  }
  return declarations;
}

function addDirectDeclarations(repository, head, declarations, sources) {
  const nvm = source(repository, ".nvmrc", head);
  sources.push(nvm);
  declarations.push({
    category: "tool",
    declared: nvm.content.trim(),
    kind: "exact",
    name: "node",
    source: nvm.filePath,
  });

  const packageSource = source(repository, "package.json", head);
  sources.push(packageSource);
  const packageJson = JSON.parse(packageSource.content);
  const [manager, managerVersion] = packageJson.packageManager.split("@");
  declarations.push({
    category: "tool",
    declared: managerVersion,
    kind: "exact",
    name: manager,
    source: packageSource.filePath,
  });
  declarations.push({
    category: "tool",
    declared: packageJson.engines.pnpm,
    kind: "constraint",
    name: "pnpm",
    source: packageSource.filePath,
  });

  const pythonVersion = source(
    repository,
    "machine-learning/.python-version",
    head,
  );
  sources.push(pythonVersion);
  declarations.push({
    category: "tool",
    declared: pythonVersion.content.trim(),
    kind: "exact",
    name: "python",
    source: pythonVersion.filePath,
  });

  const pyproject = source(repository, "machine-learning/pyproject.toml", head);
  sources.push(pyproject);
  declarations.push({
    declared: pyproject.content.match(/^requires-python\s*=\s*"([^"]+)"/m)?.[1],
    category: "tool",
    kind: "constraint",
    name: "python",
    source: pyproject.filePath,
  });

  const pubspec = source(repository, "mobile/pubspec.yaml", head);
  sources.push(pubspec);
  declarations.push({
    declared: pubspec.content.match(/^\s+sdk:\s*['"]([^'"]+)['"]/m)?.[1],
    category: "tool",
    kind: "constraint",
    name: "dart",
    source: pubspec.filePath,
  });
  declarations.push({
    declared: pubspec.content.match(/^\s+flutter:\s*([^\s]+)\s*$/m)?.[1],
    category: "tool",
    kind: "exact",
    name: "flutter",
    source: pubspec.filePath,
  });

  const gradle = source(
    repository,
    "mobile/android/gradle/wrapper/gradle-wrapper.properties",
    head,
  );
  sources.push(gradle);
  declarations.push({
    declared: gradle.content.match(/gradle-([0-9.]+)-(?:all|bin)\.zip/)?.[1],
    category: "tool",
    kind: "exact-wrapper",
    name: "gradle",
    source: gradle.filePath,
  });

  const podLock = source(repository, "mobile/ios/Podfile.lock", head);
  sources.push(podLock);
  declarations.push({
    declared: podLock.content.match(/^COCOAPODS:\s*(\S+)/m)?.[1],
    category: "tool",
    kind: "lockfile",
    name: "cocoapods",
    source: podLock.filePath,
  });

  const bundleLock = source(repository, "mobile/android/Gemfile.lock", head);
  sources.push(bundleLock);
  declarations.push({
    declared: bundleLock.content.match(/^BUNDLED WITH\s*\n\s*(\S+)/m)?.[1],
    category: "tool",
    kind: "lockfile",
    name: "bundler",
    source: bundleLock.filePath,
  });
}

export function parseWorkflowPins(content, filePath) {
  const declarations = [];
  for (const match of content.matchAll(
    /^\s*-?\s*uses:\s*([^\s@]+)@([a-f0-9]{40})/gm,
  )) {
    declarations.push({
      category: "workflow-action",
      declared: match[2],
      kind: "commit",
      name: match[1],
      source: filePath,
    });
  }
  for (const match of content.matchAll(
    /^\s*runs-on:\s*['"]?([^'"\s]+)['"]?/gm,
  )) {
    declarations.push({
      category: "workflow-runner",
      declared: match[1],
      kind: "image-label",
      name: "github-hosted-runner",
      source: filePath,
    });
  }
  for (const match of content.matchAll(
    /\b((?:ghcr\.io|docker\.io)\/[A-Za-z0-9_./-]+:[A-Za-z0-9_.-]+@sha256:[a-f0-9]{64})\b/g,
  )) {
    declarations.push({
      category: "container-image",
      declared: match[1],
      kind: "tag-and-digest",
      name: match[1].split(":")[0],
      source: filePath,
    });
  }
  return declarations;
}

export function parseDockerfilePins(content, filePath) {
  const declarations = [];
  for (const match of content.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?/gim)) {
    const image = match[1];
    if (image.includes("${") || (!image.includes(":") && !image.includes("@")))
      continue;
    declarations.push({
      category: "container-image",
      declared: image,
      kind: image.includes("@sha256:") ? "tag-and-digest" : "mutable-reference",
      name: image.split(":")[0],
      source: filePath,
    });
  }
  return declarations;
}

function findExecutable(commands, searchPath) {
  const directories = searchPath.split(path.delimiter).filter(Boolean);
  for (const command of commands) {
    for (const [pathIndex, directory] of directories.entries()) {
      const candidate = path.join(directory, command);
      try {
        accessSync(candidate, constants.X_OK);
        return {
          absolutePath: realpathSync(candidate),
          identity: `$PATH[${pathIndex}]/${command}`,
        };
      } catch {
        // Continue without changing or installing the requested tool.
      }
    }
  }
  return null;
}

function sanitizedVersionOutput(result) {
  const line =
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? null;
  if (!line) return null;
  const version = line.match(/\bv?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1];
  return version ? `version ${version}` : "[output redacted: no version token]";
}

function normalizeVersion(value) {
  return value.replace(/^version_/, "").replace(/^v/, "");
}

function extractResolvedVersion(output) {
  return (
    output?.match(/\bv?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1] ?? null
  );
}

function resolveTool(name, searchPath) {
  const probe = PROBES[name] ?? {
    commands: [name],
    args: ["--version"],
    safe: false,
  };
  const executable = findExecutable(probe.commands, searchPath);
  if (probe.safe !== true) {
    return {
      name,
      reason: executable
        ? "Executable is present but its wrapper is not on the strict side-effect-safe probe allowlist"
        : "Executable is absent; unsafe wrapper was not executed",
      ...(executable
        ? {
            executableIdentity: executable.identity,
            pathPortability: "controlled-path-slot",
          }
        : {}),
      status: executable ? "present-not-probed" : "missing-not-probed",
    };
  }
  if (!executable)
    return {
      name,
      reason: "No executable found on the controlled PATH",
      status: "missing",
    };
  const sanitizedEnvironment = {
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: searchPath,
  };
  const result = spawnSync(executable.absolutePath, probe.args, {
    encoding: "utf8",
    env: sanitizedEnvironment,
    timeout: 5000,
  });
  const versionOutput = sanitizedVersionOutput(result);
  const probeSucceeded =
    !result.error &&
    result.status === 0 &&
    versionOutput !== "[output redacted: no version token]";
  return {
    executableIdentity: executable.identity,
    name,
    pathPortability: "controlled-path-slot",
    status: probeSucceeded ? "resolved" : "probe-failed",
    versionOutput,
  };
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortDeep(value[key])]),
  );
}

export function buildInventory(
  repository,
  searchPath = process.env.PATH ?? "",
  expectedBaseline,
) {
  const root = path.resolve(repository);
  const headBefore = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(expectedBaseline ?? ""))
    throw new Error(
      "Expected baseline must be a full lowercase 40-character commit SHA",
    );
  let baselineCommit;
  try {
    baselineCommit = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--verify", `${expectedBaseline}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error(`Expected baseline is not a commit: ${expectedBaseline}`);
  }
  if (baselineCommit !== expectedBaseline)
    throw new Error(
      `Expected baseline did not resolve exactly: ${expectedBaseline}`,
    );
  const ancestry = spawnSync(
    "git",
    ["-C", root, "merge-base", "--is-ancestor", baselineCommit, headBefore],
    { encoding: "utf8" },
  );
  if (ancestry.status !== 0)
    throw new Error(
      `Expected baseline is not an ancestor of current HEAD: ${baselineCommit}`,
    );
  const declarations = [];
  const sources = [];
  for (const filePath of MISE_FILES) {
    const item = source(root, filePath, baselineCommit);
    sources.push(item);
    declarations.push(...parseMiseTools(item.content, filePath));
  }
  addDirectDeclarations(root, baselineCommit, declarations, sources);
  for (const filePath of LOCK_SOURCES)
    sources.push(source(root, filePath, baselineCommit));
  for (const filePath of WORKFLOW_SOURCES) {
    const item = source(root, filePath, baselineCommit);
    sources.push(item);
    declarations.push(...parseWorkflowPins(item.content, filePath));
  }
  for (const filePath of CONTAINER_SOURCES) {
    const item = source(root, filePath, baselineCommit);
    sources.push(item);
    declarations.push(...parseDockerfilePins(item.content, filePath));
  }
  for (const item of declarations) {
    if (!item.declared)
      throw new Error(
        `Unable to parse ${item.name} declaration from ${item.source}`,
      );
  }
  declarations.sort((left, right) =>
    `${left.name}\0${left.source}`.localeCompare(
      `${right.name}\0${right.source}`,
    ),
  );
  const names = [
    ...new Set(
      declarations
        .filter((item) => item.category === "tool")
        .map((item) => item.name),
    ),
  ].sort();
  const resolutions = names.map((name) => {
    const resolution = resolveTool(name, searchPath);
    const exactDeclarations = declarations
      .filter(
        (item) =>
          item.category === "tool" &&
          item.name === name &&
          item.kind !== "constraint",
      )
      .map((item) => normalizeVersion(item.declared));
    const resolvedVersion = extractResolvedVersion(resolution.versionOutput);
    const comparisonStatus =
      resolution.status !== "resolved" || !resolvedVersion
        ? "unavailable"
        : exactDeclarations.length === 0
          ? "no-exact-declaration"
          : exactDeclarations.every(
                (declared) => declared === normalizeVersion(resolvedVersion),
              )
            ? "matches"
            : "mismatch";
    return {
      ...resolution,
      comparisonStatus,
      exactDeclarations,
      resolvedVersion,
    };
  });
  const headAfter = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (headBefore !== headAfter)
    throw new Error("HEAD changed during toolchain inventory generation");
  const pathEntryDigests = searchPath
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry, index) => ({ index, sha256: sha256(entry) }));
  for (const item of sources) {
    const finalBytes = readFileSync(path.join(root, item.filePath));
    const finalDigest = sha256(finalBytes);
    if (finalDigest !== item.sha256 || !finalBytes.equals(item.bytes))
      throw new Error(
        `Toolchain source changed during inventory generation: ${item.filePath}`,
      );
  }
  return {
    baseline: { commit: baselineCommit },
    declarations,
    probeContext: {
      environmentKeys: ["LANG", "LC_ALL", "NO_COLOR", "PATH"],
      pathEntryDigests,
      policy:
        "Only explicitly allowlisted version commands execute; wrappers default to non-probed",
    },
    resolutions,
    sources: sources
      .map(({ filePath, sha256: digest }) => ({ filePath, sha256: digest }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath)),
    summary: {
      declarationCount: declarations.length,
      containerPinCount: declarations.filter(
        (item) => item.category === "container-image",
      ).length,
      mismatchCount: resolutions.filter(
        (item) => item.comparisonStatus === "mismatch",
      ).length,
      missingCount: resolutions.filter((item) => item.status === "missing")
        .length,
      notProbedCount: resolutions.filter((item) =>
        item.status.endsWith("not-probed"),
      ).length,
      probeFailedCount: resolutions.filter(
        (item) => item.status === "probe-failed",
      ).length,
      resolvedCount: resolutions.filter((item) => item.status === "resolved")
        .length,
      sourceCount: sources.length,
      toolCount: resolutions.length,
      workflowActionPinCount: declarations.filter(
        (item) => item.category === "workflow-action",
      ).length,
      workflowRunnerPinCount: declarations.filter(
        (item) => item.category === "workflow-runner",
      ).length,
    },
  };
}

export function renderJsonLines(report) {
  const records = [
    {
      baseline: report.baseline,
      probeContext: report.probeContext,
      recordType: "metadata",
      summary: report.summary,
    },
    ...report.sources.map((item) => ({ ...item, recordType: "source" })),
    ...report.declarations.map((item) => ({
      ...item,
      recordType: "declaration",
    })),
    ...report.resolutions.map((item) => ({
      ...item,
      recordType: "resolution",
    })),
  ];
  return `${records.map((record) => JSON.stringify(sortDeep(record))).join("\n")}\n`;
}

export function renderMarkdown(report) {
  const lines = [
    "# FL-25 toolchain baseline evidence",
    "",
    `- Baseline commit: \`${report.baseline.commit}\``,
    `- Declared pin records: **${report.summary.declarationCount}**`,
    `- Hashed source files: **${report.summary.sourceCount}**`,
    `- Workflow action pins: **${report.summary.workflowActionPinCount}**`,
    `- Workflow runner labels: **${report.summary.workflowRunnerPinCount}**`,
    `- Container-image declarations: **${report.summary.containerPinCount}**`,
    `- Unique tools: **${report.summary.toolCount}**`,
    `- Resolved/exact-pin mismatches: **${report.summary.mismatchCount}**`,
    `- Resolved locally: **${report.summary.resolvedCount}**`,
    `- Missing locally: **${report.summary.missingCount}**`,
    `- Deliberately not probed: **${report.summary.notProbedCount}**`,
    `- Version probes failed: **${report.summary.probeFailedCount}**`,
    "",
    "## Resolved local tools",
    "",
    ...report.resolutions
      .filter((item) => item.status === "resolved")
      .map(
        (item) =>
          `- \`${item.name}\`: ${item.versionOutput} at \`${item.executableIdentity}\` (controlled PATH slot; comparison: **${item.comparisonStatus}**)`,
      ),
    "",
    "## Missing or unresolved tools",
    "",
    ...report.resolutions
      .filter((item) => item.status !== "resolved")
      .map(
        (item) =>
          `- \`${item.name}\`: **${item.status}** — ${item.reason ?? item.versionOutput ?? "Version unavailable"}`,
      ),
    "",
    "## Interpretation",
    "",
    "Declared pins come from source files verified byte-for-byte against the explicit reviewed baseline ancestor and hashed in the JSONL companion. Delivery-only commits may sit above that baseline, but any change to a covered source is rejected. Local resolution is observational: the generator does not install, update, initialize, or download tools. Probes receive only LANG, LC_ALL, NO_COLOR, and the caller-supplied controlled PATH. Evidence stores PATH-slot identities and PATH-entry digests rather than absolute paths. Missing or unprobed tools are not treated as version matches.",
    "",
  ];
  return lines.join("\n");
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") {
      options.check = true;
      continue;
    }
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined)
      throw new Error(
        "Arguments must be --name value pairs, plus optional --check",
      );
    options[argv[index].slice(2)] = argv[++index];
  }
  for (const key of [
    "repository",
    "expected-baseline",
    "output-jsonl",
    "output-markdown",
  ]) {
    if (!options[key]) throw new Error(`Missing --${key}`);
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = buildInventory(
    options.repository,
    process.env.PATH ?? "",
    options["expected-baseline"],
  );
  const jsonLines = renderJsonLines(report);
  const markdown = renderMarkdown(report);
  if (options.check) {
    if (readFileSync(options["output-jsonl"], "utf8") !== jsonLines)
      throw new Error("Toolchain JSONL evidence is stale");
    if (readFileSync(options["output-markdown"], "utf8") !== markdown)
      throw new Error("Toolchain Markdown evidence is stale");
  } else {
    writeFileSync(options["output-jsonl"], jsonLines);
    writeFileSync(options["output-markdown"], markdown);
  }
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main();
