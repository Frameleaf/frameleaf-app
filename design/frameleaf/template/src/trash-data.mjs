// UI-only state model. Source: TrashService/TrashRepository and AssetService.deleteAll.
// Deleted models the source's terminal deletion state, not proof that physical disk cleanup finished.
import { classifyLocked } from "./locked-content.mjs";
const text = (value) => (typeof value === "string" ? value : "");
const ownerLabel = (id) =>
  ({ taylor: "Taylor", jamie: "Jamie", emma: "Emma" })[id] || id;
const positiveBytes = (value) =>
  Number.isFinite(value) && value > 0 ? value : 0;
const actionNames = new Set(["restore", "delete", "empty"]);
const selectedIds = (ids) => {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => !text(id)))
    throw new Error("Choose available items in your trash.");
  return [...new Set(ids)];
};
export function trashMediaType(row) {
  const supplied = text(row.mediaType || row.type).toLowerCase();
  if (["image", "photo"].includes(supplied)) return "image";
  if (supplied === "video") return "video";
  const name = text(row.name).toLowerCase();
  if (/\.(?:mov|mp4|m4v|webm|mkv|avi|mts|m2ts|3gp|mpg|mpeg)$/.test(name))
    return "video";
  if (
    /\.(?:jpg|jpeg|heic|heif|png|gif|webp|avif|tif|tiff|dng|arw|cr2|cr3|nef|orf|raf|raw|rw2)$/.test(
      name,
    )
  )
    return "image";
  return "other";
}
export function trashReference(row) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    status: row.status,
    tool: row.tool ?? null,
    group: row.group ?? null,
    path: row.path ?? null,
    checksum: row.checksum ?? null,
    bytes: row.bytes ?? null,
    name: row.name ?? null,
    mediaType: row.mediaType ?? null,
    type: row.type ?? null,
    deletedAt: row.deletedAt ?? null,
    visibility: row.visibility ?? null,
    locked: row.locked ?? null,
    isLocked: row.isLocked ?? null,
    suppressed: row.suppressed ?? null,
    isSuppressed: row.isSuppressed ?? null,
    lockedByRule: row.lockedByRule ?? null,
    isSensitive: row.isSensitive ?? null,
    isNsfw: row.isNsfw ?? null,
    nsfw: row.nsfw ?? null,
    privacy: row.privacy ?? null,
  };
}
const compare = (left, right) =>
  String(left.id).localeCompare(String(right.id));
const references = (rows) => rows.map(trashReference).sort(compare);
const matches = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export function trashAge(row, now = Date.now()) {
  const value = row.deletedAt;
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const at =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)
      ? Date.parse(value)
      : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(nowMs) || at > nowMs)
    return {
      trashedAt: null,
      deletedAgeDays: null,
      deletedAgeLabel: "Date unavailable",
    };
  const days = Math.floor((nowMs - at) / 86_400_000);
  return {
    trashedAt: new Date(at).toISOString(),
    deletedAgeDays: days,
    deletedAgeLabel:
      days === 0 ? "Today" : days === 1 ? "1 day ago" : `${days} days ago`,
  };
}

/** Even an all-account filter never reveals another account's private trash. */
export function deriveTrashRows(
  rows,
  {
    actorId = "taylor",
    owner = "all",
    query = "",
    type = "all",
    now = Date.now(),
    unlocked = false,
  } = {},
) {
  if (
    !text(actorId) ||
    (owner !== "all" && owner !== "system" && owner !== actorId)
  )
    return [];
  const selectedType = type === "photo" ? "image" : type;
  if (!["all", "image", "video", "other"].includes(selectedType)) return [];
  const terms = text(query)
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return rows.flatMap((row) => {
    if (
      !row ||
      row.status !== "Trashed" ||
      row.ownerId !== actorId ||
      (unlocked !== true && classifyLocked(row)) ||
      !text(row.id)
    )
      return [];
    const mediaType = trashMediaType(row);
    if (selectedType !== "all" && selectedType !== mediaType) return [];
    const searchable =
      `${row.name || ""} ${ownerLabel(row.ownerId)} ${mediaType}`.toLocaleLowerCase();
    if (!terms.every((term) => searchable.includes(term))) return [];
    return [
      {
        ...row,
        mediaType,
        editable: true,
        ...trashAge(row, now),
        expected: trashReference(row),
      },
    ];
  });
}

