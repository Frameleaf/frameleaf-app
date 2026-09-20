import { classifyLocked } from "./locked-content.mjs";
import { safeMediaSource } from "./media-viewer.mjs";

export const FACE_TAGS_KEY = "frameleaf:face-tags:v1";
export const FACE_TAGS_EVENT = "frameleaf:face-tags-changed";
export const MIN_FACE_SIZE = 0.005;
const MAX_FACES = 100,
  MAX_ASSETS = 256,
  MAX_PEOPLE = 500,
  MAX_BYTES = 2_000_000;
const record = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = (value) =>
  typeof value === "string" &&
  /^[\p{L}\p{N}][\p{L}\p{N}_ -]{0,127}$/u.test(value) &&
  !["__proto__", "prototype", "constructor"].includes(value);
const name = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= 120 &&
  !/[\u0000-\u001f]/.test(value);
const round = (value) => Math.round(value * 1e6) / 1e6;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const invalid = () =>
  new Error(
    "Face tags could not be read. Keep this window open and try again before saving.",
  );
export const createFaceState = () => ({
  version: 1,
  revision: 0,
  people: [],
  assets: {},
});
export function validateFaceBox(box) {
  return (
    record(box) &&
    Object.keys(box).length === 4 &&
    ["x", "y", "width", "height"].every(
      (key) =>
        Object.hasOwn(box, key) &&
        typeof box[key] === "number" &&
        Number.isFinite(box[key]),
    ) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width >= MIN_FACE_SIZE &&
    box.height >= MIN_FACE_SIZE &&
    box.x + box.width <= 1.000001 &&
    box.y + box.height <= 1.000001
  );
}
export function normalizeFaces(faces) {
  if (!Array.isArray(faces) || faces.length > MAX_FACES)
    throw Error("Use no more than 100 face regions per image.");
  const seen = new Set();
  return faces.map((face) => {
    if (
      !record(face) ||
      Object.keys(face).some(
        (key) => !["id", "personId", "box"].includes(key),
      ) ||
      !id(face.id) ||
      seen.has(face.id) ||
      !id(face.personId) ||
      !validateFaceBox(face.box)
    )
      throw Error(
        "Each face needs a person and a valid region inside the image.",
      );
    seen.add(face.id);
    return {
      id: face.id,
      personId: face.personId,
      box: Object.fromEntries(
        Object.entries(face.box).map(([key, value]) => [key, round(value)]),
      ),
    };
  });
}
export function faceSourceKey(asset) {
  const source = safeMediaSource(asset?.fullSrc || asset?.image || asset?.src);
  return source && id(asset?.id)
    ? JSON.stringify([
        asset.id,
        source,
        String(asset.checksum || asset.sourceVersion || ""),
      ])
    : null;
}
export function canTagAsset(
  asset,
  { actorId = "taylor", unlocked = false } = {},
) {
  return (
    !!faceSourceKey(asset) &&
    asset.ownerId === actorId &&
    asset.canEdit !== false &&
    asset.canView !== false &&
    asset.accessible !== false &&
    !asset.readOnly &&
    !asset.accessRevoked &&
    !asset.deletedAt &&
    !asset.isTrashed &&
    !["Trashed", "Deleted"].includes(asset.status) &&
    asset.visibility !== "hidden" &&
    (!classifyLocked(asset) || unlocked === true)
  );
}
export function parseFaceState(raw) {
  if (raw === null || raw === undefined || raw === "") return createFaceState();
  if (typeof raw === "string" && raw.length > MAX_BYTES) throw invalid();
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw invalid();
  }
  if (
    !record(data) ||
    Object.keys(data).some(
      (key) => !["version", "revision", "people", "assets"].includes(key),
    ) ||
    data.version !== 1 ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0 ||
    !Array.isArray(data.people) ||
    data.people.length > MAX_PEOPLE ||
    !record(data.assets) ||
    Object.keys(data.assets).length > MAX_ASSETS
  )
    throw invalid();
  const peopleIds = new Set();
  const people = data.people.map((person) => {
    if (
      !record(person) ||
      Object.keys(person).some(
        (key) => !["id", "name", "ownerId"].includes(key),
      ) ||
      !id(person.id) ||
      peopleIds.has(person.id) ||
      !id(person.ownerId) ||
      !name(person.name)
    )
      throw invalid();
    peopleIds.add(person.id);
    return { id: person.id, name: person.name.trim(), ownerId: person.ownerId };
  });
  const assets = {};
  for (const [assetId, entry] of Object.entries(data.assets)) {
    if (
      !id(assetId) ||
      !record(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "ownerId",
            "sourceKey",
            "imageWidth",
            "imageHeight",
            "updatedAt",
            "faces",
          ].includes(key),
      ) ||
      !id(entry.ownerId) ||
      typeof entry.sourceKey !== "string" ||
      entry.sourceKey.length > 4096 ||
      ![entry.imageWidth, entry.imageHeight].every(
        (value) => Number.isSafeInteger(value) && value > 0 && value <= 100_000,
      ) ||
      typeof entry.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(entry.updatedAt))
    )
      throw invalid();
    let faces;
    try {
      faces = normalizeFaces(entry.faces);
    } catch {
      throw invalid();
    }
    assets[assetId] = {
      ownerId: entry.ownerId,
      sourceKey: entry.sourceKey,
      imageWidth: entry.imageWidth,
      imageHeight: entry.imageHeight,
      updatedAt: entry.updatedAt,
      faces,
    };
  }
  const identities = new Map(people.map((person) => [person.id, person]));
  for (const entry of Object.values(assets)) {
    for (const face of entry.faces) {
      const identity = identities.get(face.personId);
      if (
        (identity && identity.ownerId !== entry.ownerId) ||
        (face.personId.startsWith("manual-person-") && !identity)
      )
        throw invalid();
    }
  }
  return { version: 1, revision: data.revision, people, assets };
}
export function loadFaceState(storage = localStorage) {
  return parseFaceState(storage.getItem(FACE_TAGS_KEY));
}
export function subscribeFaceState(callback, storage = localStorage) {
  const sync = (event) => {
    if (
      event.type === FACE_TAGS_EVENT ||
      event.key === FACE_TAGS_KEY ||
      event.key === null
    ) {
      try {
        callback(loadFaceState(storage));
      } catch (error) {
        callback(null, error);
      }
    }
  };
  window.addEventListener("storage", sync);
  window.addEventListener(FACE_TAGS_EVENT, sync);
  return () => {
    window.removeEventListener("storage", sync);
    window.removeEventListener(FACE_TAGS_EVENT, sync);
  };
}
export function getAssetFaces(state, asset) {
  const entry = state?.assets?.[asset?.id];
  const identities = new Map(
    (state?.people || []).map((person) => [person.id, person]),
  );
  return entry &&
    entry.ownerId === asset.ownerId &&
    entry.sourceKey === faceSourceKey(asset)
    ? structuredClone(
        entry.faces.filter((face) => {
          const identity = identities.get(face.personId);
          return identity
            ? identity.ownerId === asset.ownerId
            : !face.personId.startsWith("manual-person-");
        }),
      )
    : [];
}
export function saveAssetFaces(
  asset,
  faces,
  {
    newPeople = [],
    people = [],
    expectedRevision,
    actorId = "taylor",
    unlocked = false,
    imageWidth,
    imageHeight,
    sourceKey,
  } = {},
  storage = localStorage,
) {
  if (!canTagAsset(asset, { actorId, unlocked }))
    throw Error("This image is no longer available for face tagging.");
  const current = loadFaceState(storage);
  if (expectedRevision !== current.revision)
    throw Error(
      "Face tags changed in another view. Close and reopen this image before saving.",
    );
  if (
    current.revision >= Number.MAX_SAFE_INTEGER ||
    (sourceKey !== undefined && sourceKey !== faceSourceKey(asset))
  )
    throw Error("The image changed. Reopen it before placing faces.");
  if (
    ![imageWidth, imageHeight].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= 100_000,
    )
  )
    throw Error("Wait for the full image to load before saving face tags.");
  const normalized = normalizeFaces(faces);
  if (
    !Array.isArray(newPeople) ||
    newPeople.length > MAX_FACES ||
    !Array.isArray(people)
  )
    throw Error("Choose a valid person for each face.");
  const known = new Map(
    [
      ...people.filter(
        (person) => person && (!person.ownerId || person.ownerId === actorId),
      ),
      ...current.people.filter((person) => person.ownerId === actorId),
    ].map((person) => [person.id, person]),
  );
  const added = [];
  for (const person of newPeople) {
    if (
      !record(person) ||
      Object.keys(person).some((key) => !["id", "name"].includes(key)) ||
      !id(person.id) ||
      !person.id.startsWith("manual-person-") ||
      !name(person.name) ||
      known.has(person.id)
    )
      throw Error("Choose a unique person with a valid name.");
    const next = { id: person.id, name: person.name.trim(), ownerId: actorId };
    known.set(next.id, next);
    added.push(next);
  }
  if (normalized.some((face) => !known.has(face.personId)))
    throw Error("A person is no longer available. Assign the face again.");
  const assets = {
    ...current.assets,
    [asset.id]: {
      ownerId: actorId,
      sourceKey: faceSourceKey(asset),
      imageWidth,
      imageHeight,
      faces: normalized,
      updatedAt: new Date().toISOString(),
    },
  };
  const referenced = new Set(
    Object.values(assets).flatMap((entry) =>
      entry.faces.map((face) => face.personId),
    ),
  );
  const next = parseFaceState({
    version: 1,
    revision: current.revision + 1,
    people: [...current.people, ...added].filter((person) =>
      referenced.has(person.id),
    ),
    assets,
  });
  const serialized = JSON.stringify(next);
  if (serialized.length > MAX_BYTES)
    throw Error(
      "The face-tag collection is full. Remove unused regions before adding more.",
    );
  storage.setItem(FACE_TAGS_KEY, serialized);
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(FACE_TAGS_EVENT));
  return next;
}
/** Pass only currently accessible assets. Avatar evidence is chosen from that set. */
export function mergeFacePeople(
  basePeople,
  state,
  accessibleAssets,
  { actorId = "taylor" } = {},
) {
  const evidence = new Map(),
    ids = new Set(),
    names = new Set();
  for (const asset of accessibleAssets || []) {
    if (asset.ownerId !== actorId) continue;
    for (const personId of asset.personIds || []) ids.add(personId);
    for (const person of asset.people || [])
      if (typeof person === "string") names.add(person);
    for (const face of getAssetFaces(state, asset))
      if (!evidence.has(face.personId)) {
        ids.add(face.personId);
        evidence.set(face.personId, {
          asset,
          face,
          entry: state.assets[asset.id],
        });
      }
  }
  const derived = (state?.people || [])
    .filter((person) => person.ownerId === actorId && evidence.has(person.id))
    .map((person) => {
      const { asset, face, entry } = evidence.get(person.id);
      return {
        ...person,
        image: asset.fullSrc || asset.image || asset.src,
        faceBox: face.box,
        imageWidth: entry.imageWidth,
        imageHeight: entry.imageHeight,
      };
    });
  const visiblePeople = basePeople.filter(
    (person) =>
      (!person.ownerId || person.ownerId === actorId) &&
      (ids.has(person.id) || names.has(person.name)),
  );
  const known = new Set(visiblePeople.map((person) => person.id));
  return [
    ...visiblePeople,
    ...derived.filter((person) => !known.has(person.id)),
  ];
}
/** Always merge into source assets, not a previously merged result, so removals do not leave ghost people. */
export function mergeAssetFaceTags(assets, state, people) {
  const names = new Map(people.map((person) => [person.id, person.name]));
  return assets.map((asset) => {
    const manualFaces = getAssetFaces(state, asset),
      baselineIds = Array.isArray(asset.personIds) ? asset.personIds : [];
    return {
      ...asset,
      manualFaces,
      personIds: [
        ...new Set([
          ...baselineIds,
          ...manualFaces.map((face) => face.personId),
        ]),
      ],
      people: [
        ...new Set([
          ...(Array.isArray(asset.people) ? asset.people : []),
          ...manualFaces
            .map((face) => names.get(face.personId))
            .filter(Boolean),
        ]),
      ],
    };
  });
}
export function imageContentRect(viewport, natural) {
  if (
    ![viewport?.width, viewport?.height, natural?.width, natural?.height].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  const scale = Math.min(
    viewport.width / natural.width,
    viewport.height / natural.height,
  );
  const width = natural.width * scale,
    height = natural.height * scale;
  return {
    left: (viewport.width - width) / 2,
    top: (viewport.height - height) / 2,
    width,
    height,
  };
}
export function imagePoint(
  clientX,
  clientY,
  stageRect,
  contentRect,
  { clampToImage = false } = {},
) {
  if (!contentRect) return null;
  const x = (clientX - stageRect.left - contentRect.left) / contentRect.width,
    y = (clientY - stageRect.top - contentRect.top) / contentRect.height;
  if (
    ![x, y].every(Number.isFinite) ||
    (!clampToImage && (x < 0 || x > 1 || y < 0 || y > 1))
  )
    return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}
export function boxFromPoints(start, end) {
  if (!start || !end) return null;
  const box = {
    x: round(Math.min(start.x, end.x)),
    y: round(Math.min(start.y, end.y)),
    width: round(Math.abs(start.x - end.x)),
    height: round(Math.abs(start.y - end.y)),
  };
  return validateFaceBox(box) ? box : null;
}
export function adjustFaceBox(box, field, value) {
  if (
    !validateFaceBox(box) ||
    !["x", "y", "width", "height"].includes(field) ||
    !Number.isFinite(value)
  )
    return box;
  const max =
    field === "x"
      ? 1 - box.width
      : field === "y"
        ? 1 - box.height
        : field === "width"
          ? 1 - box.x
          : 1 - box.y;
  return {
    ...box,
    [field]: round(
      clamp(
        value,
        field === "width" || field === "height" ? MIN_FACE_SIZE : 0,
        max,
      ),
    ),
  };
}
export function moveFaceBox(box, dx, dy) {
  return adjustFaceBox(adjustFaceBox(box, "x", box.x + dx), "y", box.y + dy);
}
export const faceId = () => `manual-face-${crypto.randomUUID()}`;
export const personId = () => `manual-person-${crypto.randomUUID()}`;
