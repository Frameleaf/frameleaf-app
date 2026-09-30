import assert from "node:assert/strict";
import test from "node:test";
import {
  applyClientFeedback,
  applyEditorFeedback,
  createProofGallery,
  createStudioState,
  photographyStorageKey,
  proofPhotos,
  readStudioState,
  saveStudioState,
  toggleClientSelection,
} from "../src/photography-data.mjs";

test("proofing defaults protect originals and choices stay within the shoot", () => {
  const state = createStudioState();
  const gallery = createProofGallery("portrait-session");
  assert.equal(gallery.downloadAllowed, false);
  assert.equal(gallery.watermark, true);
  assert.equal(gallery.id, "portrait-session");
  state.photos.find((photo) => photo.id === "portrait-1").rejected = true;
  const allowed = proofPhotos(state, gallery.shootId).map((photo) => photo.id);
  assert.deepEqual(allowed, ["portrait-2", "portrait-3"]);
  assert.equal(toggleClientSelection(gallery, "alpine-1", allowed), gallery);
  const picked = toggleClientSelection(
    { ...gallery, selectionLimit: 1 },
    "portrait-2",
    allowed,
  );
  assert.deepEqual(picked.clientSelected, ["portrait-2"]);
  assert.equal(toggleClientSelection(picked, "portrait-3", allowed), picked);
  assert.deepEqual(
    toggleClientSelection(picked, "portrait-2", allowed).clientSelected,
    [],
  );
  assert.equal(
    toggleClientSelection({ ...picked, expired: true }, "portrait-2", allowed)
      .clientSelected,
    picked.clientSelected,
  );
  assert.equal(
    toggleClientSelection({ ...picked, delivered: true }, "portrait-2", allowed)
      .clientSelected,
    picked.clientSelected,
  );
});

test("client feedback round trip preserves original and deliverable references", () => {
  const state = createStudioState();
  state.galleries["portrait-session"].selectionLimit = 2;
  const next = applyClientFeedback(state, "portrait-session", {
    clientSelected: [
      "portrait-1",
      "portrait-1",
      "alpine-1",
      "portrait-2",
      "portrait-3",
    ],
    comments: [
      {
        id: "client-note",
        photoId: "portrait-2",
        author: "Jamie",
        text: "Love the light.",
      },
      {
        id: "other-shoot",
        photoId: "alpine-1",
        author: "Jamie",
        text: "Not in this gallery.",
      },
    ],
    submitted: true,
  });
  assert.equal(next.photos, state.photos);
  assert.equal(next.shoots, state.shoots);
  assert.deepEqual(next.galleries["portrait-session"].clientSelected, [
    "portrait-1",
    "portrait-2",
  ]);
  assert.equal(next.galleries["portrait-session"].comments.length, 1);
  assert.equal(next.galleries["portrait-session"].submitted, true);
  assert.equal(next.galleries["portrait-session"].approved, false);
  assert.equal(
    applyClientFeedback(next, "portrait-session", {
      clientSelected: [],
      submitted: false,
    }),
    next,
  );
  assert.equal(applyClientFeedback(state, "unknown", {}), state);
  const delivered = {
    ...next,
    galleries: {
      "portrait-session": {
        ...next.galleries["portrait-session"],
        delivered: true,
      },
    },
  };
  assert.equal(
    applyClientFeedback(delivered, "portrait-session", { clientSelected: [] }),
    delivered,
  );
});

test("editor feedback changes only ratings and edited status in its own shoot", () => {
  const state = createStudioState();
  const original = state.photos.find((photo) => photo.id === "portrait-1");
  const foreign = state.photos.find((photo) => photo.id === "alpine-1");
  const next = applyEditorFeedback(state, "portrait-session", [
    {
      id: "portrait-1",
      rating: 2,
      edited: false,
      image: "/replacement.png",
      deliverable: false,
    },
    { id: "alpine-1", rating: 0, edited: false },
  ]);
  const updated = next.photos.find((photo) => photo.id === "portrait-1");
  assert.equal(updated.rating, 2);
  assert.equal(updated.edited, false);
  assert.equal(updated.image, original.image);
  assert.equal(updated.deliverable, original.deliverable);
  assert.equal(
    next.photos.find((photo) => photo.id === "alpine-1"),
    foreign,
  );
  assert.equal(next.shoots, state.shoots);
  assert.equal(next.galleries, state.galleries);
  assert.equal(
    applyEditorFeedback(state, "foreign-shoot", [
      { id: "portrait-1", rating: 0 },
    ]),
    state,
  );
  assert.equal(
    applyEditorFeedback(state, "portrait-session", [
      { id: "alpine-1", rating: 0 },
    ]),
    state,
  );
});

test("persistence survives unavailable storage and repairs malformed local state", () => {
  const state = createStudioState();
  const memory = new Map();
  const storage = {
    getItem: (key) => memory.get(key),
    setItem: (key, value) => memory.set(key, value),
  };
  assert.equal(saveStudioState(storage, state), true);
  assert.deepEqual(readStudioState(storage), state);
  const broken = {
    getItem() {
      throw new Error("unavailable");
    },
    setItem() {
      throw new Error("full");
    },
  };
  assert.equal(saveStudioState(broken, state), false);
  assert.deepEqual(readStudioState(broken), createStudioState());
  storage.setItem(photographyStorageKey, "{broken");
  assert.deepEqual(readStudioState(storage), createStudioState());
  state.website.order = "bad order";
  state.galleries["portrait-session"].comments = [null, { text: 12 }];
  state.galleries["portrait-session"].clientSelected = [
    "alpine-1",
    "portrait-1",
    "portrait-1",
  ];
  saveStudioState(storage, state);
  const repaired = readStudioState(storage);
  assert.ok(Array.isArray(repaired.website.order));
  assert.deepEqual(repaired.galleries["portrait-session"].comments, []);
  assert.deepEqual(repaired.galleries["portrait-session"].clientSelected, [
    "portrait-1",
  ]);
  state.publishing.server = {};
  saveStudioState(storage, state);
  assert.deepEqual(readStudioState(storage), createStudioState());
  const fresh = createStudioState();
  fresh.brand.name = "Changed";
  assert.equal(createStudioState().brand.name, "Cedar & Light");
});
