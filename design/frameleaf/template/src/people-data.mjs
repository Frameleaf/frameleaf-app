// Pure people-management logic: per-person overrides (naming, birthday,
// visibility, favorites, featured photo, merges) layered over the people
// derived from the library and the on-device face tags.
export const PEOPLE_KEY = "frameleaf:people:v1";
export const PEOPLE_EVENT = "frameleaf:people-changed";
export const PERSON_COLORS = [
  "primary",
  "pink",
  "red",
  "yellow",
  "blue",
  "green",
  "purple",
  "orange",
  "gray",
  "amber",
];
const MAX_BYTES = 500_000,
  MAX_PEOPLE = 2000,
  MAX_NAME = 120,
  MAX_LIST = 200;
const record = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const field = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
};
export const isPersonId = (value) =>
  typeof value === "string" &&
  /^[\p{L}\p{N}][\p{L}\p{N}_ -]{0,127}$/u.test(value) &&
  !["__proto__", "prototype", "constructor"].includes(value);
const isName = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= MAX_NAME &&
  !/[\u0000-\u001f]/.test(value);
export function isBirthday(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1800 || month < 1 || month > 12 || day < 1 || day > 31)
    return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
export const emptyOverride = () => ({
  name: null,
  birthday: null,
  hidden: false,
  favorite: false,
  featuredAssetId: null,
  mergedInto: null,
  color: null,
  notSameAs: [],
});
function normalizeOverride(entry) {
  const next = emptyOverride();
  if (!record(entry)) return next;
  if (isName(field(entry, "name"))) next.name = field(entry, "name").trim();
  if (isBirthday(field(entry, "birthday"))) next.birthday = field(entry, "birthday");
  for (const key of ["hidden", "favorite"])
    if (field(entry, key) === true) next[key] = true;
  if (isPersonId(field(entry, "featuredAssetId")))
    next.featuredAssetId = field(entry, "featuredAssetId");
  if (isPersonId(field(entry, "mergedInto")))
    next.mergedInto = field(entry, "mergedInto");
  if (PERSON_COLORS.includes(field(entry, "color")))
    next.color = field(entry, "color");
  const notSameAs = field(entry, "notSameAs");
  if (Array.isArray(notSameAs))
    next.notSameAs = [
      ...new Set(notSameAs.slice(0, MAX_LIST).filter(isPersonId)),
    ];
  return next;
}
const isEmptyOverride = (entry) =>
  entry.name === null &&
  entry.birthday === null &&
  !entry.hidden &&
  !entry.favorite &&
  entry.featuredAssetId === null &&
  entry.mergedInto === null &&
  entry.color === null &&
  entry.notSameAs.length === 0;