function targetsFor(state, { action, ids, actorId, unlocked = false }) {
  if (!actionNames.has(action))
    throw new Error("Choose a supported trash action.");
  if (!text(actorId)) throw new Error("Sign in to manage your trash.");
  if (!Array.isArray(state?.rows))
    throw new Error("Trash is unavailable. Reload the library.");
  const ownTrash = state.rows.filter(
    (row) => row?.status === "Trashed" && row.ownerId === actorId,
  );
  if (action === "empty" && unlocked !== true && ownTrash.some(classifyLocked))
    throw new Error("Unlock before emptying all trash.");
  const requested =
    action === "empty" ? ownTrash.map((row) => row.id) : selectedIds(ids);
  if (!requested.length) throw new Error("Your trash is already empty.");
  const wanted = new Set(requested);
  const targets = state.rows.filter((row) => wanted.has(row?.id));
  if (
    targets.length !== wanted.size ||
    targets.some((row) => row.status !== "Trashed")
  )
    throw new Error(
      "A selected item changed or is no longer in trash. Refresh the review.",
    );
  if (targets.some((row) => row.ownerId !== actorId))
    throw new Error("Only the original owner can manage these items in trash.");
  if (unlocked !== true && targets.some(classifyLocked))
    throw new Error("Unlock before changing Locked items in trash.");
  return targets;
}

/** Empty always reviews the actor's complete trash, independently of view filters or selected IDs. */
export function reviewTrashAction(
  state,
  { action, ids, actorId = "taylor", unlocked = false },
) {
  const targets = targetsFor(state, { action, ids, actorId, unlocked });
  return {
    action,
    actorId,
    ids: targets.map((row) => row.id),
    expectedRows: references(targets),
    count: targets.length,
    bytes: targets.reduce((sum, row) => sum + positiveBytes(row.bytes), 0),
    scope: action === "empty" ? "all-owned" : "selected",
    destructive: action !== "restore",
  };
}

/** Revalidate the frozen review. No delete undo is offered by this model. */
export function applyTrashAction(
  state,
  {
    action,
    ids,
    actorId = "taylor",
    expectedRows,
    confirmed = false,
    at = new Date().toISOString(),
    unlocked = false,
  },
) {
  const targets = targetsFor(state, { action, ids, actorId, unlocked });
  if (
    !Array.isArray(expectedRows) ||
    !expectedRows.length ||
    expectedRows.some((row) => !row || !text(row.id)) ||
    !matches(references(targets), [...expectedRows].sort(compare))
  )
    throw new Error(
      "Trash changed since this review. Review the current items before continuing.",
    );
  if (action !== "restore" && confirmed !== true)
    throw new Error(
      "Confirm permanent deletion. These items cannot be restored afterward.",
    );
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at)))
    throw new Error("Use a valid action timestamp.");
  const targetIds = new Set(targets.map((row) => row.id));
  const title =
    action === "restore"
      ? `Restored ${targets.length} item${targets.length === 1 ? "" : "s"} from trash`
      : action === "empty"
        ? `Emptied my trash · ${targets.length} item${targets.length === 1 ? "" : "s"}`
        : `Permanently deleted ${targets.length} selected item${targets.length === 1 ? "" : "s"}`;
  return {
    ...state,
    rows: state.rows.map((row) =>
      !targetIds.has(row.id)
        ? row
        : {
            ...row,
            status: action === "restore" ? "Restored" : "Deleted",
            ...(action === "restore" ? { deletedAt: null } : {}),
          },
    ),
    history: [{ title, at }, ...(state.history || [])].slice(0, 30),
  };
}
