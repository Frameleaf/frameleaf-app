#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PLAN = "docs/docs/developer/frameleaf-plan";
const FILES = {
  backlog: `${PLAN}/backlog.json`,
  evidence: `${PLAN}/delivery-backlog-evidence.json`,
  jira: `${PLAN}/jira-map.json`,
  narrative: `${PLAN}/05-delivery-and-backlog.md`,
};
const OBSERVATION_BASE = "b934907b9a53e8367174e3822b119d99584bcbe6";
const DELIVERY_INTEGRATION_BASE = "7941bd6bc6dfbbb0f4c19fb570128d75432414b6";
const EXECUTION_GUIDE = `${PLAN}/01-agent-execution.md`;
const LIBRARY_GUIDE = `${PLAN}/02-library-and-administration.md`;
const STUDIO_GUIDE = `${PLAN}/03-studio-rendering-and-restoration.md`;
const NATIVE_GUIDE = `${PLAN}/04-native-and-release.md`;
const BASE_ITEM_KEYS = [
  "acceptance",
  "dependencies",
  "epicId",
  "executionGuide",
  "id",
  "objective",
  "paths",
  "phase",
  "priority",
  "risks",
  "sourcePhase",
  "status",
  "tests",
  "title",
  "type",
  "workstream",
  "workstreamGuide",
];
const OPEN_QUALIFICATION_GAPS = [
  "GitHub administrator-review bypass remains separate from workflow delivery.",
  "GitHub-generated merge committer identity remains separately constrained.",
  "GHCR anonymous visibility remains unqualified.",
  "Runtime deployment and application/media qualification remain unqualified.",
];
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

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

const readJson = async (root, file) =>
  parseJsonRejectingDuplicateKeys(
    await readFile(path.join(root, file), "utf8"),
    file,
  );
