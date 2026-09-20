// Locked is a virtual timeline of Sensitive marks and personal-rule matches.
// Marks never relocate assets or change album membership. Legacy locked
// visibility is supported for reading old data only.
const flags = [
  "locked",
  "isLocked",
  "suppressed",
  "isSuppressed",
  "lockedByRule",
  "isSensitive",
  "isNsfw",
  "nsfw",
];
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const explicitlyLocked = (asset) => asset.visibility === "locked";

/** True for either a privacy mark or a resolved personal-rule match. */
export function classifyLocked(asset) {
  return (
    record(asset) &&
    (explicitlyLocked(asset) ||
      flags.some((key) => asset[key] === true) ||
      asset.privacy?.isNsfw === true)
  );
}

/** Filter before searching, counting, faceting, selecting, or rendering thumbnails.
 * Ordinary views reveal marks and rule matches after unlock. Only legacy locked
 * visibility remains separate. Unknown ownership never gains access from an admin role.
 * Shared content requires a future server-authorized scope, not owner inference.
 */
export function visibleAssets(
  assets,
  { unlocked = false, scope = "library", actorId = "taylor" } = {},
) {
  if (
    !Array.isArray(assets) ||
    !["library", "locked"].includes(scope) ||
    typeof actorId !== "string" ||
    !actorId
  )
    return [];
  if (scope === "locked" && unlocked !== true) return [];
  return assets.filter((asset) => {
    if (
      !record(asset) ||
      asset.ownerId !== actorId ||
      asset.accessRevoked === true ||
      asset.deletedAt ||
      asset.isTrashed === true ||
      ["Deleted", "Trashed"].includes(asset.status) ||
      asset.visibility === "hidden"
    )
      return false;
    if (
      flags.some(
        (key) => asset[key] !== undefined && typeof asset[key] !== "boolean",
      )
    )
      return false;
    if (
      asset.privacy !== undefined &&
      (!record(asset.privacy) ||
        (asset.privacy.isNsfw !== undefined &&
          typeof asset.privacy.isNsfw !== "boolean"))
    )
      return false;
    if (scope === "locked") return classifyLocked(asset);
    return (
      !explicitlyLocked(asset) && (unlocked === true || !classifyLocked(asset))
    );
  });
}

export const LOCKED_SESSION_MILLISECONDS = 60 * 60 * 1000;
export const validSamplePin = (value) =>
  typeof value === "string" && /^\d{6}$/.test(value);

/** Public account/session facts only. PIN values are never saved or inferred. */
export function lockedAccessSnapshot(resources, actorId = "taylor") {
  const user = resources?.users?.find((row) => row.id === actorId);
  const session = resources?.sessions?.find(
    (row) => row.userId === actorId && row.current,
  );
  return {
    available: user?.status === "active" && !!session && !session.revokedAt,
    pinEnabled: user?.pinEnabled === true,
    token: JSON.stringify([
      actorId,
      user?.status ?? null,
      user?.pinEnabled ?? false,
      user?.pinResetAt ?? null,
      user?.passwordUpdatedAt ?? null,
      session?.id ?? null,
      session?.revokedAt ?? null,
    ]),
  };
}
