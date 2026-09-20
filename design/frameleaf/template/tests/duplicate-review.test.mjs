import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialUtilities,
  applyUtilityAction,
  parseUtilities,
} from "../src/utilities-data.mjs";
import {
  deriveDuplicateGroups,
  applyDuplicateDecision,
  createDuplicateUndo,
  applyDuplicateUndo,
  nextDuplicateGroup,
} from "../src/duplicate-review.mjs";
const actorId = "taylor",
  at = "2026-09-19T13:00:00Z";
const groups = (state, options = {}) =>
  deriveDuplicateGroups(state.rows, { actorId, owner: "taylor", ...options });
const decide = (state, decision, more = {}) =>
  applyDuplicateDecision(state, {
    groupIds: ["lake"],
    decision,
    actorId,
    at,
    ...more,
  });

test("filename/status filters preserve full fixed group membership", () => {
  const state = initialUtilities();
  const found = groups(state, { query: "copy.jpg" }).find(
    (group) => group.id === "lake",
  );
  assert.deepEqual(found.ids, ["dup-raw", "dup-jpg"]);
  assert.equal(found.rows.length, 2);
  state.rows.find((row) => row.id === "dup-jpg").status = "Trashed";
  const open = groups(state).find((group) => group.id === "lake");
  assert.equal(open.rows.length, 2);
  assert.equal(open.status, "Mixed");
  assert.equal(
    groups(state, { status: "Trashed" }).find((group) => group.id === "lake")
      .rows.length,
    2,
  );
  assert.equal(groups(state, { owner: "new-account" }).length, 0);
});

test("a mixed-owner group is entirely hidden and cannot be partially mutated", () => {
  const state = initialUtilities();
  state.rows.find((row) => row.id === "dup-jpg").ownerId = "jamie";
  const found = groups(state).find((group) => group.id === "lake");
  assert.equal(found, undefined);
  for (const query of ["Moraine Lake", "Moraine Lake copy.jpg", "lake"])
    assert.deepEqual(groups(state, { owner: "all", query }), []);
  const before = structuredClone(state);
  assert.throws(
    () => decide(state, "keep-all", { groupIds: ["forest", "lake"] }),
    /owner of every/,
  );
  assert.deepEqual(state, before);
  assert.throws(
    () => decide(state, "stack", { groupIds: ["hike"] }),
    /owner of every/,
  );
});

test("all-account duplicate results contain only the actor's complete groups and evidence", () => {
  const state = initialUtilities();
  const found = groups(state, { owner: "all", status: "all" });
  assert.deepEqual(
    found.map((group) => group.id),
    ["lake", "forest", "campfire", "forest-burst"],
  );
  const foreign = state.rows.filter(
    (row) => row.tool === "duplicates" && row.ownerId !== actorId,
  );
  for (const row of foreign) {
    assert.ok(!JSON.stringify(found).includes(row.id));
    assert.ok(!JSON.stringify(found).includes(row.name));
  }
  assert.ok(
    found.every((group) => group.rows.every((row) => row.ownerId === actorId)),
  );
  assert.ok(
    found.every((group) =>
      group.expected.refs.every((row) => row.ownerId === actorId),
    ),
  );
  assert.deepEqual(groups(state, { owner: "all", query: "Hiking" }), []);
  assert.deepEqual(groups(state, { owner: "all", query: "Jamie" }), []);
});

test("a foreign viewing scope or absent actor cannot expose duplicate groups", () => {
  const state = initialUtilities();
  assert.deepEqual(groups(state, { owner: "jamie" }), []);
  assert.deepEqual(groups(state, { owner: "emma", status: "all" }), []);
  for (const actorId of ["", null]) {
    assert.deepEqual(
      deriveDuplicateGroups(state.rows, { owner: "all", actorId }),
      [],
    );
  }
});