/** Accepts stored JSON, a plain map, or the {version, people} envelope. Never throws. */
export function parsePeopleOverrides(raw) {
  if (raw === null || raw === undefined || raw === "") return {};
  if (typeof raw === "string" && raw.length > MAX_BYTES) return {};
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
  if (!record(data)) return {};
  const people =
    field(data, "version") === 1 && record(field(data, "people"))
      ? field(data, "people")
      : field(data, "version") === undefined
        ? data
        : null;
  if (!record(people)) return {};
  const result = {};
  for (const id of Object.keys(people).slice(0, MAX_PEOPLE)) {
    if (!isPersonId(id)) continue;
    const entry = normalizeOverride(field(people, id));
    if (entry.mergedInto === id) entry.mergedInto = null;
    entry.notSameAs = entry.notSameAs.filter((other) => other !== id);
    if (!isEmptyOverride(entry)) result[id] = entry;
  }
  // Break merge cycles: walking mergedInto from any id must terminate.
  for (const id of Object.keys(result)) {
    const seen = new Set([id]);
    let cursor = result[id].mergedInto;
    while (cursor && result[cursor]?.mergedInto) {
      if (seen.has(cursor)) {
        result[id].mergedInto = null;
        break;
      }
      seen.add(cursor);
      cursor = result[cursor].mergedInto;
    }
    if (cursor && seen.has(cursor)) result[id].mergedInto = null;
  }
  return result;
}
export function readPeopleOverrides(storage = localStorage) {
  try {
    return parsePeopleOverrides(storage.getItem(PEOPLE_KEY));
  } catch {
    return {};
  }
}
export function savePeopleOverrides(overrides, storage = localStorage) {
  const clean = parsePeopleOverrides(overrides);
  const serialized = JSON.stringify({ version: 1, people: clean });
  if (serialized.length > MAX_BYTES)
    throw Error("People settings could not be saved on this device.");
  storage.setItem(PEOPLE_KEY, serialized);
  if (typeof window !== "undefined" && typeof Event !== "undefined")
    window.dispatchEvent(new Event(PEOPLE_EVENT));
  return clean;
}
export function subscribePeopleOverrides(callback, storage = localStorage) {
  const sync = (event) => {
    if (
      event.type === PEOPLE_EVENT ||
      event.key === PEOPLE_KEY ||
      event.key === null
    )
      callback(readPeopleOverrides(storage));
  };
  window.addEventListener("storage", sync);
  window.addEventListener(PEOPLE_EVENT, sync);
  return () => {
    window.removeEventListener("storage", sync);
    window.removeEventListener(PEOPLE_EVENT, sync);
  };
}
export const getOverride = (overrides, id) =>
  overrides && Object.hasOwn(overrides, id) && record(overrides[id])
    ? { ...emptyOverride(), ...overrides[id] }
    : emptyOverride();
export function updatePerson(overrides, id, patch) {
  if (!isPersonId(id) || !record(patch)) return overrides || {};
  const next = normalizeOverride({ ...getOverride(overrides, id), ...patch });
  if (Object.hasOwn(patch, "name") && !isName(patch.name)) next.name = null;
  if (Object.hasOwn(patch, "birthday") && !isBirthday(patch.birthday))
    next.birthday = null;
  if (Object.hasOwn(patch, "featuredAssetId") && !isPersonId(patch.featuredAssetId))
    next.featuredAssetId = null;
  const result = { ...(overrides || {}) };
  if (isEmptyOverride(next)) delete result[id];
  else result[id] = next;
  return result;
}
export const setPersonName = (overrides, id, name) =>
  updatePerson(overrides, id, { name: typeof name === "string" ? name.trim() : null });
export const setBirthday = (overrides, id, birthday) =>
  isBirthday(birthday) || birthday === null || birthday === ""
    ? updatePerson(overrides, id, { birthday: birthday || null })
    : overrides || {};
export const setFeaturedAsset = (overrides, id, assetId) =>
  updatePerson(overrides, id, { featuredAssetId: assetId || null });
export const togglePersonFlag = (overrides, id, key, value) =>
  ["hidden", "favorite"].includes(key)
    ? updatePerson(overrides, id, { [key]: value === true })
    : overrides || {};
