import { applyUtilityAction, ownerName } from "./utilities-data.mjs";

const closedStatuses = new Set([
  "Linked",
  "Relinked",
  "Dismissed",
  "Trashed",
  "Restored",
  "Deleted",
  "Kept",
  "Stacked",
  "Resolved",
]);
const text = (value) => (typeof value === "string" ? value : "");
const open = (row) => !closedStatuses.has(row.status);
const reference = (row) => ({
  id: row.id,
  group: row.group,
  ownerId: row.ownerId,
  status: row.status,
  suggested: row.suggested === true,
  checksum: row.checksum ?? null,
  path: row.path ?? null,
  bytes: row.bytes ?? null,
  width: row.width ?? null,
  height: row.height ?? null,
  groupKind: row.groupKind ?? null,
  capturedAt: row.capturedAt ?? null,
  frameNumber: row.frameNumber ?? null,
});
const refsFor = (rows) =>
  rows.map(reference).sort((a, b) => String(a.id).localeCompare(String(b.id)));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function collect(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (
      row?.tool !== "duplicates" ||
      row.status === "Deleted" ||
      !text(row.group) ||
      !text(row.id)
    )
      continue;
    let members = groups.get(row.group);
    if (!members) groups.set(row.group, (members = []));
    members.push(row);
  }
  return groups;
}

/** Enforce actor-only visibility before search, counts or suggestions. Mixed-owner groups fail closed. */
export function deriveDuplicateGroups(
  rows,
  { owner = "all", query = "", status = "open", actorId = "taylor" } = {},
) {
  if (!text(actorId) || !["all", "system", actorId].includes(owner)) return [];
  const terms = text(query)
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return [...collect(rows).entries()].flatMap(([id, members]) => {
    if (!members.every((row) => row.ownerId === actorId)) return [];
    const searchable =
      `${id} ${members.map((row) => `${row.name || ""} ${row.status || ""} ${ownerName(row.ownerId)} ${row.quality || ""}`).join(" ")}`.toLocaleLowerCase();
    if (!terms.every((term) => searchable.includes(term))) return [];
    const openCount = members.filter(open).length;
    if (status === "open" && !openCount) return [];
    if ((status === "resolved" || status === "closed") && openCount) return [];
    if (
      !["all", "open", "resolved", "closed"].includes(status) &&
      !members.some((row) => row.status === status)
    )
      return [];
    const kind = members.some((row) => row.groupKind === "burst")
      ? "burst"
      : "duplicates";
    const suggestions =
      kind === "burst" ? [] : members.filter((row) => row.suggested === true);
    const suggestedKeeperId =
      suggestions.length === 1 ? suggestions[0].id : null;
    const duplicateIds =
      new Set(members.map((row) => row.id)).size !== members.length;
    const editable =
      members.length >= 2 &&
      !duplicateIds &&
      Boolean(text(actorId)) &&
      members.every((row) => row.ownerId === actorId);
    const sizes = members.map((row) =>
      Number.isFinite(row.bytes) && row.bytes > 0 ? row.bytes : 0,
    );
    const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
    return [
      {
        id,
        kind,
        groupKind: kind,
        label: members.find((row) => text(row.groupLabel))?.groupLabel || id,
        defaultDecision: kind === "burst" ? "stack" : "suggested",
        rows: members.map((row) => ({
          ...row,
          suggested: row.id === suggestedKeeperId,
        })),
        ids: members.map((row) => row.id),
        ownerIds: [...new Set(members.map((row) => row.ownerId))],
        editable,
        canEdit: editable,
        suggestedKeeperId,
        canSuggest: editable && suggestedKeeperId !== null,
        suggestionReason:
          kind === "burst"
            ? "Burst frames capture different moments. Choose keepers, keep all, or stack them."
            : suggestions.length > 1
              ? "More than one suggested keeper; choose one."
              : suggestions.length === 0
                ? "Choose a keeper for this group."
                : "",
        status:
          openCount === 0
            ? "Resolved"
            : openCount === members.length
              ? "Review"
              : "Mixed",
        openCount,
        keptCount: members.filter((row) => row.status === "Kept").length,
        trashedCount: members.filter((row) => row.status === "Trashed").length,
        stackedCount: members.filter((row) => row.status === "Stacked").length,
        totalBytes,
        reclaimableBytes: suggestedKeeperId
          ? totalBytes -
            sizes[members.findIndex((row) => row.id === suggestedKeeperId)]
          : 0,
        expected: { id, refs: refsFor(members) },
      },
    ];
  });
}