test("a different logged-in actor sees and updates only that actor's groups", () => {
  const state = initialUtilities();
  const found = deriveDuplicateGroups(state.rows, {
    actorId: "jamie",
    owner: "all",
  });
  assert.deepEqual(
    found.map((group) => group.id),
    ["hike"],
  );
  assert.equal(found[0].editable, true);
  assert.deepEqual(
    deriveDuplicateGroups(state.rows, { actorId: "jamie", owner: "taylor" }),
    [],
  );
  const next = applyDuplicateDecision(state, {
    actorId: "jamie",
    groupIds: ["hike"],
    decision: "stack",
    expectedGroups: found.map((group) => group.expected),
    at,
  });
  assert.ok(
    next.rows
      .filter((row) => row.group === "hike")
      .every((row) => row.status === "Stacked"),
  );
  assert.deepEqual(
    next.rows.filter((row) => row.ownerId !== "jamie"),
    state.rows.filter((row) => row.ownerId !== "jamie"),
  );
  const patch = createDuplicateUndo(state, next, ["hike"]);
  assert.throws(() => applyDuplicateUndo(next, patch), /original owner/);
  assert.throws(
    () => applyDuplicateUndo(next, patch, { actorId: "emma", at }),
    /original owner/,
  );
  assert.deepEqual(
    applyDuplicateUndo(next, patch, { actorId: "jamie", at }).rows,
    state.rows,
  );
  const forged = structuredClone(patch);
  forged.before[0].ownerId = "taylor";
  assert.throws(
    () => applyDuplicateUndo(next, forged, { actorId: "jamie", at }),
    /original owner/,
  );
});

test("suggestions require exactly one keeper per group and never silently break ties", () => {
  for (const suggested of [true, false]) {
    const state = initialUtilities();
    for (const row of state.rows.filter((row) => row.group === "lake"))
      row.suggested = suggested;
    const group = groups(state).find((item) => item.id === "lake");
    assert.equal(group.suggestedKeeperId, null);
    assert.equal(group.canSuggest, false);
    assert.equal(group.rows.filter((row) => row.suggested).length, 0);
    assert.throws(() => decide(state, "suggested"), /exactly one/);
  }
});

test("bulk suggested choices apply atomically with one friendly history record", () => {
  const state = initialUtilities(),
    snapshot = structuredClone(state);
  const own = groups(state).filter((group) => group.kind !== "burst");
  assert.equal(own.length, 3);
  const next = decide(state, "suggested", {
    groupIds: own.map((group) => group.id),
    expectedGroups: own.map((group) => group.expected),
  });
  assert.deepEqual(state, snapshot);
  assert.equal(next.history.length, 1);
  assert.match(
    next.history[0].title,
    /^Kept suggested photos · 3 groups · 6 photos$/,
  );
  for (const group of own)
    for (const id of group.ids)
      assert.equal(
        next.rows.find((row) => row.id === id).status,
        id === group.suggestedKeeperId ? "Kept" : "Trashed",
      );
  assert.deepEqual(
    next.rows.find((row) => row.id === "dup-hike"),
    state.rows.find((row) => row.id === "dup-hike"),
  );
  assert.equal(
    groups(next).filter((group) => group.kind !== "burst").length,
    0,
  );
  assert.equal(
    groups(parseUtilities(JSON.stringify(next))).filter(
      (group) => group.kind !== "burst",
    ).length,
    0,
  );
});

test("keep all, stack and selected keeper retain existing utility semantics", () => {
  const state = initialUtilities();
  for (const [decision, status] of [
    ["keep-all", "Kept"],
    ["stack", "Stacked"],
  ]) {
    const result = decide(state, decision);
    assert.ok(
      result.rows
        .filter((row) => row.group === "lake")
        .every((row) => row.status === status),
    );
  }
  const result = decide(state, "keeper", { keeperId: "dup-jpg" });
  assert.equal(result.rows.find((row) => row.id === "dup-jpg").status, "Kept");
  assert.equal(
    result.rows.find((row) => row.id === "dup-raw").status,
    "Trashed",
  );
  assert.throws(
    () =>
      decide(state, "keeper", {
        groupIds: ["lake", "forest"],
        keeperId: "dup-jpg",
      }),
    /one group/,
  );
  assert.throws(
    () => decide(state, "keeper", { keeperId: "dup-hike" }),
    /complete duplicate group/,
  );
});

test("review snapshots reject added members, changed statuses, sources and ambiguous IDs", () => {
  const state = initialUtilities();
  const expectedGroups = groups(state)
    .filter((group) => group.id === "lake")
    .map((group) => group.expected);
  for (const edit of [
    (next) =>
      next.rows.push({
        ...next.rows.find((row) => row.id === "dup-jpg"),
        id: "another-copy",
      }),
    (next) => {
      next.rows.find((row) => row.id === "dup-jpg").status = "Kept";
    },
    (next) => {
      next.rows.find((row) => row.id === "dup-jpg").checksum = "changed";
    },
  ]) {
    const next = structuredClone(state);
    edit(next);
    assert.throws(() => decide(next, "stack", { expectedGroups }), /changed/);
  }
  assert.throws(
    () => decide(state, "stack", { expectedGroups: [] }),
    /changed/,
  );
  const alias = structuredClone(state);
  alias.rows.push({
    ...alias.rows.find((row) => row.id === "dup-jpg"),
    group: "different",
    tool: "large-files",
  });
  assert.throws(() => decide(alias, "stack"), /ambiguous/);
});

