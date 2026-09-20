#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STATUS_ARGS = [
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--ignore-submodules=none",
];

const WORKSTREAM_RULES = [
  [/^(AGENTS\.md|\.agents\/)/, "governance"],
  [/^(\.github\/|\.jira\/|docker\/|docker-compose|Dockerfile)/, "delivery"],
  [/^(design\/|prototypes\/)/, "design"],
  [/^docs\//, "documentation"],
  [/^studio\//, "studio"],
  [/^machine-learning\//, "machine-learning"],
  [/^mobile\//, "native"],
  [/^web\//, "web"],
  [/^server\//, "server"],
  [/^(open-api\/|packages\/sdk\/)/, "api-sdk"],
  [/^cli\//, "cli"],
  [/^i18n\//, "localization"],
  [/^scripts\//, "tooling"],
  [/^(e2e\/|test\/)/, "quality"],
];

const GENERATED_PATTERN =
  /(^|\/)(node_modules|\.cache|coverage|dist|build|\.dart_tool|__pycache__)(\/|$)|\.pyc$|^mobile\/generated\/openapi\//;
const EVIDENCE_PATTERN = /(^|\/)(evidence|reports?)(\/|$)/;

export function parsePorcelain(buffer) {
  const fields = buffer.toString("utf8").split("\0");
  fields.pop();
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length < 4 || record[2] !== " ") {
      throw new Error(`Invalid porcelain v1 -z record at index ${index}`);
    }
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const filePath = record.slice(3);
    let originalPath = null;
    if (indexStatus === "R" || indexStatus === "C") {
      originalPath = fields[++index];
      if (originalPath === undefined) {
        throw new Error(`Missing rename/copy source for ${filePath}`);
      }
    }
    entries.push({ filePath, indexStatus, originalPath, worktreeStatus });
  }
  return entries;
}

export function classifyPath(filePath, indexStatus, worktreeStatus) {
  const workstream =
    WORKSTREAM_RULES.find(([pattern]) => pattern.test(filePath))?.[1] ??
    "repository";
  const gitState =
    indexStatus === "?" && worktreeStatus === "?"
      ? "untracked"
      : [indexStatus, worktreeStatus].includes("D")
        ? "deleted"
        : [indexStatus, worktreeStatus].includes("R")
          ? "renamed"
          : [indexStatus, worktreeStatus].includes("C")
            ? "copied"
            : "modified";
  const reviewState = GENERATED_PATTERN.test(filePath)
    ? "generated-local-artifact"
    : EVIDENCE_PATTERN.test(filePath)
      ? "local-evidence"
      : "unreviewed-local-change";
  return { gitState, reviewState, workstream };
}

function git(repository, args, encoding = "utf8") {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryGit(repository, args, encoding = "utf8") {
  try {
    return git(repository, args, encoding);
  } catch {
    return null;
  }
}

function readGitlinkIndex(repository, filePath) {
  const record = git(repository, ["ls-files", "--stage", "-z", "--", filePath], null);
  if (record.length === 0) return null;
  const header = record.subarray(0, record.indexOf(0)).toString("utf8");
  const match = header.match(/^160000 ([a-f0-9]{40,64}) [0-3]\t/);
  return match?.[1] ?? null;
}

function hashGitDirectory(repository, absolutePath, entry) {
  const indexCommit = readGitlinkIndex(repository, entry.filePath);
  const headCommit = tryGit(absolutePath, ["rev-parse", "HEAD"])?.trim() ?? null;
  if (!indexCommit && !headCommit) {
    throw new Error(`Status directory is not a Git repository or gitlink: ${entry.filePath}`);
  }
  const nestedStatus = headCommit
    ? tryGit(absolutePath, STATUS_ARGS, null)
    : Buffer.alloc(0);
  if (headCommit && !nestedStatus) {
    throw new Error(`Unable to read nested Git status: ${entry.filePath}`);
  }
  const nestedDiff = headCommit
    ? tryGit(absolutePath, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], null)
    : Buffer.alloc(0);
  const untrackedPaths = headCommit
    ? tryGit(absolutePath, ["ls-files", "--others", "--exclude-standard", "-z"], null)
    : Buffer.alloc(0);
  if (headCommit && (!nestedDiff || !untrackedPaths)) {
    throw new Error(`Unable to read nested Git worktree: ${entry.filePath}`);
  }
  const untrackedDigest = createHash("sha256");
  let untrackedCount = 0;
  for (const nestedPath of untrackedPaths.toString("utf8").split("\0").filter(Boolean)) {
    const nestedAbsolutePath = path.join(absolutePath, nestedPath);
    const nestedStat = lstatSync(nestedAbsolutePath);
    if (nestedStat.isDirectory()) {
      throw new Error(`Nested untracked directory was not expanded: ${entry.filePath}/${nestedPath}`);
    }
    const nestedContent = nestedStat.isSymbolicLink()
      ? Buffer.from(readlinkSync(nestedAbsolutePath), "utf8")
      : readFileSync(nestedAbsolutePath);
    untrackedDigest.update(nestedPath);
    untrackedDigest.update("\0");
    untrackedDigest.update(nestedContent);
    untrackedDigest.update("\0");
    untrackedCount += 1;
  }
  const gitlinkState = {
    headCommit,
    indexCommit,
    nestedDiffBytes: nestedDiff.length,
    nestedDiffSha256: createHash("sha256").update(nestedDiff).digest("hex"),
    nestedStatusBytes: nestedStatus.length,
    nestedStatusSha256: createHash("sha256").update(nestedStatus).digest("hex"),
    nestedUntrackedCount: untrackedCount,
    nestedUntrackedSha256: untrackedDigest.digest("hex"),
  };
  const content = Buffer.from(JSON.stringify(gitlinkState), "utf8");
  return {
    bytes: content.length,
    gitlinkState,
    sha256: createHash("sha256").update(content).digest("hex"),
    targetType: indexCommit ? "gitlink" : "embedded-git-repository",
  };
}

function hashEntry(repository, entry) {
  const absolutePath = path.join(repository, entry.filePath);
  if (entry.gitState === "deleted") {
    return { bytes: null, sha256: null, targetType: "missing" };
  }
  const before = lstatSync(absolutePath, { bigint: true });
  if (before.isDirectory()) {
    return hashGitDirectory(repository, absolutePath, entry);
  }
  const content = before.isSymbolicLink()
    ? Buffer.from(readlinkSync(absolutePath), "utf8")
    : readFileSync(absolutePath);
  const after = lstatSync(absolutePath, { bigint: true });
  if (
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ino !== after.ino
  ) {
    throw new Error(`Path changed while hashing: ${entry.filePath}`);
  }
  return {
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    targetType: before.isSymbolicLink() ? "symlink" : "file",
  };
}

function countBy(entries, key) {
  return Object.fromEntries(
    [...new Set(entries.map((entry) => entry[key]))]
      .sort()
      .map((value) => [
        value,
        entries.filter((entry) => entry[key] === value).length,
      ]),
  );
}

export function normalizeRemoteIdentity(value) {
  const remote = value.trim();
  if (remote.startsWith("ext::")) return "ext::[redacted]";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      const parsed = new URL(remote);
      const host = parsed.hostname
        ? `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`
        : "";
      return `${parsed.protocol}//${host}${parsed.pathname}`;
    } catch {
      return "[unsupported-remote]";
    }
  }
  const scpLike = remote.match(/^(?:[^/@:]+(?::[^/@]*)?@)?([^/:?#]+):([^?#]+)(?:[?#].*)?$/);
  if (scpLike) return `${scpLike[1]}:${scpLike[2]}`;
  if (remote.includes("@") || remote.includes("?") || remote.includes("#")) {
    return "[unsupported-remote]";
  }
  return remote;
}

function readRemotes(repository) {
  const names = git(repository, ["remote"])
    .split("\n")
    .filter(Boolean)
    .sort();
  return names.map((name) => ({
    fetchIdentities: git(repository, ["remote", "get-url", "--all", name])
      .split("\n")
      .filter(Boolean)
      .map(normalizeRemoteIdentity),
    name,
    pushIdentities: git(repository, ["remote", "get-url", "--push", "--all", name])
      .split("\n")
      .filter(Boolean)
      .map(normalizeRemoteIdentity),
  }));
}

function renderMarkdown(report) {
  const table = (counts) =>
    Object.entries(counts)
      .map(([name, count]) => `| ${name} | ${count} |`)
      .join("\n");
  return `# FL-25 working-tree baseline inventory\n\n` +
    `This report is generated by \`scripts/frameleaf-baseline-inventory.mjs\`. ` +
    `The JSON companion is authoritative for path-level hashes and classifications.\n\n` +
    `## Snapshot identity\n\n` +
    `- Dirty checkout HEAD: \`${report.source.head}\`\n` +
    `- Dirty checkout tree: \`${report.source.headTree}\`\n` +
    `- Accepted merged baseline: \`${report.acceptedBaseline.commit}\`\n` +
    `- Accepted baseline tree: \`${report.acceptedBaseline.tree}\`\n` +
    `- Inventory entries: **${report.summary.entryCount}**\n` +
    `- Inventory paths: **${report.summary.pathCount}**\n` +
    `- Total readable bytes: **${report.summary.totalBytes}**\n\n` +
    `## Workstreams\n\n| Workstream | Paths |\n| --- | ---: |\n${table(report.summary.byWorkstream)}\n\n` +
    `## Git states\n\n| State | Paths |\n| --- | ---: |\n${table(report.summary.byGitState)}\n\n` +
    `## Review states\n\n| State | Paths |\n| --- | ---: |\n${table(report.summary.byReviewState)}\n\n` +
    `## Interpretation and limits\n\n` +
    `- Every record emitted by \`git status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none\` is preserved. Distinct record and path counts expose rare cases where Git reports the same path more than once. Three status snapshots, two full hash passes, and repository identity/remotes must remain stable or generation fails.\n` +
    `- Hashes describe working-tree bytes only. They do not establish correctness, ownership, licensing, acceptance, or readiness to copy a path into a clean worktree.\n` +
    `- \`generated-local-artifact\` and \`local-evidence\` are conservative path-based classifications. They remain unaccepted until reviewed.\n` +
    `- Ignored files are intentionally outside Git's reviewable status set and are not inventoried. Submodule dirtiness is reported by Git but nested submodule files are not expanded.\n` +
    `- The accepted baseline identity is resolved from the supplied commit. Clean-checkout evidence is recorded separately because this generator must not mutate or reconstruct the preserved dirty checkout.\n`;
}

export function buildReport({ acceptedBaseline, sourceRepository }) {
  const repository = path.resolve(sourceRepository);
  const firstIdentity = {
    head: git(repository, ["rev-parse", "HEAD"]).trim(),
    headTree: git(repository, ["rev-parse", "HEAD^{tree}"]).trim(),
    remotes: readRemotes(repository),
  };
  const firstStatus = git(repository, STATUS_ARGS, null);
  const parsed = parsePorcelain(firstStatus)
    .map((entry) => ({
      ...entry,
      ...classifyPath(
        entry.filePath,
        entry.indexStatus,
        entry.worktreeStatus,
      ),
    }))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.filePath), Buffer.from(right.filePath)),
    );
  const entries = parsed.map((entry) => ({
    ...entry,
    ...hashEntry(repository, entry),
  }));
  const secondStatus = git(repository, STATUS_ARGS, null);
  if (!firstStatus.equals(secondStatus)) {
    throw new Error("Working-tree status changed during inventory generation");
  }
  const verificationEntries = parsed.map((entry) => ({
    ...entry,
    ...hashEntry(repository, entry),
  }));
  const thirdStatus = git(repository, STATUS_ARGS, null);
  if (!secondStatus.equals(thirdStatus)) {
    throw new Error("Working-tree status changed during inventory verification");
  }
  if (JSON.stringify(entries) !== JSON.stringify(verificationEntries)) {
    throw new Error("Working-tree content changed during inventory generation");
  }
  const secondIdentity = {
    head: git(repository, ["rev-parse", "HEAD"]).trim(),
    headTree: git(repository, ["rev-parse", "HEAD^{tree}"]).trim(),
    remotes: readRemotes(repository),
  };
  if (JSON.stringify(firstIdentity) !== JSON.stringify(secondIdentity)) {
    throw new Error("Repository identity or remotes changed during inventory generation");
  }

  const acceptedCommit = git(repository, [
    "rev-parse",
    `${acceptedBaseline}^{commit}`,
  ]).trim();
  const acceptedTree = git(repository, [
    "rev-parse",
    `${acceptedCommit}^{tree}`,
  ]).trim();
  return {
    schemaVersion: 1,
    acceptedBaseline: { commit: acceptedCommit, tree: acceptedTree },
    source: firstIdentity,
    statusCommand:
      "git status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none",
    summary: {
      byGitState: countBy(entries, "gitState"),
      byReviewState: countBy(entries, "reviewState"),
      byWorkstream: countBy(entries, "workstream"),
      entryCount: entries.length,
      pathCount: new Set(entries.map((entry) => entry.filePath)).size,
      totalBytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    },
    entries,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must be --name value pairs");
    }
    options[name.slice(2)] = value;
  }
  for (const required of [
    "accepted-baseline",
    "output-json",
    "output-markdown",
    "source-repository",
  ]) {
    if (!options[required]) throw new Error(`Missing --${required}`);
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = buildReport({
    acceptedBaseline: options["accepted-baseline"],
    sourceRepository: options["source-repository"],
  });
  writeFileSync(
    options["output-json"],
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(options["output-markdown"], renderMarkdown(report), "utf8");
  process.stdout.write(
    `Inventoried ${report.summary.entryCount} paths from ${report.source.head}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
