// Stable sample identities only; the real API supplies tag/person IDs.
export function lockedTagId(name) {
  const label = String(name).trim().toLocaleLowerCase();
  const hex = [1, 2, 3, 4]
    .map((salt) => {
      let hash = (2166136261 ^ salt) >>> 0;
      for (const character of label)
        hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
      return hash.toString(16).padStart(8, "0");
    })
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
export const LOCKED_RULES_KEY = "frameleaf:protected-rules:v1";
export const LOCKED_PEOPLE = Object.freeze([
  {
    id: "22222222-2222-4222-8222-222222222221",
    legacyId: "emma",
    name: "Emma",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    legacyId: "jamie",
    name: "Jamie",
  },
  {
    id: "22222222-2222-4222-8222-222222222223",
    legacyId: "taylor",
    name: "Taylor",
  },
]);
export function readLockedRuleCatalog(raw) {
  try {
    if (typeof raw !== "string" || raw.length > 30_000) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    return {
      version: value.version === 2 ? 2 : 1,
      scope: value.scope === "visible" ? "visible" : "owned",
      people: Array.isArray(value.people)
        ? [
            ...new Set(
              value.people.filter((id) =>
                LOCKED_PEOPLE.some((person) => person.legacyId === id),
              ),
            ),
          ]
        : [],
      tags: Array.isArray(value.tags)
        ? [
            ...new Set(
              value.tags
                .filter(
                  (name) =>
                    typeof name === "string" &&
                    name.trim() &&
                    name.length <= 100,
                )
                .slice(0, 100)
                .map((name) => name.trim()),
            ),
          ]
        : [],
    };
  } catch {
    return null;
  }
}
export function resolveLockedRules(preferences, raw) {
  const rules = structuredClone(preferences.privacy.suppression);
  const legacy = readLockedRuleCatalog(raw);
  if (
    !legacy ||
    legacy.version === 2 ||
    rules.tagIds.length ||
    rules.personIds.length
  )
    return rules;
  return {
    scope: legacy.scope,
    tagIds: legacy.tags.map(lockedTagId),
    personIds: LOCKED_PEOPLE.filter((person) =>
      legacy.people.includes(person.legacyId),
    ).map((person) => person.id),
  };
}
export function matchesLockedRules(asset, preferences, actorId = "taylor") {
  const rules = preferences?.privacy?.suppression;
  if (!rules || (rules.scope !== "visible" && asset.ownerId !== actorId))
    return false;
  return (
    (asset.tags || []).some((tag) =>
      rules.tagIds.includes(
        lockedTagId(typeof tag === "string" ? tag : tag.name || ""),
      ),
    ) ||
    LOCKED_PEOPLE.some(
      (person) =>
        rules.personIds.includes(person.id) &&
        (asset.people || []).includes(person.name),
    )
  );
}
export function applyLockedRules(assets, preferences, actorId = "taylor") {
  if (!Array.isArray(assets)) return [];
  return assets.map((asset) =>
    asset?.ownerId === actorId
      ? {
          ...asset,
          lockedByRule: matchesLockedRules(asset, preferences, actorId),
        }
      : asset,
  );
}
