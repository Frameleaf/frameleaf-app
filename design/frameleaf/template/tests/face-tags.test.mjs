import test from "node:test";
import assert from "node:assert/strict";
import {
  createFaceState,
  parseFaceState,
  loadFaceState,
  saveAssetFaces,
  getAssetFaces,
  mergeFacePeople,
  mergeAssetFaceTags,
  faceSourceKey,
  canTagAsset,
  imageContentRect,
  imagePoint,
  boxFromPoints,
  adjustFaceBox,
  moveFaceBox,
  normalizeFaces,
  FACE_TAGS_KEY,
} from "../src/face-tags.mjs";
const asset = {
  id: "photo1",
  ownerId: "taylor",
  image: "/media/portrait.png",
  personIds: ["Emma"],
  people: ["Emma"],
  visibility: "timeline",
};
const people = [
  { id: "Emma", name: "Emma" },
  { id: "Jamie", name: "Jamie" },
];
const face = {
  id: "face1",
  personId: "Jamie",
  box: { x: 0.2, y: 0.3, width: 0.15, height: 0.2 },
};
const options = {
  people,
  expectedRevision: 0,
  imageWidth: 1600,
  imageHeight: 1000,
};
const storage = () => {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => data.set(key, value),
  };
};

test("manual boxes persist with revision and source dimensions without changing original people or albums", () => {
  const target = storage(),
    original = { ...asset, albumIds: ["family", "trip"] };
  const saved = saveAssetFaces(original, [face], options, target);
  assert.equal(saved.revision, 1);
  assert.equal(loadFaceState(target).assets.photo1.imageWidth, 1600);
  assert.deepEqual(getAssetFaces(saved, original), [face]);
  const merged = mergeAssetFaceTags([original], saved, people)[0];
  assert.deepEqual(merged.personIds, ["Emma", "Jamie"]);
  assert.deepEqual(merged.people, ["Emma", "Jamie"]);
  assert.deepEqual(merged.albumIds, ["family", "trip"]);
  assert.deepEqual(original.personIds, ["Emma"]);
  const removed = saveAssetFaces(
    original,
    [],
    { ...options, expectedRevision: 1 },
    target,
  );
  assert.deepEqual(
    mergeAssetFaceTags([original], removed, people)[0].personIds,
    ["Emma"],
  );
});

test("stale revisions and changed sources refuse writes and preserve the existing record", () => {
  const target = storage();
  saveAssetFaces(asset, [face], options, target);
  const before = target.getItem(FACE_TAGS_KEY);
  assert.throws(
    () => saveAssetFaces(asset, [], options, target),
    /another view/,
  );
  assert.throws(
    () =>
      saveAssetFaces(
        asset,
        [],
        { ...options, expectedRevision: 1, sourceKey: "old" },
        target,
      ),
    /image changed/,
  );
  assert.equal(target.getItem(FACE_TAGS_KEY), before);
  assert.deepEqual(
    getAssetFaces(loadFaceState(target), { ...asset, image: "/different.png" }),
    [],
  );
  assert.deepEqual(
    getAssetFaces(loadFaceState(target), {
      ...asset,
      checksum: "new-checksum",
    }),
    [],
  );
});

test("owner and Locked restrictions are enforced before persistence", () => {
  const target = storage();
  for (const change of [
    { ownerId: "jamie" },
    { isSensitive: true },
    { readOnly: true },
    { canEdit: false },
    { accessRevoked: true },
    { status: "Trashed" },
    { deletedAt: "2026-09-19" },
  ])
    assert.throws(
      () => saveAssetFaces({ ...asset, ...change }, [face], options, target),
      /no longer available/,
    );
  assert.equal(target.getItem(FACE_TAGS_KEY), null);
  assert.equal(
    canTagAsset({ ...asset, isSensitive: true }, { unlocked: true }),
    true,
  );
  assert.equal(
    saveAssetFaces(
      { ...asset, isSensitive: true },
      [face],
      { ...options, unlocked: true },
      target,
    ).revision,
    1,
  );
});

test("invalid boxes and unknown people never persist", () => {
  const target = storage();
  for (const box of [
    { x: -0.1, y: 0, width: 0.2, height: 0.2 },
    { x: 0.9, y: 0.1, width: 0.2, height: 0.2 },
    { x: 0, y: 0, width: 0, height: 0.2 },
    { x: 0, y: 0, width: NaN, height: 0.2 },
  ])
    assert.throws(() =>
      saveAssetFaces(asset, [{ ...face, box }], options, target),
    );
  assert.throws(
    () =>
      saveAssetFaces(
        asset,
        [{ ...face, personId: "unknown" }],
        options,
        target,
      ),
    /no longer available/,
  );
  assert.throws(() => normalizeFaces([face, face]), /valid region/);
  assert.equal(target.getItem(FACE_TAGS_KEY), null);
});