/** Follows merges to the person an id now represents. */
export function resolvePersonId(id, overrides) {
  const seen = new Set();
  let cursor = id;
  while (
    isPersonId(cursor) &&
    !seen.has(cursor) &&
    overrides?.[cursor]?.mergedInto
  ) {
    seen.add(cursor);
    cursor = overrides[cursor].mergedInto;
  }
  return cursor;
}
/** Pass the applied people list so a name only carries over to a target that has none. */
export function mergePeople(overrides, fromId, intoId, people = null) {
  const current = overrides || {};
  if (!isPersonId(fromId) || !isPersonId(intoId) || fromId === intoId)
    return current;
  const target = resolvePersonId(intoId, current);
  if (target === fromId || resolvePersonId(fromId, current) === target)
    return current;
  const from = getOverride(current, fromId),
    into = getOverride(current, target);
  let next = { ...current };
  // Everyone previously merged into `from` now points at the target.
  for (const id of Object.keys(next))
    if (next[id].mergedInto === fromId)
      next[id] = { ...next[id], mergedInto: target };
  next = updatePerson(next, fromId, {
    mergedInto: target,
    hidden: false,
    favorite: false,
    featuredAssetId: null,
    notSameAs: [],
  });
  const patch = {
    favorite: into.favorite || from.favorite,
    notSameAs: into.notSameAs.filter((id) => id !== fromId),
  };
  const targetPerson = Array.isArray(people)
    ? people.find((person) => person?.id === target)
    : null;
  if (
    !into.name &&
    from.name &&
    (targetPerson ? isUnnamed(targetPerson) : false)
  )
    patch.name = from.name;
  if (!into.birthday && from.birthday) patch.birthday = from.birthday;
  if (!into.featuredAssetId && from.featuredAssetId)
    patch.featuredAssetId = from.featuredAssetId;
  return updatePerson(next, target, patch);
}
export function dismissSuggestion(overrides, fromId, intoId) {
  if (!isPersonId(fromId) || !isPersonId(intoId) || fromId === intoId)
    return overrides || {};
  const from = getOverride(overrides, fromId);
  return updatePerson(overrides, fromId, {
    notSameAs: [...new Set([...from.notSameAs, intoId])],
  });
}
export const isUnnamed = (person) =>
  !person?.name?.trim() || /^unnamed person\b/i.test(person.name.trim());
export const displayName = (person) =>
  isUnnamed(person) ? "Unnamed person" : person.name.trim();
/**
 * Two unnamed recognition clusters that only exist in the sample library. Their
 * face crops come from existing avatars so the naming and merge flows can be tried.
 */
export function sampleClusters() {
  return [
    {
      id: "cluster-unnamed-1",
      name: "",
      image: "/media/avatar-jamie.png",
      imageWidth: 1254,
      imageHeight: 1254,
      faceBox: { x: 0.2, y: 0.08, width: 0.62, height: 0.62 },
      sample: true,
      assetIds: ["2", "4", "5", "15"],
    },
    {
      id: "cluster-unnamed-2",
      name: "",
      image: "/media/avatar-emma.png",
      imageWidth: 1254,
      imageHeight: 1254,
      faceBox: { x: 0.14, y: 0.06, width: 0.7, height: 0.7 },
      sample: true,
      assetIds: ["8", "18"],
    },
  ];
}
/** Adds sample cluster ids and follows merges so asset.personIds always name current people. */
export function remapAssetPeople(assets, overrides, { samples = true } = {}) {
  const clusters = samples ? sampleClusters() : [];
  return (assets || []).map((asset) => {
    const original = Array.isArray(asset.personIds) ? asset.personIds : [];
    const ids = [
      ...original,
      ...clusters
        .filter((cluster) => cluster.assetIds.includes(asset.id))
        .map((cluster) => cluster.id),
    ];
    const personIds = [
      ...new Set(ids.map((id) => resolvePersonId(id, overrides))),
    ];
    return personIds.length === original.length &&
      personIds.every((id, index) => id === original[index])
      ? asset
      : { ...asset, personIds };
  });
}
/**
 * Layers overrides over derived people. Merged people disappear and their ids
 * are listed on the target as mergedIds. Idempotent, so components may re-apply.
 */
