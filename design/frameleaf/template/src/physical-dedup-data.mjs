// Local review model. Current backend jobs recompute a global scan; see the design notes.
export const PHYSICAL_DEDUP_STORAGE_KEY = "frameleaf:physical-dedup:v1";
export const PHYSICAL_DEDUP_LIMITS = Object.freeze({
  events: 200,
  bytes: 250_000,
});
export const DEDUP_ACCOUNTS = Object.freeze([
  { id: "all", name: "All accounts" },
  { id: "taylor", name: "Taylor" },
  { id: "jamie", name: "Jamie" },
  { id: "emma", name: "Emma" },
]);
export const dedupOwnerName = (id) =>
  DEDUP_ACCOUNTS.find((owner) => owner.id === id)?.name || "Selected account";
export const dedupScope = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 100
    ? value === "system"
      ? "all"
      : value
    : "all";
const checksum = (digit) => digit.repeat(40);
const fixtures = [
  // id, owner, file name, bytes, checksum, condition, sample preview, kind, detail
  ["lake-t", "taylor", "Moraine Lake.jpg", 14_850_240, checksum("a"), "", "lake", "photo", "6000 × 4000"],
  ["lake-j", "jamie", "Moraine Lake.jpg", 14_850_240, checksum("a"), "", "lake", "photo", "6000 × 4000"],
  ["lake-e", "emma", "Moraine Lake.jpg", 14_850_240, checksum("a"), "", "lake", "photo", "6000 × 4000"],
  ["garden-t", "taylor", "Garden afternoon.mov", 428_600_320, checksum("b"), "", "flowers", "video", "1:12 · 4K"],
  ["garden-j", "jamie", "Garden afternoon.mov", 428_600_320, checksum("b"), "", "flowers", "video", "1:12 · 4K"],
  ["garden-edited", "emma", "Garden afternoon.mov", 418_600_320, checksum("c"), "", "flowers", "video", "1:08 · 4K"],
  ["trip-t", "taylor", "Mountain trail.jpg", 12_400_640, checksum("d"), "missing", "hiking", "photo", "6000 × 4000"],
  ["trip-j", "jamie", "Mountain trail.jpg", 12_400_640, checksum("d"), "", "hiking", "photo", "6000 × 4000"],
  ["library-e", "emma", "Moraine Lake.jpg", 14_850_240, checksum("a"), "external", "lake", "photo", "6000 × 4000"],
].map(([id, ownerId, name, bytes, sha1, condition, preview, kind, detail]) =>
  Object.freeze({
    id,
    ownerId,
    name,
    bytes,
    checksum: sha1,
    external: condition === "external",
    exists: condition !== "missing",
    path: `${condition === "external" ? "/mnt/family-archive" : `/upload/library/${ownerId}`}/${id}/${name}`,
    preview: `/media/${preview}.png`,
    kind,
    detail,
  }),
);
export const DEDUP_SAMPLE_ASSETS = Object.freeze(fixtures);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const validDate = (value) =>
  typeof value === "string" &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