test("new identities use accessible face evidence for avatars and disappear from the people view when no evidence is accessible", () => {
  const target = storage(),
    newPerson = { id: "manual-person-new", name: "Robin" },
    assigned = { ...face, personId: newPerson.id };
  const saved = saveAssetFaces(
    asset,
    [assigned],
    { ...options, newPeople: [newPerson] },
    target,
  );
  assert.deepEqual(mergeFacePeople(people, saved, []), []);
  const merged = mergeFacePeople(people, saved, [asset]);
  assert.deepEqual(
    merged.map((person) => person.name),
    ["Emma", "Robin"],
  );
  const robin = merged.find((person) => person.id === newPerson.id);
  assert.equal(robin.image, asset.image);
  assert.deepEqual(robin.faceBox, face.box);
  assert.equal(robin.imageWidth, 1600);
  assert.deepEqual(
    mergeFacePeople(people, saved, [{ ...asset, ownerId: "jamie" }]),
    [],
  );
});

test("another owner’s private identity cannot be injected onto an accessible photo", () => {
  const raw = {
    ...createFaceState(),
    people: [
      {
        id: "manual-person-foreign",
        ownerId: "jamie",
        name: "Private Jamie name",
      },
    ],
    assets: {
      photo1: {
        ownerId: "taylor",
        sourceKey: faceSourceKey(asset),
        imageWidth: 1000,
        imageHeight: 1000,
        updatedAt: "2026-09-19T12:00:00Z",
        faces: [{ ...face, personId: "manual-person-foreign" }],
      },
    },
  };
  assert.throws(() => parseFaceState(raw), /could not be read/);
  assert.deepEqual(getAssetFaces(raw, asset), []);
  assert.ok(
    !mergeFacePeople([], raw, [asset]).some((person) =>
      person.name.includes("Private"),
    ),
  );
  assert.deepEqual(
    mergeFacePeople(
      [{ id: "Emma", name: "Private name", ownerId: "jamie" }],
      createFaceState(),
      [asset],
    ),
    [],
  );
});

test("corrupt saved data and storage failures are reported without erasing prior tags", () => {
  const target = storage();
  target.setItem(FACE_TAGS_KEY, "{broken");
  assert.throws(() => loadFaceState(target), /could not be read/);
  assert.throws(
    () => saveAssetFaces(asset, [face], options, target),
    /could not be read/,
  );
  assert.equal(target.getItem(FACE_TAGS_KEY), "{broken");
  assert.throws(
    () =>
      saveAssetFaces(asset, [face], options, {
        getItem: () => null,
        setItem: () => {
          throw Error("Quota exceeded");
        },
      }),
    /Quota exceeded/,
  );
});

test("face coordinates account for letterboxing and reject clicks in the margins", () => {
  const content = imageContentRect(
    { width: 1000, height: 600 },
    { width: 1000, height: 1000 },
  );
  assert.deepEqual(content, { left: 200, top: 0, width: 600, height: 600 });
  const stage = { left: 50, top: 20 };
  assert.equal(imagePoint(100, 100, stage, content), null);
  assert.deepEqual(imagePoint(550, 320, stage, content), { x: 0.5, y: 0.5 });
  assert.deepEqual(
    imagePoint(-999, 9999, stage, content, { clampToImage: true }),
    { x: 0, y: 1 },
  );
  assert.deepEqual(boxFromPoints({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 }), {
    x: 0.2,
    y: 0.3,
    width: 0.4,
    height: 0.4,
  });
  assert.equal(boxFromPoints({ x: 0.2, y: 0.3 }, { x: 0.201, y: 0.3 }), null);
});

test("numeric movement and resizing keep valid regions within the displayed source", () => {
  assert.deepEqual(moveFaceBox(face.box, 9, -9), {
    x: 0.85,
    y: 0,
    width: 0.15,
    height: 0.2,
  });
  assert.deepEqual(adjustFaceBox(face.box, "width", 9), {
    ...face.box,
    width: 0.8,
  });
  assert.equal(adjustFaceBox(face.box, "height", 0).height, 0.005);
  assert.equal(
    imageContentRect({ width: 0, height: 600 }, { width: 1000, height: 1000 }),
    null,
  );
});