export function applyPeopleOverrides(people, overrides, { samples = true } = {}) {
  const known = new Set();
  const base = [];
  for (const person of [...(people || []), ...(samples ? sampleClusters() : [])])
    if (person && isPersonId(person.id) && !known.has(person.id)) {
      known.add(person.id);
      base.push(person);
    }
  const applied = base.map((person) => {
    const override = getOverride(overrides, person.id);
    const sourceName =
      typeof person.sourceName === "string"
        ? person.sourceName
        : typeof person.name === "string" &&
            !/^unnamed person\b/i.test(person.name.trim())
          ? person.name.trim()
          : "";
    const sourceColor = Object.hasOwn(person, "sourceColor")
      ? person.sourceColor
      : person.avatarColor;
    return {
      ...person,
      sourceName,
      sourceColor,
      name: override.name ?? sourceName,
      birthday: override.birthday,
      hidden: override.hidden,
      favorite: override.favorite,
      featuredAssetId: override.featuredAssetId,
      mergedInto: override.mergedInto,
      avatarColor: override.color || sourceColor,
      notSameAs: [...override.notSameAs],
      mergedIds: [],
    };
  });
  const byId = new Map(applied.map((person) => [person.id, person]));
  const result = [];
  for (const person of applied) {
    const targetId = resolvePersonId(person.id, overrides);
    if (targetId !== person.id && byId.has(targetId)) {
      const target = byId.get(targetId);
      target.mergedIds = [
        ...new Set([...target.mergedIds, person.id, ...person.mergedIds]),
      ];
      continue;
    }
    result.push(person);
  }
  return result.map((person) => ({ ...person, mergedInto: null }));
}
export const visiblePeople = (people, { showHidden = false } = {}) =>
  (people || []).filter(
    (person) => !person.mergedInto && (showHidden || !person.hidden),
  );