function validateSelection(state, groupIds, actorId, expectedGroups) {
  if (
    !Array.isArray(groupIds) ||
    !groupIds.length ||
    groupIds.some((id) => !text(id))
  )
    throw new Error("Choose available duplicate groups.");
  const ids = [...new Set(groupIds)];
  const groups = collect(state.rows);
  const selected = ids.map((id) => {
    const rows = groups.get(id);
    if (!rows || rows.length < 2)
      throw new Error(
        "A duplicate group changed or is no longer available. Refresh the review.",
      );
    if (!text(actorId) || rows.some((row) => row.ownerId !== actorId))
      throw new Error(
        "Only the owner of every photo in a group can change that group.",
      );
    return { id, rows, expected: { id, refs: refsFor(rows) } };
  });
  // Reject duplicate IDs, including aliases in another group or another utility.
  const selectedIds = new Set(
    selected.flatMap((group) => group.rows.map((row) => row.id)),
  );
  const counts = new Map();
  for (const row of state.rows)
    if (selectedIds.has(row.id))
      counts.set(row.id, (counts.get(row.id) || 0) + 1);
  if ([...counts.values()].some((count) => count !== 1))
    throw new Error(
      "Photo references are ambiguous. Refresh the duplicate groups.",
    );
  if (expectedGroups !== undefined) {
    if (!Array.isArray(expectedGroups))
      throw new Error(
        "Provide a complete review snapshot for the selected groups.",
      );
    const expected = new Map();
    for (const item of expectedGroups) {
      if (
        !item ||
        !text(item.id) ||
        !Array.isArray(item.refs) ||
        expected.has(item.id)
      )
        throw new Error(
          "Provide a complete review snapshot for the selected groups.",
        );
      expected.set(item.id, item);
    }
    for (const group of selected) {
      const snapshot = expected.get(group.id);
      if (!snapshot || !same(snapshot, group.expected))
        throw new Error(
          "A group's members, ownership, status or source evidence changed. Review it again.",
        );
    }
  }
  return selected;
}

/** Returns one immutable state, including one history entry for the entire batch. */
export function applyDuplicateDecision(
  state,
  {
    groupIds,
    decision,
    keeperId,
    keeperIds,
    actorId = "taylor",
    expectedGroups,
    at = new Date().toISOString(),
  },
) {
  if (
    !["suggested", "keep-all", "stack", "keeper", "keepers"].includes(decision)
  )
    throw new Error("Choose a supported duplicate decision.");
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at)))
    throw new Error("Use a valid review timestamp.");
  const selected = validateSelection(state, groupIds, actorId, expectedGroups);
  if (["keeper", "keepers"].includes(decision) && selected.length !== 1)
    throw new Error("Choose a keeper within one group at a time.");
  // Validate every keeper before deriving any updates. Never silently choose among tied suggestions.
  const actions = selected.map((group) => {
    let chosen = keeperId;
    if (decision === "suggested") {
      if (group.rows.some((row) => row.groupKind === "burst"))
        throw new Error(
          "Burst frames need a personal choice. Choose keepers or stack all frames.",
        );
      const suggestions = group.rows.filter((row) => row.suggested === true);
      if (suggestions.length !== 1)
        throw new Error(
          "Each selected group needs exactly one suggested keeper. Choose a keeper for ambiguous groups.",
        );
      chosen = suggestions[0].id;
    }
    if (
      ["suggested", "keeper"].includes(decision) &&
      !group.rows.some((row) => row.id === chosen)
    )
      throw new Error("Choose a keeper from this complete duplicate group.");
    if (
      decision === "keepers" &&
      (!Array.isArray(keeperIds) ||
        keeperIds.length === 0 ||
        new Set(keeperIds).size !== keeperIds.length ||
        keeperIds.some(
          (id) => !text(id) || !group.rows.some((row) => row.id === id),
        ))
    )
      throw new Error(
        "Choose at least one distinct keeper from this complete group.",
      );
    return {
      group,
      keeper: chosen,
      action:
        decision === "keep-all"
          ? "keep"
          : decision === "stack"
            ? "stack"
            : "resolve-duplicates",
    };
  });
  const updates = new Map();
  for (const { group, keeper, action } of actions) {
    // Use the existing action semantics on each complete group. Avoid rescanning the whole library per group.
    let result =
      decision === "keepers"
        ? applyUtilityAction(
            { ...state, rows: group.rows, history: [] },
            { action: "keep", ids: keeperIds, actorId },
          )
        : applyUtilityAction(
            { ...state, rows: group.rows, history: [] },
            {
              action,
              ids: group.rows.map((row) => row.id),
              actorId,
              keeperId: keeper,
            },
          );
    if (decision === "keepers") {
      const keep = new Set(keeperIds),
        others = group.rows
          .filter((row) => !keep.has(row.id))
          .map((row) => row.id);
      if (others.length)
        result = applyUtilityAction(result, {
          action: "trash",
          ids: others,
          actorId,
        });
    }
    for (const row of result.rows) updates.set(row.id, row);
  }
  const groupLabel = `${selected.length} group${selected.length === 1 ? "" : "s"}`;
  const photoLabel = `${updates.size} photo${updates.size === 1 ? "" : "s"}`;
  const title = {
    suggested: "Kept suggested photos",
    "keep-all": "Kept all photos",
    stack: "Stacked related photos",
    keeper: "Kept the selected photo",
    keepers: `Kept ${keeperIds?.length || 0} selected photos`,
  }[decision];
  return {
    ...state,
    rows: state.rows.map((row) => updates.get(row.id) || row),
    history: [
      { title: `${title} · ${groupLabel} · ${photoLabel}`, at },
      ...(state.history || []),
    ].slice(0, 30),
  };
}

