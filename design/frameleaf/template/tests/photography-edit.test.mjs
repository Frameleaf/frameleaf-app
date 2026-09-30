import assert from "node:assert/strict";
import { cancelBatch, createBatch, createSession, normalizeMask, normalizePoint, recoverSession, retryBatch, saveSession, syncEdits, tickBatch, updatePhoto } from "../src/photography-edit.mjs";

const originals = Object.freeze([
  Object.freeze({ id: "a", image: "/media/portrait.png", name: "IMG_001.CR3", raw: true }),
  Object.freeze({ id: "b", image: "/media/forest.png", name: "IMG_002.X3F", extension: "X3F", raw: true }),
]);
let session = createSession(originals);
session = updatePhoto(session, "a", { exposure: 0.8, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } });
session = syncEdits(session, "a", ["b"], ["tone"]);
assert.equal(session.records.b.history.present.exposure, 0.8);
assert.equal(session.records.b.history.present.crop.w, 1, "sync must respect unchecked geometry");
assert.deepEqual(Object.keys(originals[0]), ["id", "image", "name", "raw"], "source metadata stays immutable");
assert.deepEqual(normalizePoint({ x: -4, y: 2 }), { x: 0, y: 1 });
assert.deepEqual(normalizePoint({ x: NaN, y: Infinity }), { x: 0.5, y: 0.5 });
const normalizedMask = normalizeMask({ type: "brush", center: { x: -1, y: 3 }, strokes: [{ mode: "subtract", size: 5, points: [{ x: -2, y: 4 }] }] });
assert.deepEqual(normalizedMask.center, { x: 0, y: 1 });
assert.deepEqual(normalizedMask.strokes[0].points, [{ x: 0, y: 1 }]);
assert.equal(normalizedMask.strokes[0].size, 0.4);
assert.equal(recoverSession(originals, "{broken").records.a.history.present.exposure, 0);
assert.equal(saveSession({ setItem() { throw new Error("quota"); } }, "key", session), false);
const restored = recoverSession(originals, JSON.stringify(session));
assert.equal(restored.records.a.history.present.exposure, 0.8);
assert.equal(restored.records.b.history.present.crop.w, 1);
assert.equal(recoverSession([{ ...originals[0], rating: 5 }], JSON.stringify(session)).records.a.rating, 5, "latest culling rating wins over stale editor storage");
assert.throws(() => createBatch(originals, ["a"], { format: "JPEG" }), /2–5/);
let queue = createBatch(originals, ["a", "b"], { format: "JPEG" });
queue = tickBatch(queue);
assert.equal(queue.items[0].status, "running");
queue = cancelBatch(queue);
assert.equal(queue.status, "cancelled");
assert.ok(queue.items.every((item) => item.status === "cancelled"));
assert.equal(tickBatch(queue), queue, "cancel is terminal; no late completion");
queue = retryBatch(queue, "a");
for (let i = 0; i < 7; i++) queue = tickBatch(queue);
assert.equal(queue.items[0].status, "complete");
assert.equal(queue.items[1].status, "cancelled", "retry does not restart other cancelled files");
assert.equal(cancelBatch({ ...queue, status: "running" }).items[0].status, "complete", "cancel keeps already completed photos");
queue = retryBatch(queue, "b");
for (let i = 0; i < 7; i++) queue = tickBatch(queue);
assert.equal(queue.items[1].status, "failed");
assert.match(queue.items[1].error, /unsupported/i);
queue = retryBatch(queue, "b", { previewOnly: true });
for (let i = 0; i < 7; i++) queue = tickBatch(queue);
assert.equal(queue.items[1].status, "complete");
assert.equal(queue.items[1].previewOnly, true, "retry must explicitly use the mock preview, never claim a RAW decode");
console.log("photography edit: immutable originals, normalized masks, scoped sync, recovery and cancel/retry passed");