export const personAssets = (person, assets) => {
  if (!person) return [];
  const ids = new Set([person.id, ...(person.mergedIds || [])]);
  const sampleIds = new Set([
    ...(person.assetIds || []),
    ...sampleClusters()
      .filter((cluster) => ids.has(cluster.id))
      .flatMap((cluster) => cluster.assetIds),
  ]);
  return (assets || [])
    .filter(
      (asset) =>
        asset.personIds?.some((id) => ids.has(id)) || sampleIds.has(asset.id),
    )
    .sort((a, b) =>
      String(b.takenAt || b.date || "").localeCompare(
        String(a.takenAt || a.date || ""),
      ),
    );
};
export function featuredAsset(person, assets) {
  const owned = personAssets(person, assets);
  if (!owned.length) return null;
  return (
    owned.find((asset) => asset.id === person.featuredAssetId) ||
    [...owned].sort(
      (a, b) =>
        (a.type === "video") - (b.type === "video") ||
        (b.bestPhotosScore || 0) - (a.bestPhotosScore || 0),
    )[0]
  );
}
export function ageAt(birthday, date = new Date()) {
  if (!isBirthday(birthday)) return null;
  let y, m, d;
  if (typeof date === "string") {
    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
    [y, m, d] = date.slice(0, 10).split("-").map(Number);
  } else if (date instanceof Date && !Number.isNaN(date.getTime())) {
    y = date.getFullYear();
    m = date.getMonth() + 1;
    d = date.getDate();
  } else return null;
  const [year, month, day] = birthday.split("-").map(Number);
  let age = y - year;
  if (m < month || (m === month && d < day)) age -= 1;
  return age < 0 ? null : age;
}
export const formatBirthday = (birthday, locale = undefined) =>
  isBirthday(birthday)
    ? new Date(`${birthday}T00:00:00Z`).toLocaleDateString(locale, {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : "";
const firstName = (person) =>
  displayName(person).toLocaleLowerCase().split(/\s+/)[0] || "";
/** Pairs worth confirming: shared first name, or an unnamed cluster whose photos overlap a person's. */
export function mergeSuggestions(people, assets) {
  const list = visiblePeople(people, { showHidden: true });
  const owned = new Map(
    list.map((person) => [
      person.id,
      new Set(personAssets(person, assets).map((asset) => asset.id)),
    ]),
  );
  const suggestions = [];
  for (let i = 0; i < list.length; i += 1)
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i],
        b = list[j];
      if (a.notSameAs?.includes(b.id) || b.notSameAs?.includes(a.id)) continue;
      const aNamed = !isUnnamed(a),
        bNamed = !isUnnamed(b);
      let reason = "",
        score = 0;
      if (aNamed && bNamed && firstName(a) === firstName(b)) {
        reason = "Both are named " + displayName(a).split(/\s+/)[0];
        score = 0.9;
      } else if (aNamed !== bNamed) {
        const setA = owned.get(a.id),
          setB = owned.get(b.id);
        const shared = [...setA].filter((id) => setB.has(id)).length;
        const smallest = Math.min(setA.size, setB.size);
        if (smallest > 0 && shared / smallest >= 0.5) {
          reason = `Both appear in ${shared} of the same ${shared === 1 ? "photo" : "photos"}`;
          score = 0.5 + (shared / smallest) * 0.3;
        }
      }
      if (!reason) continue;
      // Merge the unnamed or smaller person into the named or larger one.
      const [from, into] =
        aNamed !== bNamed
          ? aNamed
            ? [b, a]
            : [a, b]
          : owned.get(a.id).size >= owned.get(b.id).size
            ? [b, a]
            : [a, b];
      suggestions.push({
        id: `${from.id}|${into.id}`,
        from: from.id,
        into: into.id,
        reason,
        score: Math.round(score * 100) / 100,
      });
    }
  return suggestions.sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
}
export function nameSuggestions(query, people, { exclude = null, limit = 6 } = {}) {
  const text = (query || "").trim().toLocaleLowerCase();
  const seen = new Set();
  const candidates = [];
  for (const person of people || []) {
    if (!person || person.id === exclude || isUnnamed(person)) continue;
    const name = displayName(person);
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    const rank = !text
      ? 2
      : key.startsWith(text)
        ? 0
        : key.split(/\s+/).some((part) => part.startsWith(text))
          ? 1
          : key.includes(text)
            ? 2
            : -1;
    if (rank < 0) continue;
    seen.add(key);
    candidates.push({ id: person.id, name, rank });
  }
  return candidates
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ id, name }) => ({ id, name }));
}
/** Face entries for the fix-match panel: real tagged faces, plus one placeholder per untagged asset. */
export function personFaces(person, assets, faces = []) {
  if (!person) return [];
  const ids = new Set([person.id, ...(person.mergedIds || [])]);
  const owned = personAssets(person, assets);
  const ownedIds = new Set(owned.map((asset) => asset.id));
  const tagged = (faces || []).filter(
    (face) => face && ownedIds.has(face.assetId) && ids.has(face.personId),
  );
  const covered = new Set(tagged.map((face) => face.assetId));
  return [
    ...tagged.map((face) => ({
      assetId: face.assetId,
      faceId: face.faceId,
      box: face.box || null,
      personId: face.personId,
    })),
    ...owned
      .filter((asset) => !covered.has(asset.id))
      .map((asset) => ({
        assetId: asset.id,
        faceId: null,
        box: null,
        personId: person.id,
      })),
  ];
}
const setHidden = (overrides, people, hidden, predicate = () => true) =>
  (people || []).reduce(
    (next, person) =>
      predicate(person) ? togglePersonFlag(next, person.id, "hidden", hidden) : next,
    overrides || {},
  );
export const hideAll = (overrides, people) => setHidden(overrides, people, true);
export const hideUnnamed = (overrides, people) =>
  setHidden(overrides, people, true, isUnnamed);
export const showAll = (overrides, people) => setHidden(overrides, people, false);
/** Restores every person's visibility to the saved state. */
export const resetVisibility = (draft, saved, people) =>
  (people || []).reduce(
    (next, person) =>
      togglePersonFlag(next, person.id, "hidden", getOverride(saved, person.id).hidden),
    draft || {},
  );
export const pendingVisibilityChanges = (people, saved, draft) =>
  (people || []).filter(
    (person) =>
      getOverride(saved, person.id).hidden !== getOverride(draft, person.id).hidden,
  ).length;