/** Store only affected rows. The caller can retain a bounded session undo stack. */
export function createDuplicateUndo(before, after, groupIds) {
  if (
    !Array.isArray(groupIds) ||
    !groupIds.length ||
    groupIds.some((id) => !text(id))
  )
    throw new Error("Choose the groups changed by this batch.");
  const ids = [...new Set(groupIds)];
  const beforeGroups = collect(before.rows),
    afterGroups = collect(after.rows);
  const prior = [],
    next = [];
  for (const id of ids) {
    const oldRows = beforeGroups.get(id),
      newRows = afterGroups.get(id);
    if (
      !oldRows ||
      !newRows ||
      !same(
        oldRows.map((row) => row.id).sort(),
        newRows.map((row) => row.id).sort(),
      )
    )
      throw new Error(
        "Group membership changed; this batch cannot be safely undone.",
      );
    prior.push(...oldRows);
    next.push(...newRows);
  }
  return {
    version: 1,
    groupIds: ids,
    before: structuredClone(prior),
    after: structuredClone(next),
  };
}
export function applyDuplicateUndo(
  current,
  patch,
  { at = new Date().toISOString(), actorId = "taylor" } = {},
) {
  if (
    !patch ||
    patch.version !== 1 ||
    !Array.isArray(patch.groupIds) ||
    !patch.groupIds.length ||
    !Array.isArray(patch.before) ||
    !Array.isArray(patch.after) ||
    !patch.before.length ||
    !patch.after.length
  )
    throw new Error("This undo record is unavailable.");
  if (
    !text(actorId) ||
    [...patch.before, ...patch.after].some((row) => row.ownerId !== actorId)
  )
    throw new Error(
      "Only the original owner can undo this duplicate decision.",
    );
  const groupIds = new Set(patch.groupIds);
  const affectedIds = new Set(patch.after.map((row) => row.id));
  const affected = current.rows.filter(
    (row) =>
      affectedIds.has(row.id) ||
      (row.tool === "duplicates" && groupIds.has(row.group)),
  );
  const sort = (rows) =>
    [...rows].sort((left, right) =>
      String(left.id).localeCompare(String(right.id)),
    );
  if (
    !same(sort(affected), sort(patch.after)) ||
    affectedIds.size !== patch.after.length ||
    !same(
      patch.before.map((row) => row.id).sort(),
      patch.after.map((row) => row.id).sort(),
    )
  )
    throw new Error(
      "Photos in this batch changed. Undo cannot overwrite newer decisions.",
    );
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at)))
    throw new Error("Use a valid review timestamp.");
  const previous = new Map(patch.before.map((row) => [row.id, row]));
  return {
    ...current,
    rows: current.rows.map((row) =>
      previous.has(row.id) ? structuredClone(previous.get(row.id)) : row,
    ),
    history: [
      {
        title: `Undid duplicate review · ${groupIds.size} group${groupIds.size === 1 ? "" : "s"} · ${affectedIds.size} photo${affectedIds.size === 1 ? "" : "s"}`,
        at,
      },
      ...(current.history || []),
    ].slice(0, 30),
  };
}

/** Move through a stable ordered group list; exclusions support advancing after bulk decisions. */
export function nextDuplicateGroup(
  groups,
  currentId,
  { direction = 1, excludeIds = [], wrap = false } = {},
) {
  const ids = groups.map((group) =>
    typeof group === "string" ? group : group.id,
  );
  const excluded = new Set(excludeIds);
  const step = direction === -1 ? -1 : 1;
  const current = ids.indexOf(currentId);
  if (current === -1)
    return (
      (step === 1 ? ids : [...ids].reverse()).find((id) => !excluded.has(id)) ??
      null
    );
  for (let distance = 1; distance <= ids.length; distance++) {
    const index = current + distance * step;
    if (!wrap && (index < 0 || index >= ids.length)) return null;
    const id = ids[((index % ids.length) + ids.length) % ids.length];
    if (id !== currentId && !excluded.has(id)) return id;
  }
  return null;
}