test("batch undo stores affected rows only and preserves unrelated utility changes and history", () => {
  const before = initialUtilities();
  const after = decide(before, "suggested", { groupIds: ["lake", "forest"] });
  const patch = createDuplicateUndo(before, after, ["lake", "forest"]);
  assert.equal(patch.before.length, 4);
  assert.equal(patch.after.length, 4);
  assert.equal(patch.history, undefined);
  const changed = applyUtilityAction(after, {
    action: "keep",
    ids: ["dup-hike", "dup-hike-copy"],
    actorId: "jamie",
  });
  const currentSnapshot = structuredClone(changed);
  const undone = applyDuplicateUndo(changed, patch, { at });
  assert.deepEqual(changed, currentSnapshot);
  for (const id of ["dup-hike", "dup-hike-copy"])
    assert.equal(undone.rows.find((row) => row.id === id).status, "Kept");
  for (const row of patch.before)
    assert.deepEqual(
      undone.rows.find((item) => item.id === row.id),
      row,
    );
  assert.match(undone.history[0].title, /^Undid duplicate review/);
  assert.deepEqual(undone.history.slice(1), changed.history);
});

test("undo refuses stale affected photos and added group members", () => {
  const before = initialUtilities(),
    after = decide(before, "stack");
  const patch = createDuplicateUndo(before, after, ["lake"]);
  const updated = decide(after, "keep-all");
  assert.throws(() => applyDuplicateUndo(updated, patch), /cannot overwrite/);
  const added = structuredClone(after);
  added.rows.push({
    ...added.rows.find((row) => row.id === "dup-jpg"),
    id: "new-copy",
  });
  assert.throws(() => applyDuplicateUndo(added, patch), /cannot overwrite/);
});

test("next-group navigation is stable with bulk exclusions and explicit wrap", () => {
  const ordered = [{ id: "lake" }, { id: "forest" }, { id: "campfire" }];
  assert.equal(nextDuplicateGroup(ordered, "lake"), "forest");
  assert.equal(
    nextDuplicateGroup(ordered, "lake", { excludeIds: ["forest"] }),
    "campfire",
  );
  assert.equal(nextDuplicateGroup(ordered, "campfire"), null);
  assert.equal(nextDuplicateGroup(ordered, "campfire", { wrap: true }), "lake");
  assert.equal(
    nextDuplicateGroup(ordered, "forest", { direction: -1 }),
    "lake",
  );
  assert.equal(nextDuplicateGroup(ordered, "missing"), "lake");
  assert.equal(
    nextDuplicateGroup(ordered, "lake", {
      excludeIds: ["forest", "campfire"],
      wrap: true,
    }),
    null,
  );
});

test("thousands of groups produce one complete batch without per-group state copies", () => {
  const state = {
    ...initialUtilities(),
    rows: Array.from({ length: 3000 }, (_, index) => [
      {
        id: `original-${index}`,
        group: `group-${index}`,
        tool: "duplicates",
        ownerId: actorId,
        status: "Review",
        suggested: true,
        bytes: 20,
      },
      {
        id: `copy-${index}`,
        group: `group-${index}`,
        tool: "duplicates",
        ownerId: actorId,
        status: "Review",
        bytes: 10,
      },
    ]).flat(),
  };
  const all = groups(state);
  assert.equal(all.length, 3000);
  const next = decide(state, "suggested", {
    groupIds: all.map((group) => group.id),
    expectedGroups: all.map((group) => group.expected),
  });
  assert.equal(next.history.length, 1);
  assert.equal(next.rows.filter((row) => row.status === "Kept").length, 3000);
  assert.equal(
    next.rows.filter((row) => row.status === "Trashed").length,
    3000,
  );
});

test("multiple selected keepers retain each chosen original and undo as one batch", () => {
  const before = initialUtilities();
  const burst = groups(before).find((group) => group.kind === "burst");
  const keeperIds = [burst.ids[0], burst.ids[10], burst.ids[23]];
  const after = decide(before, "keepers", {
    groupIds: [burst.id],
    keeperIds,
    expectedGroups: [burst.expected],
  });
  const resolved = groups(after, { status: "all" }).find(
    (group) => group.id === burst.id,
  );
  assert.equal(resolved.keptCount, 3);
  assert.equal(resolved.trashedCount, burst.rows.length - 3);
  assert.equal(resolved.stackedCount, 0);
  assert.equal(resolved.openCount, 0);
  assert.equal(resolved.status, "Resolved");
  for (const row of resolved.rows)
    assert.equal(row.status, keeperIds.includes(row.id) ? "Kept" : "Trashed");
  const restored = applyDuplicateUndo(
    after,
    createDuplicateUndo(before, after, [burst.id]),
    { at },
  );
  assert.deepEqual(restored.rows, before.rows);
  assert.match(after.history[0].title, /^Kept 3 selected photos/);
});

