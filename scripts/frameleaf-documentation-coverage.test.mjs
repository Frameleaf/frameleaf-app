import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateDocumentationCoverage } from "./frameleaf-documentation-coverage.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const plan = "docs/docs/developer/frameleaf-plan";
const files = [
  `${plan}/01-agent-execution.md`,
  `${plan}/02-library-and-administration.md`,
  `${plan}/03-studio-rendering-and-restoration.md`,
  `${plan}/04-native-and-release.md`,
  `${plan}/05-delivery-and-backlog.md`,
  `${plan}/08-reproducibility.md`,
  `${plan}/action-preservation-ledger.json`,
  `${plan}/backlog.json`,
  `${plan}/confluence-mirror.json`,
  `${plan}/delivery-backlog-evidence.json`,
  `${plan}/jira-map.json`,
  `${plan}/preservation-source-evidence.json`,
  "docs/docs/developer/evidence/fl25-working-tree-baseline.json",
  "docs/docs/developer/evidence/fl25-working-tree-reconciliation.json",
];

const exists = async (target) => {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};
const copy = async (root, file) => {
  const source = path.join(repository, file);
  const stat = await exists(source);
  if (!stat) return;
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  if (stat.isDirectory()) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, ".fixture-anchor"), `${file}\n`);
  } else await cp(source, target);
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "frameleaf-doc-coverage-"));
  t.after(() =>
    rm(root, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100,
    }),
  );
  for (const file of files) await copy(root, file);
  const backlog = JSON.parse(
    await readFile(path.join(repository, `${plan}/backlog.json`)),
  );
  for (const file of new Set(backlog.items.flatMap(({ paths }) => paths)))
    await copy(root, file);
  const mirror = JSON.parse(
    await readFile(path.join(repository, `${plan}/confluence-mirror.json`)),
  );
  for (const { source } of mirror.pages) await copy(root, source);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-f", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}
async function mutateJson(root, file, mutate) {
  const target = path.join(root, file);
  const value = JSON.parse(await readFile(target, "utf8"));
  mutate(value);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

test("documentation coverage joins every reproducibility contract", async () => {
  assert.deepEqual(await validateDocumentationCoverage(), {
    confluencePages: 84,
    currentMirrorReceipts: 48,
    declaredDependencies: 434,
    epics: 28,
    historicalMirrorReceipts: 36,
    jiraIssues: 162,
    jiraLinks: 298,
    ledgerRequirements: 1199,
    ledgerSourceRows: 1219,
    sourceAnchorSha256:
      "5aeb87708d72705160fdfd24bc1430288075b10c9e7eec7bf81da50513c68c9d",
    sourceAnchors: 569,
    stories: 134,
  });
});

test("missing accepted and preserved source anchors fail closed", async (t) => {
  const root = await fixture(t);
  await mutateJson(root, `${plan}/backlog.json`, (backlog) => {
    backlog.items.find(({ id }) => id === "FN-104").paths = [
      "docs/does-not-exist-anywhere.md",
    ];
  });
  await assert.rejects(validateDocumentationCoverage(root), /real anchor/u);
});

test("an lstat-present but untracked path is not a candidate source anchor", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(
    path.join(root, "docs/untracked-present.md"),
    "not candidate evidence\n",
  );
  await mutateJson(root, `${plan}/backlog.json`, (backlog) => {
    backlog.items.find(({ id }) => id === "FN-104").paths = [
      "docs/untracked-present.md",
    ];
  });
  await assert.rejects(validateDocumentationCoverage(root), /real anchor/u);
});

test("a staged-only path is not a candidate source anchor", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(
    path.join(root, "docs/staged-only.md"),
    "staged but absent from candidate HEAD\n",
  );
  execFileSync("git", ["add", "-f", "docs/staged-only.md"], { cwd: root });
  await mutateJson(root, `${plan}/backlog.json`, (backlog) => {
    backlog.items.find(({ id }) => id === "FN-104").paths = [
      "docs/staged-only.md",
    ];
  });
  await assert.rejects(validateDocumentationCoverage(root), /real anchor/u);
});

test("invalid parents and dependency cycles fail closed", async (t) => {
  for (const mutate of [
    (backlog) =>
      (backlog.items.find(({ id }) => id === "FN-104").epicId = "FN-101"),
    (backlog) =>
      (backlog.items.find(({ id }) => id === "FN-101").dependencies = [
        "FN-104",
      ]),
  ]) {
    const root = await fixture(t);
    await mutateJson(root, `${plan}/backlog.json`, mutate);
    await assert.rejects(validateDocumentationCoverage(root));
  }
});