export function createPhysicalDedupState() {
  return {
    version: 1,
    revision: 0,
    links: {},
    plan: null,
    events: [],
    history: [],
  };
}
export function dedupSettings(settings) {
  return {
    enabled: settings.physicalDedup === true,
    masterOwnerId: String(settings.advancedDedupMaster || "").replace(
      /^sample-/,
      "",
    ),
  };
}
export function dedupConfigurationError(settings) {
  const config = dedupSettings(settings);
  if (!config.enabled) return "Enable file reuse before preparing a plan.";
  if (
    !DEDUP_ACCOUNTS.some(
      (owner) => owner.id !== "all" && owner.id === config.masterOwnerId,
    )
  )
    return "Choose and save an account to retain shared originals before preparing a plan.";
  return "";
}
function rowsFor(state, scope, masterOwnerId) {
  return fixtures
    .filter(
      (asset) =>
        asset.ownerId !== masterOwnerId &&
        (scope === "all" || scope === asset.ownerId),
    )
    .map((asset) => {
      const retained = fixtures.find(
        (candidate) =>
          candidate.ownerId === masterOwnerId &&
          candidate.checksum === asset.checksum &&
          candidate.bytes === asset.bytes &&
          !candidate.external,
      );
      let reason = "",
        status = "eligible";
      if (asset.external) reason = "External-library file";
      else if (!asset.exists) reason = "Source file unavailable";
      else if (state.links[asset.id]) reason = "Already uses a shared original";
      else if (!retained) reason = "No exact copy in the retained account";
      else if (!retained.exists) reason = "Retained copy unavailable";
      else if (state.links[retained.id])
        reason = "Retained account points to a different shared original";
      if (reason) status = "skipped";
      const currentRefs = retained
        ? fixtures.filter(
            (item) =>
              item.id === retained.id || state.links[item.id] === retained.id,
          ).length
        : 0;
      return {
        assetId: asset.id,
        retainedId: retained?.id || null,
        ownerId: asset.ownerId,
        name: asset.name,
        path: asset.path,
        retainedPath: retained?.path || null,
        bytes: asset.bytes,
        checksum: asset.checksum,
        retainedChecksum: retained?.checksum || null,
        retainedExists: Boolean(retained?.exists),
        preview: asset.preview,
        kind: asset.kind,
        detail: asset.detail,
        retainedPreview: retained?.preview || null,
        status,
        reason,
        referencesBefore: currentRefs,
      };
    });
}
function planFor(state, event) {
  const rows = rowsFor(state, event.scope, event.masterOwnerId);
  const eligible = rows.filter((row) => row.status === "eligible");
  return {
    id: event.planId,
    status: "completed",
    createdAt: event.at,
    reviewedAt: null,
    appliedAt: null,
    scope: event.scope,
    masterOwnerId: event.masterOwnerId,
    rows: rows.map((row) => ({
      ...row,
      referencesAfter:
        row.referencesBefore +
        eligible.filter((item) => item.retainedId === row.retainedId).length,
    })),
    estimatedBytes: eligible.reduce((sum, row) => sum + row.bytes, 0),
    eligibleCount: eligible.length,
    skippedCount: rows.length - eligible.length,
  };
}
export function physicalDedupPlanError(state, settings, scope) {
  const configError = dedupConfigurationError(settings);
  if (configError) return configError;
  if (!state.plan) return "Prepare a plan before reviewing file changes.";
  if (state.plan.scope !== dedupScope(scope))
    return "The account scope changed. Prepare a new plan for this scope.";
  if (state.plan.masterOwnerId !== dedupSettings(settings).masterOwnerId)
    return "The retained account changed. Prepare a new plan before continuing.";
  if (state.plan.status === "applied")
    return "This plan has already been applied.";
  const refreshed = planFor(state, {
    planId: state.plan.id,
    scope: state.plan.scope,
    masterOwnerId: state.plan.masterOwnerId,
    at: state.plan.createdAt,
  });
  if (JSON.stringify(refreshed.rows) !== JSON.stringify(state.plan.rows))
    return "File or reference evidence changed. Prepare a new plan.";
  if (!state.plan.eligibleCount)
    return "This plan has no exact copies to share.";
  return "";
}
function reduceEvent(state, event) {
  if (!object(event) || !validDate(event.at) || !validId(event.planId))
    throw new Error("Invalid plan record.");
  if (state.events.length >= PHYSICAL_DEDUP_LIMITS.events)
    throw new Error(
      "This device's review history is full. Export the history before starting another session.",
    );
  const next = {
    ...state,
    revision: state.revision + 1,
    events: [...state.events, { ...event }],
  };
  let title;
  if (event.type === "scan") {
    if (
      typeof event.scope !== "string" ||
      dedupScope(event.scope) !== event.scope ||
      !DEDUP_ACCOUNTS.some(
        (item) => item.id !== "all" && item.id === event.masterOwnerId,
      )
    )
      throw new Error("Invalid scan scope or retained account.");
    if (state.events.some((item) => item.planId === event.planId))
      throw new Error("Choose a new plan ID for each scan.");
    next.plan = planFor(state, event);
    title = "Plan prepared";
  } else {
    if (!state.plan || state.plan.id !== event.planId)
      throw new Error("The reviewed plan was replaced. Open the latest plan.");
    const settings = {
      physicalDedup: true,
      advancedDedupMaster: event.masterOwnerId,
    };
    const error = physicalDedupPlanError(state, settings, event.scope);
    if (error) throw new Error(error);
    if (event.type === "review") {
      if (state.plan.status !== "completed")
        throw new Error("Open the current completed plan to review it.");
      next.plan = { ...state.plan, status: "reviewed", reviewedAt: event.at };
      title = "Plan reviewed";
    } else if (event.type === "apply") {
      if (
        state.plan.status !== "reviewed" ||
        event.confirmation !== `APPLY ${event.planId}`
      )
        throw new Error(
          "Review this plan and type its exact confirmation before applying it.",
        );
      next.links = { ...state.links };
      for (const row of state.plan.rows.filter(
        (row) => row.status === "eligible",
      ))
        next.links[row.assetId] = row.retainedId;
      next.plan = { ...state.plan, status: "applied", appliedAt: event.at };
      title = "Shared-file changes recorded";
    } else throw new Error("Unknown plan action.");
  }
  next.history = [
    {
      id: `${event.planId}-${event.type}`,
      title,
      at: event.at,
      planId: event.planId,
      scope: event.scope,
      eligibleCount: next.plan.eligibleCount,
      bytes: next.plan.estimatedBytes,
    },
    ...state.history,
  ].slice(0, 50);
  return next;
}
export function preparePhysicalDedupPlan(
  state,
  { settings, scope = "all", planId, at = new Date().toISOString() },
) {
  const error = dedupConfigurationError(settings);
  if (error) throw new Error(error);
  return reduceEvent(state, {
    type: "scan",
    planId,
    scope: dedupScope(scope),
    masterOwnerId: dedupSettings(settings).masterOwnerId,
    at,
  });
}
export function reviewPhysicalDedupPlan(
  state,
  { settings, scope, planId, at = new Date().toISOString() },
) {
  const error = physicalDedupPlanError(state, settings, scope);
  if (error) throw new Error(error);
  return reduceEvent(state, {
    type: "review",
    planId,
    scope: dedupScope(scope),
    masterOwnerId: dedupSettings(settings).masterOwnerId,
    at,
  });
}
export function applyPhysicalDedupPlan(
  state,
  { settings, scope, planId, confirmation, at = new Date().toISOString() },
) {
  const error = physicalDedupPlanError(state, settings, scope);
  if (error) throw new Error(error);
  return reduceEvent(state, {
    type: "apply",
    planId,
    confirmation,
    scope: dedupScope(scope),
    masterOwnerId: dedupSettings(settings).masterOwnerId,
    at,
  });
}
export function parsePhysicalDedupState(raw) {
  try {
    if (typeof raw !== "string" || raw.length > PHYSICAL_DEDUP_LIMITS.bytes)
      return createPhysicalDedupState();
    const value = JSON.parse(raw);
    if (
      !object(value) ||
      value.version !== 1 ||
      !Array.isArray(value.events) ||
      value.events.length > PHYSICAL_DEDUP_LIMITS.events
    )
      return createPhysicalDedupState();
    // Rebuild evidence, links and totals from known fixtures; do not trust persisted paths or byte totals.
    return value.events.reduce(
      (state, event) =>
        reduceEvent(state, {
          type: event.type,
          planId: event.planId,
          scope: event.scope,
          masterOwnerId: event.masterOwnerId,
          at: event.at,
          ...(event.type === "apply"
            ? { confirmation: event.confirmation }
            : {}),
        }),
      createPhysicalDedupState(),
    );
  } catch {
    return createPhysicalDedupState();
  }
}
export function serializePhysicalDedupState(state) {
  const raw = JSON.stringify({ version: 1, events: state.events });
  if (raw.length > PHYSICAL_DEDUP_LIMITS.bytes)
    throw new Error("The review history exceeds this device's storage limit.");
  return raw;
}
export function physicalDedupStorageToken(state) {
  return serializePhysicalDedupState(state);
}
