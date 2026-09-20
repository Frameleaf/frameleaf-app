#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BASELINE = "docs/docs/developer/evidence/fl25-working-tree-baseline.json";
const BACKLOG = "docs/docs/developer/frameleaf-plan/backlog.json";
const JIRA = "docs/docs/developer/frameleaf-plan/jira-map.json";
const NATIVE = "docs/docs/developer/frameleaf-plan/native-issue-map.json";
const FREECUT_MANIFEST = "studio/freecut-feature-manifest.json";
const FREECUT_MAP = "docs/docs/developer/frameleaf-plan/freecut-issue-map.json";
const DEFAULT_OUTPUT =
  "docs/docs/developer/evidence/fl25-working-tree-reconciliation.json";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (root, args, encoding = "utf8") =>
  execFileSync("git", ["-C", root, ...args], {
    encoding,
    maxBuffer: 256 * 1024 * 1024,
  });

export function parseJsonRejectingDuplicateKeys(text, source = "JSON input") {
  let index = 0;
  const fail = (message) => {
    throw new SyntaxError(`${source}: ${message} at byte ${index}`);
  };
  const whitespace = () => {
    while (/\s/u.test(text[index] ?? "")) index++;
  };
  const string = () => {
    if (text[index] !== '"') fail("expected string");
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"')
        return JSON.parse(text.slice(start, index));
    }
    fail("unterminated string");
  };
  const value = () => {
    whitespace();
    if (text[index] === "{") {
      index++;
      whitespace();
      const keys = new Set();
      if (text[index] === "}") return void index++;
      while (index < text.length) {
        const key = string();
        if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") fail("expected colon");
        value();
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "}") return;
        if (delimiter !== ",") fail("expected object delimiter");
        whitespace();
      }
      fail("unterminated object");
    }
    if (text[index] === "[") {
      index++;
      whitespace();
      if (text[index] === "]") return void index++;
      while (index < text.length) {
        value();
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "]") return;
        if (delimiter !== ",") fail("expected array delimiter");
      }
      fail("unterminated array");
    }
    if (text[index] === '"') return void string();
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = text
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!number) fail("expected value");
    index += number.length;
  };
  value();
  whitespace();
  if (index !== text.length) fail("unexpected trailing content");
  return JSON.parse(text);
}

function readJson(root, file) {
  return parseJsonRejectingDuplicateKeys(
    readFileSync(path.join(root, file), "utf8"),
    file,
  );
}

function treeEntries(root, revision) {
  const records = git(
    root,
    ["ls-tree", "-r", "-z", "--full-tree", revision],
    null,
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return new Map(
    records.map((record) => {
      const match = record.match(/^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/u);
      assert.ok(match, `Invalid ls-tree record: ${record}`);
      return [
        match[4],
        { mode: match[1], objectType: match[2], objectId: match[3] },
      ];
    }),
  );
}

function addOwner(index, filePath, planId, jira, backlogById) {
  const item = backlogById.get(planId);
  const issue = jira.issues[planId];
  if (!item || !issue) return;
  const owners = index.get(filePath) ?? new Map();
  owners.set(planId, {
    jiraKey: issue.key,
    planId,
    workstream: item.workstream,
  });
  index.set(filePath, owners);
}

function ownershipIndex({
  backlog,
  freecutManifest,
  freecutMap,
  jira,
  native,
}) {
  const index = new Map();
  const backlogById = new Map(backlog.items.map((item) => [item.id, item]));
  for (const item of backlog.items) {
    for (const filePath of item.paths) {
      addOwner(index, filePath, item.id, jira, backlogById);
    }
  }
  for (const entry of native.entries) {
    for (const planId of [entry.primaryIssueId, ...entry.secondaryIssueIds]) {
      addOwner(index, entry.source, planId, jira, backlogById);
    }
  }
  const freecutIssues = new Map(
    freecutMap.rows.map((row) => [row.id, row.issueIds]),
  );
  for (const feature of freecutManifest.features) {
    const issueIds = freecutIssues.get(feature.id) ?? [];
    for (const source of feature.source) {
      const filePath = `studio/${source.path}`;
      for (const planId of issueIds) {
        addOwner(index, filePath, planId, jira, backlogById);
      }
    }
  }
  return new Map(
    [...index].map(([filePath, owners]) => [
      filePath,
      [...owners.values()].sort((left, right) =>
        left.planId.localeCompare(right.planId),
      ),
    ]),
  );
}

const sortObject = (value) => {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])]),
  );
};

