import assert from "node:assert/strict";
import test from "node:test";
import {
  createStudioState,
  createProofGallery,
  proofPhotos,
  applyClientFeedback,
  readStudioState,
  saveStudioState,
} from "../src/photography-data.mjs";
import {
  seedPhotographyProjects,
  deliveryBlockers,
  downloadablePhotos,
} from "../src/photography-workflow.mjs";

test("expanded projects preserve the existing studio and add examples once", () => {
  const original = createStudioState();
  original.brand.name = "My saved studio";
  original.website.layout = "slideshow";
  original.galleries["portrait-session"].delivered = true;
  const state = seedPhotographyProjects(original, createProofGallery);
  assert.equal(state.brand, original.brand);
  assert.equal(state.website, original.website);
  assert.equal(
    state.galleries["portrait-session"],
    original.galleries["portrait-session"],
  );
  assert.deepEqual(
    state.photos.slice(0, original.photos.length),
    original.photos,
  );
  assert.equal(seedPhotographyProjects(state, createProofGallery), state);
});

test("all-capture proofing excludes failed, withheld and Locked files and survives reload", () => {
  const state = seedPhotographyProjects(
    createStudioState(),
    createProofGallery,
  );
  const id = "bennett-proof-session";
  const all = proofPhotos(state, id);
  assert.equal(all.length, 12);
  assert.ok(all.every((p) => !p.selected));
  state.photos.find((p) => p.id === all[0].id).locked = true;
  const ids = proofPhotos(state, id).map((p) => p.id);
  const next = applyClientFeedback(state, id, {
    clientSelected: [...ids, all[0].id, "portrait-1"],
    submitted: true,
    comments: [],
  });
  const order = next.galleries[id].order;
  assert.deepEqual(order.photoIds, ids);
  assert.equal(order.totalCents, 2500);
  assert.equal(order.included, 10);
  const storage = {
    value: null,
    getItem() {
      return this.value;
    },
    setItem(_, value) {
      this.value = value;
    },
  };
  saveStudioState(storage, next);
  const restored = readStudioState(storage);
  assert.deepEqual(restored.galleries[id].clientSelected, ids);
  assert.deepEqual(restored.galleries[id].order, order);
  assert.equal(
    applyClientFeedback(next, id, { clientSelected: [], submitted: true }),
    next,
  );
});

test("payment, edits and approval gate only purchased finals while online marks remain", () => {
  const state = seedPhotographyProjects(
    createStudioState(),
    createProofGallery,
  );
  const id = "bennett-proof-session";
  const photos = proofPhotos(state, id);
  const next = applyClientFeedback(state, id, {
    clientSelected: photos.slice(0, 11).map((p) => p.id),
    submitted: true,
  });
  const gallery = next.galleries[id];
  gallery.delivered = true;
  gallery.downloadAllowed = true;
  assert.equal(downloadablePhotos(gallery, photos).length, 0);
  assert.ok(
    deliveryBlockers(gallery, photos).includes(
      "Collect the outstanding payment",
    ),
  );
  gallery.order.confirmed = true;
  gallery.order.payment = "paid";
  assert.equal(downloadablePhotos(gallery, photos).length, 0);
  photos.forEach((p) => {
    p.edited = true;
  });
  gallery.approved = true;
  gallery.order.finalsApproved = true;
  assert.deepEqual(deliveryBlockers(gallery, photos), []);
  assert.equal(downloadablePhotos(gallery, photos).length, 11);
  assert.equal(gallery.webWatermark, true);
  assert.equal(gallery.watermark, true);
  assert.equal(gallery.export.watermark, false);
  gallery.expired = true;
  assert.equal(downloadablePhotos(gallery, photos).length, 0);
  gallery.expired = false;
  photos[0].locked = true;
  assert.equal(downloadablePhotos(gallery, photos).length, 0);
  assert.deepEqual(deliveryBlockers({ ...gallery, order: null }, photos), [
    "Receive the client selection",
  ]);
});