function assertExactKeys(value, keys, label) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${label}: expected object`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label}: schema drift`,
  );
}
function assertStringArray(value, label) {
  assert.ok(Array.isArray(value), `${label}: expected array`);
  assert.ok(
    value.every((entry) => typeof entry === "string"),
    `${label}: expected strings`,
  );
}
function reduceEdges(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const memo = new Map();
  const visiting = new Set();
  const ancestors = (id) => {
    if (memo.has(id)) return memo.get(id);
    assert.ok(!visiting.has(id), `Dependency cycle at ${id}`);
    visiting.add(id);
    const result = new Set();
    for (const dependency of byId.get(id).dependencies) {
      assert.ok(
        byId.has(dependency),
        `${id}: missing dependency ${dependency}`,
      );
      result.add(dependency);
      for (const ancestor of ancestors(dependency)) result.add(ancestor);
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  for (const id of byId.keys()) ancestors(id);
  return items.flatMap((item) => {
    const indirect = new Set();
    for (const dependency of item.dependencies)
      for (const ancestor of ancestors(dependency)) indirect.add(ancestor);
    return item.dependencies
      .filter((dependency) => !indirect.has(dependency))
      .map((dependency) => [dependency, item.id]);
  });
}

export async function validateContracts(root = repository) {
  const [backlog, jira, evidence, narrative] = await Promise.all([
    readJson(root, FILES.backlog),
    readJson(root, FILES.jira),
    readJson(root, FILES.evidence),
    readFile(path.join(root, FILES.narrative), "utf8"),
  ]);
  assertExactKeys(
    backlog,
    [
      "baselineHead",
      "baselineIncludesUncommittedWork",
      "defaultBranchObserved",
      "items",
      "projectKey",
      "repository",
      "schemaVersion",
      "statusSemantics",
      "topologicalOrder",
    ],
    "backlog",
  );
  assertExactKeys(
    jira,
    [
      "cloudId",
      "issues",
      "linkEvidence",
      "linkEvidenceStatus",
      "links",
      "linkStrategy",
      "projectKey",
    ],
    "jira-map",
  );
  assertExactKeys(
    evidence,
    [
      "defaultBranch",
      "deliveryIntegrationBase",
      "deliveryExceptions",
      "dependencyContract",
      "identityContract",
      "observationBase",
      "observedAt",
      "qualification",
      "repository",
      "schemaVersion",
      "source",
      "workflowSnapshot",
    ],
    "delivery evidence",
  );
  assertExactKeys(
    evidence.identityContract,
    ["epics", "issues", "sha256", "stories"],
    "identityContract",
  );
  assertExactKeys(
    evidence.workflowSnapshot,
    ["counts", "done", "inProgress"],
    "workflowSnapshot",
  );
  assertExactKeys(
    evidence.workflowSnapshot.counts,
    ["Done", "In Progress", "To Do"],
    "workflow counts",
  );
  assertExactKeys(
    evidence.dependencyContract,
    [
      "declaredEdges",
      "declaredEdgesSha256",
      "liveBlocksLinks",
      "liveMatchesReducedGraph",
      "reducedBlocksLinks",
      "reducedBlocksLinksSha256",
    ],
    "dependencyContract",
  );
  assertExactKeys(
    evidence.qualification,
    [
      "deploymentEvidence",
      "implementationQualified",
      "note",
      "releaseEvidence",
    ],
    "qualification",
  );
  assertExactKeys(
    evidence.source,
    ["cloudId", "connector", "normalizedSnapshotSha256", "queries"],
    "source",
  );

  assert.equal(backlog.repository, "Frameleaf/frameleaf-app");
  assert.equal(backlog.schemaVersion, 1);
  assert.equal(backlog.defaultBranchObserved, "fork/main");
  assert.equal(backlog.projectKey, "FL");
  assert.equal(
    backlog.baselineHead,
    "91d5dfe0f829d15d122c1a8b2bbc474fc195dbaf",
  );
  assert.equal(backlog.baselineIncludesUncommittedWork, true);
  assert.equal(
    backlog.statusSemantics,
    "The per-item status records local delivery qualification, not Jira workflow state. Jira remains authoritative for To Do, In Progress, and Done.",
  );
  assert.equal(backlog.items.length, 142);
  assert.equal(new Set(backlog.items.map(({ id }) => id)).size, 142);
  const byId = new Map(backlog.items.map((item) => [item.id, item]));
  assert.equal(backlog.items.filter(({ type }) => type === "epic").length, 24);
  assert.equal(
    backlog.items.filter(({ type }) => type === "story").length,
    118,
  );
  for (const item of backlog.items) {
    const expectedKeys = [
      ...BASE_ITEM_KEYS,
      ...(item.id === "REL-201"
        ? ["jiraStatusObserved", "jiraStatusObservedAt"]
        : []),
    ];
    assertExactKeys(item, expectedKeys, `backlog item ${item.id}`);
    assert.ok(
      ["epic", "story"].includes(item.type),
      `${item.id}: invalid type`,
    );
    for (const field of [
      "id",
      "title",
      "objective",
      "priority",
      "executionGuide",
      "workstreamGuide",
      "status",
      "workstream",
    ]) {
      assert.equal(
        typeof item[field],
        "string",
        `${item.id}.${field}: expected string`,
      );
      assert.ok(item[field], `${item.id}.${field}: empty string`);
    }
    assert.ok(
      Number.isInteger(item.phase) && item.phase >= 1 && item.phase <= 6,
      `${item.id}: invalid phase`,
    );
    assert.ok(
      item.epicId === null || typeof item.epicId === "string",
      `${item.id}: invalid epicId`,
    );
    assert.ok(
      ["string", "number"].includes(typeof item.sourcePhase),
      `${item.id}: invalid sourcePhase`,
    );
    for (const field of [
      "dependencies",
      "paths",
      "acceptance",
      "tests",
      "risks",
    ])
      assertStringArray(item[field], `${item.id}.${field}`);
    for (const field of ["paths", "acceptance", "tests"])
      assert.ok(item[field].length > 0, `${item.id}.${field}: empty`);
    assert.equal(
      new Set(item.dependencies).size,
      item.dependencies.length,
      `${item.id}: duplicate dependency`,
    );
    assert.ok(
      !item.dependencies.includes(item.id),
      `${item.id}: self dependency`,
    );
    if (item.type === "story")
      assert.equal(
        byId.get(item.epicId)?.type,
        "epic",
        `${item.id}: invalid epic`,
      );
    assert.equal(
      item.executionGuide,
      EXECUTION_GUIDE,
      `${item.id}: execution guide drifted`,
    );
    if (item.workstream === "library")
      assert.equal(
        item.workstreamGuide,
        LIBRARY_GUIDE,
        `${item.id}: stale library guide fallback`,
      );
    else if (item.workstream === "studio")
      assert.equal(
        item.workstreamGuide,
        STUDIO_GUIDE,
        `${item.id}: stale Studio guide fallback`,
      );
    else if (item.workstream === "native")
      assert.equal(
        item.workstreamGuide,
        NATIVE_GUIDE,
        `${item.id}: stale native guide fallback`,
      );
    else {
      assert.equal(
        item.workstream,
        "foundation",
        `${item.id}: unknown workstream`,
      );
      assert.equal(item.workstreamGuide, EXECUTION_GUIDE);
    }
  }
  for (const guide of [
    EXECUTION_GUIDE,
    LIBRARY_GUIDE,
    STUDIO_GUIDE,
    NATIVE_GUIDE,
  ])
    await readFile(path.join(root, guide), "utf8");

  const declared = backlog.items.flatMap((item) =>
    item.dependencies.map((dependency) => [dependency, item.id]),
  );
  const reduced = reduceEdges(backlog.items);
  assert.equal(declared.length, 408);
  assert.equal(reduced.length, 275);
  assert.deepEqual(
    jira.links,
    reduced,
    "Jira Blocks links differ from graph reduction",
  );
  assert.equal(backlog.topologicalOrder.length, 142);
  assert.deepEqual(new Set(backlog.topologicalOrder), new Set(byId.keys()));
  const positions = new Map(
    backlog.topologicalOrder.map((id, index) => [id, index]),
  );
  for (const [dependency, dependent] of declared)
    assert.ok(
      positions.get(dependency) < positions.get(dependent),
      `${dependency} must precede ${dependent}`,
    );

  assert.equal(jira.projectKey, "FL");
  assert.equal(jira.cloudId, "9b68c4fc-dbd2-4864-a050-674c27f779b2");
  assert.deepEqual(jira.linkEvidence, []);
  assert.equal(
    jira.linkStrategy,
    "Transitive reduction: 275 Blocks links preserve all 408 declared dependency relationships.",
  );
  assert.equal(
    jira.linkEvidenceStatus,
    "Live Jira comparison details are recorded in delivery-backlog-evidence.json; the 275 Blocks links matched this transitive reduction on 2026-09-20. Workflow and link publication are not implementation qualification.",
  );
  assert.deepEqual(Object.keys(jira.issues).sort(), [...byId.keys()].sort());
  const jiraIds = new Set();
  const jiraKeys = new Set();
  const jiraUrls = new Set();
  const identities = [];
  for (const item of backlog.items) {
    const mapping = jira.issues[item.id];
    assertExactKeys(mapping, ["id", "key", "url"], `Jira mapping ${item.id}`);
    assert.match(mapping.id, /^\d+$/u);
    assert.match(mapping.key, /^FL-[1-9]\d*$/u);
    assert.equal(
      mapping.url,
      `https://heroit.atlassian.net/browse/${mapping.key}`,
    );
    assert.ok(!jiraIds.has(mapping.id), `duplicate Jira id ${mapping.id}`);
    assert.ok(!jiraKeys.has(mapping.key), `duplicate Jira key ${mapping.key}`);
    assert.ok(!jiraUrls.has(mapping.url), `duplicate Jira URL ${mapping.url}`);
    jiraIds.add(mapping.id);
    jiraKeys.add(mapping.key);
    jiraUrls.add(mapping.url);
    identities.push({
      planId: item.id,
      id: mapping.id,
      key: mapping.key,
      url: mapping.url,
      title: item.title,
      type: item.type,
      parentPlanId: item.epicId ?? null,
    });
  }

  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.repository, backlog.repository);
  assert.equal(evidence.defaultBranch, backlog.defaultBranchObserved);
  assert.equal(evidence.observedAt, "2026-09-20T09:51:33Z");
  assert.equal(evidence.observationBase, OBSERVATION_BASE);
  assert.equal(evidence.deliveryIntegrationBase, DELIVERY_INTEGRATION_BASE);
  assert.notEqual(evidence.observationBase, evidence.deliveryIntegrationBase);
  assert.deepEqual(evidence.identityContract, {
    issues: 142,
    epics: 24,
    stories: 118,
    sha256: digest(identities),
  });
  assert.deepEqual(evidence.workflowSnapshot, {
    counts: { "To Do": 140, "In Progress": 1, Done: 1 },
    inProgress: ["FL-25"],
    done: ["FL-118"],
  });
  assert.deepEqual(evidence.dependencyContract, {
    declaredEdges: 408,
    declaredEdgesSha256: digest(declared),
    reducedBlocksLinks: 275,
    reducedBlocksLinksSha256: digest(reduced),
    liveBlocksLinks: 275,
    liveMatchesReducedGraph: true,
  });
  assert.deepEqual(evidence.qualification, {
    implementationQualified: false,
    releaseEvidence: [],
    deploymentEvidence: [],
    note: "Issue workflow state and link publication are not implementation, release, or deployment evidence.",
  });

  const expectedQueries = [
    {
      purpose: "identity-status",
      jql: "project = FL ORDER BY created ASC",
      order: "created ASC",
      fields: ["summary", "status", "issuetype", "parent", "labels"],
      pageSize: 100,
      pageCounts: [100, 42],
      pageBoundaries: [
        ["FL-1", "FL-100"],
        ["FL-101", "FL-142"],
      ],
    },
    {
      purpose: "blocks-links",
      jql: "project = FL ORDER BY created ASC",
      order: "created ASC",
      fields: ["issuelinks"],
      pageSize: 100,
      pageCounts: [100, 42],
      pageBoundaries: [
        ["FL-1", "FL-100"],
        ["FL-101", "FL-142"],
      ],
    },
  ];
  assert.equal(evidence.source.connector, "Atlassian Rovo Jira");
  assert.equal(evidence.source.cloudId, jira.cloudId);
  for (const [index, query] of evidence.source.queries.entries())
    assertExactKeys(
      query,
      [
        "fields",
        "jql",
        "order",
        "pageBoundaries",
        "pageCounts",
        "pageSize",
        "purpose",
      ],
      `source query ${index}`,
    );
  assert.deepEqual(evidence.source.queries, expectedQueries);
  const liveStatuses = new Map([
    ["FL-25", "In Progress"],
    ["FL-118", "Done"],
  ]);
  const normalizedSnapshot = {
    issues: backlog.items.map((item) => {
      const mapping = jira.issues[item.id];
      return {
        id: mapping.id,
        key: mapping.key,
        planId: item.id,
        status: liveStatuses.get(mapping.key) ?? "To Do",
        summary: `[${item.id}] ${item.title}`,
        type: item.type === "epic" ? "Epic" : "Story",
        parentKey: item.epicId ? jira.issues[item.epicId].key : null,
      };
    }),
    blocks: reduced.map(([from, to]) => [
      jira.issues[from].key,
      jira.issues[to].key,
    ]),
  };
  assert.equal(
    evidence.source.normalizedSnapshotSha256,
    digest(normalizedSnapshot),
  );

  const exceptional = backlog.items.filter(
    ({ status }) => status !== "planned-not-qualified",
  );
  assert.deepEqual(
    exceptional.map(({ id, status }) => [id, status]),
    [["REL-201", "delivered-with-open-qualification-gaps"]],
    "Backlog contains an unsupported implementation/qualification claim",
  );
  const rel201 = byId.get("REL-201");
  assert.deepEqual(rel201.dependencies, ["FN-101"]);
  assert.equal(rel201.jiraStatusObserved, "Done");
  assert.equal(rel201.jiraStatusObservedAt, "2026-09-20T07:31:09.027Z");
  assert.equal(jira.issues["FN-101"].key, "FL-25");
  assert.equal(jira.issues["REL-201"].key, "FL-118");
  assert.equal(evidence.deliveryExceptions.length, 1);
  const [deliveryException] = evidence.deliveryExceptions;
  assertExactKeys(
    deliveryException,
    [
      "dependencies",
      "jiraKey",
      "jiraStatus",
      "jiraStatusChangedAt",
      "openQualificationGaps",
      "planId",
    ],
    "delivery exception",
  );
  assert.deepEqual(deliveryException, {
    planId: "REL-201",
    jiraKey: "FL-118",
    jiraStatus: "Done",
    jiraStatusChangedAt: "2026-09-20T07:31:09.027Z",
    dependencies: ["FN-101"],
    openQualificationGaps: OPEN_QUALIFICATION_GAPS,
  });
  assert.deepEqual(
    backlog.items
      .filter(
        ({ type, dependencies }) =>
          type === "story" && dependencies.length === 0,
      )
      .map(({ id }) => id),
    ["FN-101"],
  );

  for (const statement of [
    "FL-25 accepts preservation and classification evidence",
    "FL-26 owns action- and requirement-level coverage",
    "No item is `qualified`, `released`, or `deployed`",
    "Confluence publication is documentation synchronization",
    "No product feature implementation, browser/device/media/hardware parity",
  ])
    assert.ok(
      narrative.includes(statement),
      `Narrative lost required boundary: ${statement}`,
    );
  assert.doesNotMatch(
    narrative,
    /\b(?:all|every) (?:items?|issues?|stories?) (?:are|is|have been) (?:implemented|qualified|released|deployed|done)\b|\b(?:FL-\d+|[A-Z]+-\d+) (?:is|was|has been) (?:fully )?(?:implemented|qualified|released|deployed|complete|done)\b|\bthis (?:slice|contract) (?:implemented|qualified|released|deployed|proves deployment)\b/iu,
    "Narrative contains a contradictory implementation/qualification claim",
  );

  return {
    declaredEdges: declared.length,
    done: evidence.workflowSnapshot.done.length,
    epics: 24,
    inProgress: evidence.workflowSnapshot.inProgress.length,
    issues: backlog.items.length,
    libraryGuideRows: backlog.items.filter(
      ({ workstream }) => workstream === "library",
    ).length,
    nativeGuideRows: backlog.items.filter(
      ({ workstream }) => workstream === "native",
    ).length,
    studioGuideRows: backlog.items.filter(
      ({ workstream }) => workstream === "studio",
    ).length,
    pendingGuideRows: backlog.items.filter(
      (item) =>
        Object.hasOwn(item, "pendingWorkstreamGuide") ||
        Object.hasOwn(item, "workstreamGuideStatus"),
    ).length,
    reducedBlocksLinks: reduced.length,
    stories: 118,
    toDo: evidence.workflowSnapshot.counts["To Do"],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : repository;
  const result = await validateContracts(root);
  console.log(
    `Validated ${result.issues} issues (${result.epics} epics, ${result.stories} stories), ${result.declaredEdges} declared dependencies, ${result.reducedBlocksLinks} Blocks links; ${result.libraryGuideRows} reviewed library guides, ${result.studioGuideRows} reviewed Studio guides, ${result.nativeGuideRows} reviewed native guides, ${result.pendingGuideRows} pending guides; Jira snapshot ${result.toDo} To Do, ${result.inProgress} In Progress, ${result.done} Done.`,
  );
}