export function serializeCanonical(value) {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

export function buildReconciliation({ currentMain, root = repository }) {
  const files = [
    BASELINE,
    BACKLOG,
    JIRA,
    NATIVE,
    FREECUT_MANIFEST,
    FREECUT_MAP,
  ];
  const [baseline, backlog, jira, native, freecutManifest, freecutMap] =
    files.map((file) => readJson(root, file));
  assert.equal(baseline.summary.entryCount, 3520);
  assert.equal(baseline.summary.pathCount, 3520);
  assert.equal(baseline.summary.byReviewState["unreviewed-local-change"], 3518);
  assert.equal(baseline.summary.byReviewState["local-evidence"], 2);
  const baselinePaths = baseline.entries.map(({ filePath }) => filePath);
  assert.equal(
    new Set(baselinePaths).size,
    3520,
    "Baseline paths must be unique",
  );
  assert.deepEqual(
    baselinePaths,
    [...baselinePaths].sort(),
    "Baseline path order drifted",
  );

  const commit = git(root, ["rev-parse", `${currentMain}^{commit}`]).trim();
  const tree = git(root, ["rev-parse", `${commit}^{tree}`]).trim();
  const tracked = treeEntries(root, commit);
  const owners = ownershipIndex({
    backlog,
    freecutManifest,
    freecutMap,
    jira,
    native,
  });
  const entries = baseline.entries.map((entry) => {
    const main = tracked.get(entry.filePath);
    let mainBlobBytes = null;
    let mainBlobSha256 = null;
    let mainBlobRelation = "absent";
    if (main) {
      assert.equal(
        main.objectType,
        "blob",
        `${entry.filePath}: expected main blob`,
      );
      const bytes = git(root, ["cat-file", "blob", main.objectId], null);
      mainBlobBytes = bytes.length;
      mainBlobSha256 = digest(bytes);
      mainBlobRelation =
        mainBlobSha256 === entry.sha256 ? "identical" : "different";
    }
    return {
      disposition:
        mainBlobRelation === "identical"
          ? "already-represented"
          : "preserved-only-unaccepted",
      filePath: entry.filePath,
      futureOwners: owners.get(entry.filePath) ?? [],
      mainBlobBytes,
      mainBlobRelation,
      mainBlobSha256,
      preservedBytes: entry.bytes,
      preservedReviewState: entry.reviewState,
      preservedSha256: entry.sha256,
      workstream: entry.workstream,
    };
  });
  const count = (field, value) =>
    entries.filter((entry) => entry[field] === value).length;
  const summary = {
    alreadyRepresented: count("disposition", "already-represented"),
    mainBlobAbsent: count("mainBlobRelation", "absent"),
    mainBlobDifferent: count("mainBlobRelation", "different"),
    mainBlobIdentical: count("mainBlobRelation", "identical"),
    pathCount: entries.length,
    preservedOnlyUnaccepted: count("disposition", "preserved-only-unaccepted"),
    withFutureOwners: entries.filter(
      ({ futureOwners }) => futureOwners.length > 0,
    ).length,
    withoutFutureOwners: entries.filter(
      ({ futureOwners }) => futureOwners.length === 0,
    ).length,
  };
  assert.deepEqual(summary, {
    alreadyRepresented: 164,
    mainBlobAbsent: 3164,
    mainBlobDifferent: 192,
    mainBlobIdentical: 164,
    pathCount: 3520,
    preservedOnlyUnaccepted: 3356,
    withFutureOwners: summary.withFutureOwners,
    withoutFutureOwners: summary.withoutFutureOwners,
  });
  assert.equal(summary.withFutureOwners + summary.withoutFutureOwners, 3520);
  return {
    currentMain: { commit, tree },
    entries,
    interpretation: {
      acceptance:
        "No preserved dirty-checkout source is accepted by this receipt. Future ownership is routing metadata only.",
      alreadyRepresented:
        "The preserved bytes are identical to the blob at the exact current-main commit.",
      preservedOnlyUnaccepted:
        "The path is absent from current main or its preserved bytes differ from current main; the preserved bytes remain unaccepted evidence.",
      reviewState:
        "The prior 3,518 count describes review-state labels: 3,518 unreviewed-local-change plus two local-evidence paths. It is not the current-main disposition count.",
    },
    schemaVersion: 1,
    sourceInventory: {
      acceptedBaseline: baseline.acceptedBaseline.commit,
      path: BASELINE,
      sha256: digest(readFileSync(path.join(root, BASELINE))),
      sourceHead: baseline.source.head,
    },
    summary,
  };
}

export function validateReconciliation(
  report,
  { currentMain, root = repository },
) {
  assert.deepEqual(report, buildReconciliation({ currentMain, root }));
  return report.summary;
}

function parseArguments(argv) {
  const result = { check: false, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--check") result.check = true;
    else if (argument === "--current-main") result.currentMain = argv[++index];
    else if (argument === "--output") result.output = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.currentMain) throw new Error("Missing --current-main");
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = buildReconciliation({ currentMain: options.currentMain });
  const output = path.join(repository, options.output);
  const serialized = serializeCanonical(report);
  if (options.check) {
    const existing = readFileSync(output, "utf8");
    parseJsonRejectingDuplicateKeys(existing, options.output);
    assert.equal(
      existing,
      serialized,
      `${options.output} is not canonical or current`,
    );
  } else {
    writeFileSync(output, serialized, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
