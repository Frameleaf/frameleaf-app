import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseJsonRejectingDuplicateKeys,
  validateContracts,
} from "./frameleaf-delivery-backlog-contracts.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const plan = "docs/docs/developer/frameleaf-plan";
const contractFiles = [
  `${plan}/01-agent-execution.md`,
  `${plan}/02-library-and-administration.md`,
  `${plan}/03-studio-rendering-and-restoration.md`,
  `${plan}/04-native-and-release.md`,
  `${plan}/05-delivery-and-backlog.md`,
  `${plan}/15-frameleaf-cloud-integration.md`,
  `${plan}/backlog.json`,
  `${plan}/delivery-backlog-evidence.json`,
  `${plan}/jira-map.json`,
];

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "frameleaf-delivery-contracts-"),
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  for (const file of contractFiles) {
    await cp(path.join(repository, file), path.join(root, file), {
      recursive: true,
    });
  }
  return root;
}

async function mutateJson(root, file, mutate) {
  const target = path.join(root, file);
  const value = JSON.parse(await readFile(target, "utf8"));
  mutate(value);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

test("delivery and backlog contract matches the reviewed checkpoint", async () => {
  assert.deepEqual(await validateContracts(), {
    declaredEdges: 434,
    done: 29,
    epics: 28,
    inProgress: 54,
    issues: 162,
    libraryGuideRows: 53,
    nativeGuideRows: 33,
    pendingGuideRows: 0,
    reducedBlocksLinks: 298,
    stories: 134,
    studioGuideRows: 40,
    toDo: 79,
  });
});

test("duplicate keys are rejected in every contract JSON", async (t) => {
  for (const file of contractFiles.filter((file) => file.endsWith(".json"))) {
    const text = await readFile(path.join(repository, file), "utf8");
    const [firstKey] = Object.keys(JSON.parse(text));
    assert.throws(
      () =>
        parseJsonRejectingDuplicateKeys(
          text.replace(/^\{/u, `{${JSON.stringify(firstKey)}:null,`),
          file,
        ),
      /duplicate object key/u,
      file,
    );
  }
});

test("stale Jira identities are rejected", async (t) => {
  const root = await fixture(t);
  await mutateJson(root, `${plan}/jira-map.json`, (jira) => {
    jira.issues["FN-101"].key = "FL-250";
    jira.issues["FN-101"].url = "https://heroit.atlassian.net/browse/FL-250";
  });
  await assert.rejects(validateContracts(root), /sha256/u);
});

test("missing or contradictory dependency edges are rejected", async (t) => {
  const root = await fixture(t);
  await mutateJson(root, `${plan}/backlog.json`, (backlog) => {
    const row = backlog.items.find(({ id }) => id === "FN-102");
    row.dependencies = [];
  });
  await assert.rejects(validateContracts(root), /434|Blocks links/u);
});

test("false implementation and qualification claims are rejected", async (t) => {
  const root = await fixture(t);
  await mutateJson(root, `${plan}/backlog.json`, (backlog) => {
    backlog.items.find(({ id }) => id === "FN-101").status = "qualified";
  });
  await assert.rejects(validateContracts(root), /unsupported implementation/u);
});

test("contradictory known claim fields are rejected", async (t) => {
  for (const [file, mutate] of [
    [
      `${plan}/backlog.json`,
      (backlog) => (backlog.statusSemantics = "All items are Done."),
    ],
    [
      `${plan}/jira-map.json`,
      (jira) => (jira.linkEvidenceStatus = "All dependencies are accepted."),
    ],
    [
      `${plan}/delivery-backlog-evidence.json`,
      (evidence) => (evidence.observedAt = "2026-09-19T00:00:00Z"),
    ],
  ]) {
    const root = await fixture(t);
    await mutateJson(root, file, mutate);
    await assert.rejects(validateContracts(root));
  }
});

test("invented release or deployment evidence is rejected", async (t) => {
  const root = await fixture(t);
  await mutateJson(
    root,
    `${plan}/delivery-backlog-evidence.json`,
    (evidence) => {
      evidence.qualification.deploymentEvidence.push({
        environment: "production",
      });
    },
  );
  await assert.rejects(validateContracts(root));
});

test("unknown top-level, nested, and row fields are rejected", async (t) => {
  const cases = [
    [`${plan}/backlog.json`, (value) => (value.implementationQualified = true)],
    [`${plan}/jira-map.json`, (value) => (value.release = "qualified")],
    [
      `${plan}/delivery-backlog-evidence.json`,
      (value) => (value.source.queries[0].complete = true),
    ],
    [`${plan}/backlog.json`, (value) => (value.items[0].done = true)],
  ];
  for (const [file, mutate] of cases) {
    const root = await fixture(t);
    await mutateJson(root, file, mutate);
    await assert.rejects(validateContracts(root), /schema drift/u);
  }
});

test("reviewed library guide rows cannot regress to pending fallbacks", async (t) => {
  const root = await fixture(t);
  await mutateJson(root, `${plan}/backlog.json`, (backlog) => {
    const row = backlog.items.find(({ id }) => id === "LIB-001");
    row.workstreamGuide = `${plan}/01-agent-execution.md`;
  });
  await assert.rejects(
    validateContracts(root),
    /stale library guide fallback/u,
  );
});

test("reviewed Studio rows cannot regress to pending fallbacks", async (t) => {
  const root = await fixture(t);
  await mutateJson(root, `${plan}/backlog.json`, (backlog) => {
    const row = backlog.items.find(({ id }) => id === "STU-101");
    row.workstreamGuide = `${plan}/01-agent-execution.md`;
  });
  await assert.rejects(validateContracts(root), /stale Studio guide fallback/u);
});

test("reviewed native rows cannot regress to pending fallbacks", async (t) => {
  const root = await fixture(t);
  await mutateJson(root, `${plan}/backlog.json`, (backlog) => {
    const row = backlog.items.find(({ id }) => id === "MOB-100");
    row.workstreamGuide = `${plan}/01-agent-execution.md`;
  });
  await assert.rejects(validateContracts(root), /stale native guide fallback/u);
});

test("observation and delivery integration bases plus structured Jira query receipt are immutable", async (t) => {
  for (const mutate of [
    (evidence) => (evidence.observationBase = "0".repeat(40)),
    (evidence) => (evidence.observationBase = "a".repeat(40)),
    (evidence) => (evidence.deliveryIntegrationBase = "0".repeat(40)),
    (evidence) => (evidence.deliveryIntegrationBase = evidence.observationBase),
    (evidence) => (evidence.source.connector = "unverified export"),
    (evidence) => (evidence.source.queries[0].pageCounts = [142]),
  ]) {
    const root = await fixture(t);
    await mutateJson(root, `${plan}/delivery-backlog-evidence.json`, mutate);
    await assert.rejects(validateContracts(root));
  }
});

test("normalized live Jira snapshot digest rejects status or link forgery", async (t) => {
  const root = await fixture(t);
  await mutateJson(
    root,
    `${plan}/delivery-backlog-evidence.json`,
    (evidence) => {
      evidence.source.normalizedSnapshotSha256 = "f".repeat(64);
    },
  );
  await assert.rejects(validateContracts(root));
});

test("REL-201 exception requires exact status, dependency, timestamp, and gaps", async (t) => {
  for (const [file, mutate] of [
    [
      `${plan}/backlog.json`,
      (backlog) =>
        (backlog.items.find(({ id }) => id === "REL-201").dependencies = []),
    ],
    [
      `${plan}/backlog.json`,
      (backlog) =>
        (backlog.items.find(({ id }) => id === "REL-201").jiraStatusObservedAt =
          "2026-09-20T08:20:00Z"),
    ],
    [
      `${plan}/delivery-backlog-evidence.json`,
      (evidence) => (evidence.deliveryExceptions[0].jiraStatus = "To Do"),
    ],
    [
      `${plan}/delivery-backlog-evidence.json`,
      (evidence) => evidence.deliveryExceptions[0].openQualificationGaps.pop(),
    ],
  ]) {
    const root = await fixture(t);
    await mutateJson(root, file, mutate);
    await assert.rejects(validateContracts(root));
  }
});

test("contradictory narrative completion claims are rejected", async (t) => {
  for (const claim of [
    "All issues are qualified.",
    "REL-201 is fully qualified.",
    "This contract proves deployment.",
  ]) {
    const root = await fixture(t);
    const target = path.join(root, `${plan}/05-delivery-and-backlog.md`);
    await writeFile(target, `${await readFile(target, "utf8")}\n${claim}\n`);
    await assert.rejects(validateContracts(root), /contradictory/u);
  }
});
