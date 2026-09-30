import assert from "node:assert/strict";
import test from "node:test";
import {
  changeProofSelection,
  publicPhoto,
  proofAccess,
} from "../src/photography-client.mjs";

test("proof selections respect the limit, can be removed, and freeze after submission", () => {
  const gallery = { selectionLimit: 2 };
  assert.deepEqual(changeProofSelection(["a"], "b", gallery).selection, [
    "a",
    "b",
  ]);
  assert.equal(
    changeProofSelection(["a", "b"], "c", gallery).error,
    "Choose up to 2 photos.",
  );
  assert.deepEqual(changeProofSelection(["a", "b"], "a", gallery).selection, [
    "b",
  ]);
  assert.ok(
    changeProofSelection(["a"], "b", { ...gallery, submitted: true }).error,
  );
});

test("expired, offline and protected galleries do not show photos until access is granted", () => {
  assert.equal(proofAccess({ expired: true }, true), "expired");
  assert.equal(proofAccess({ offline: true }, true), "offline");
  assert.equal(proofAccess({ password: "demo" }, false), "locked");
  assert.equal(proofAccess({ password: "demo" }, true), "open");
});

test("a client projection exposes only approved display facts, keeping RAW metadata private", () => {
  assert.deepEqual(
    publicPhoto({
      id: "a",
      image: "/media/portrait.png",
      name: "Portrait",
      latitude: 51,
      recipe: "private",
      originalPath: "/raw/a.nef",
    }),
    { id: "a", image: "/media/portrait.png", name: "Portrait" },
  );
});