test("multiple keepers reject empty, repeated, foreign, multi-group and stale selections", () => {
  const state = initialUtilities();
  const burst = groups(state).find((group) => group.kind === "burst");
  for (const keeperIds of [
    undefined,
    [],
    [burst.ids[0], burst.ids[0]],
    [burst.ids[0], "dup-hike"],
    [null],
  ]) {
    assert.throws(
      () => decide(state, "keepers", { groupIds: [burst.id], keeperIds }),
      /at least one distinct/,
    );
  }
  assert.throws(
    () =>
      decide(state, "keepers", {
        groupIds: [burst.id, "lake"],
        keeperIds: [burst.ids[0]],
      }),
    /one group/,
  );
  const changed = structuredClone(state);
  changed.rows.find((row) => row.id === burst.ids[2]).status = "Kept";
  assert.throws(
    () =>
      decide(changed, "keepers", {
        groupIds: [burst.id],
        keeperIds: [burst.ids[0]],
        expectedGroups: [burst.expected],
      }),
    /changed/,
  );
  changed.rows.find((row) => row.id === burst.ids[2]).ownerId = "jamie";
  assert.throws(
    () =>
      decide(changed, "keepers", {
        groupIds: [burst.id],
        keeperIds: [burst.ids[0]],
      }),
    /owner of every/,
  );
});

test("burst groups never suggest deleting other moments, even with an injected suggestion", () => {
  const state = initialUtilities();
  const source = state.rows.find((row) => row.groupKind === "burst");
  source.suggested = true;
  const burst = groups(state).find((group) => group.kind === "burst");
  assert.equal(burst.canSuggest, false);
  assert.equal(burst.suggestedKeeperId, null);
  assert.equal(burst.defaultDecision, "stack");
  assert.equal(burst.reclaimableBytes, 0);
  assert.ok(burst.rows.every((row) => !row.suggested));
  const snapshot = structuredClone(state);
  assert.throws(
    () => decide(state, "suggested", { groupIds: ["lake", burst.id] }),
    /Burst frames need/,
  );
  assert.deepEqual(state, snapshot);
});

test("stacking a burst retains every original and fixture metadata survives reload", () => {
  const state = initialUtilities();
  const burst = groups(state).find((group) => group.kind === "burst");
  assert.ok(burst.rows.length >= 18 && burst.rows.length <= 30);
  assert.equal(
    new Set(burst.rows.map((row) => row.capturedAt)).size,
    burst.rows.length,
  );
  assert.equal(
    new Set(
      burst.rows.map((row) => `${row.previewPosition}/${row.previewScale}`),
    ).size,
    burst.rows.length,
  );
  assert.ok(
    burst.rows.every(
      (row) => row.sampleEvidence && row.width === 4032 && row.height === 3024,
    ),
  );
  const after = decide(state, "stack", { groupIds: [burst.id] });
  const restored = parseUtilities(JSON.stringify(after));
  const stacked = groups(restored, { status: "all" }).find(
    (group) => group.id === burst.id,
  );
  assert.equal(stacked.rows.length, burst.rows.length);
  assert.equal(stacked.stackedCount, burst.rows.length);
  assert.equal(stacked.trashedCount, 0);
  assert.equal(stacked.totalBytes, burst.totalBytes);
  assert.ok(stacked.rows.every((row) => row.status === "Stacked"));
  for (const row of stacked.rows) {
    const original = burst.rows.find((item) => item.id === row.id);
    assert.equal(row.capturedAt, original.capturedAt);
    assert.equal(row.previewPosition, original.previewPosition);
    assert.equal(row.previewScale, original.previewScale);
    assert.equal(row.ownerId, original.ownerId);
  }
});

test("selecting every frame as keepers is valid and never sends an empty trash action", () => {
  const state = initialUtilities();
  const burst = groups(state).find((group) => group.kind === "burst");
  const after = decide(state, "keepers", {
    groupIds: [burst.id],
    keeperIds: burst.ids,
  });
  assert.ok(
    after.rows
      .filter((row) => row.group === burst.id)
      .every((row) => row.status === "Kept"),
  );
});