test("Jira identity and Blocks graph drift fail closed", async (t) => {
  for (const mutate of [
    (jira) => (jira.issues["FN-104"].id = jira.issues["FN-102"].id),
    (jira) => jira.links.pop(),
  ]) {
    const root = await fixture(t);
    await mutateJson(root, `${plan}/jira-map.json`, mutate);
    await assert.rejects(validateDocumentationCoverage(root));
  }
});

test("Confluence IDs, source receipts, and readback metadata fail closed", async (t) => {
  const cases = [
    (mirror) => (mirror.pages[0].id = "not-a-page-id"),
    (mirror) => (mirror.pages[0].sourceSha256 = "f".repeat(64)),
    (mirror) => (mirror.home.sourceSha256 = "f".repeat(64)),
    (mirror) => (mirror.hubs.audits.id = mirror.hubs.docs.id),
    (mirror) => {
      const page = mirror.pages.find(({ verified }) => verified);
      delete page.verifiedAt;
    },
    (mirror) => {
      const page = mirror.pages.find(({ verified }) => verified);
      delete page.verified;
      delete page.verification;
      delete page.verifiedAt;
    },
    (mirror) => {
      const page = mirror.pages.find(
        ({ source }) =>
          source ===
          "docs/docs/developer/frameleaf-plan/08-high-risk-workflow-designs.md",
      );
      delete page.verified;
      delete page.verification;
      delete page.verifiedAt;
    },
    (mirror) => (mirror.pages[0].id = mirror.pages[1].id),
  ];
  for (const mutate of cases) {
    const root = await fixture(t);
    await mutateJson(root, `${plan}/confluence-mirror.json`, mutate);
    await assert.rejects(validateDocumentationCoverage(root));
  }
});

test("historical mirror receipts cannot be silently promoted or rewritten", async (t) => {
  const root = await fixture(t);
  await mutateJson(
    root,
    "docs/docs/developer/evidence/fl25-working-tree-reconciliation.json",
    (receipt) => {
      receipt.entries.find(
        ({ filePath }) =>
          filePath === "docs/docs/developer/frameleaf-context-handoff.md",
      ).preservedSha256 = "0".repeat(64);
    },
  );
  await assert.rejects(
    validateDocumentationCoverage(root),
    /preserved hash drift|no exact source receipt/u,
  );
});

test("ledger reverse mappings, evidence axes, and Jira owners fail closed", async (t) => {
  const cases = [
    (ledger) => delete ledger.reverseIndex[ledger.sourceRows[0].sourceRowId],
    (ledger) => {
      const row = ledger.sourceRows[0];
      const requirement = ledger.requirements.find(
        ({ requirementId }) => requirementId === row.canonicalRequirementId,
      );
      requirement.sourceRowIds = requirement.sourceRowIds.filter(
        (sourceRowId) => sourceRowId !== row.sourceRowId,
      );
    },
    (ledger) => (ledger.sourceRows[0].mappings.tests.evidence = []),
    (ledger) => (ledger.sourceRows[0].mappings.tests.status = "   "),
    (ledger) => (ledger.sourceRows[0].mappings.tests.evidence = ["", "  "]),
    (ledger) => (ledger.requirements[0].mappings.api.status = ""),
    (ledger) => (ledger.requirements[0].mappings.api.evidence = ["  "]),
    (ledger) => (ledger.requirements[0].owners.primary.jiraKey = "FL-9999"),
  ];
  for (const mutate of cases) {
    const root = await fixture(t);
    await mutateJson(root, `${plan}/action-preservation-ledger.json`, mutate);
    await assert.rejects(validateDocumentationCoverage(root));
  }
});

test("duplicate keys are rejected in every newly joined JSON contract", async (t) => {
  for (const file of files.filter((file) => file.endsWith(".json"))) {
    const root = await fixture(t);
    const target = path.join(root, file);
    const text = await readFile(target, "utf8");
    const [firstKey] = Object.keys(JSON.parse(text));
    await writeFile(
      target,
      text.replace(/^\{/u, `{${JSON.stringify(firstKey)}:null,`),
    );
    await assert.rejects(
      validateDocumentationCoverage(root),
      /duplicate object key/u,
      file,
    );
  }
});
