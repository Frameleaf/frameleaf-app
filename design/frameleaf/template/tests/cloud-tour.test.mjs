import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUD_TOUR_KEY,
  TOUR_ENDINGS,
  clampTourStep,
  cloudTourStatus,
  cloudTourSteps,
  createCloudTour,
  loadCloudTour,
  markCloudTourSeen,
  saveCloudTour,
  shouldOfferCloudTour,
} from "../src/cloud-tour.mjs";
import { approveDeviceLink, createCloudState, startDeviceLink } from "../src/frameleaf-cloud-data.mjs";
import { settingsSections } from "../src/settings-catalog.mjs";

const memoryStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

const linked = () => {
  const now = Date.now();
  return approveDeviceLink(startDeviceLink(createCloudState(), now), { email: "taylor@example.invalid" }, now);
};

test("the tour is short and every step opens a real settings page", () => {
  assert.ok(cloudTourSteps.length >= 3 && cloudTourSteps.length <= 6);
  const ids = cloudTourSteps.map((step) => step.id);
  assert.deepEqual(ids, ["remote", "address", "signin", "processing", "backup", "plan"]);
  for (const step of cloudTourSteps) {
    assert.ok(step.title && step.summary && step.icon, step.id);
    assert.ok(step.points.length >= 1 && step.points.length <= 3, step.id);
    assert.ok(step.links.length >= 1, step.id);
    for (const link of step.links) {
      const sections = settingsSections[link.area];
      assert.ok(sections, `${step.id}: unknown area ${link.area}`);
      if (link.section)
        assert.ok(
          sections.some((section) => section.id === link.section),
          `${step.id}: ${link.area}/${link.section} does not exist`,
        );
    }
  }
});

test("prices are in US dollars and customer copy avoids source terms", () => {
  const copy = JSON.stringify(cloudTourSteps);
  assert.match(copy, /\$6 a month/);
  assert.match(copy, /US dollars/);
  assert.doesNotMatch(copy, /\bfork\b|Immich|RunPod|€|£/i);
});

test("status reflects this server instead of promising features that need a plan", () => {
  const state = linked();
  assert.equal(cloudTourStatus("remote", state).label, "Needs a plan");
  assert.equal(cloudTourStatus("backup", state).label, "Needs a plan");
  assert.equal(cloudTourStatus("signin", state).label, "Available");
  assert.match(cloudTourStatus("processing", state).label, /^Off · \$\d+\.\d\d AI credit$/);
  assert.equal(cloudTourStatus("plan", state).label, "No plan");

  const planned = {
    ...state,
    license: {
      ...state.license,
      state: "active",
      plan: "cloud-monthly",
      renewsOn: "2099-01-01",
      entitlements: { ...state.license.entitlements, remoteAccess: true, cloudBackup: true },
    },
    remote: { ...state.remote, enabled: true },
  };
  assert.equal(cloudTourStatus("remote", planned).label, "On");
  assert.equal(cloudTourStatus("address", planned).label, "Frameleaf address ready");
  assert.equal(cloudTourStatus("backup", planned).label, "Ready to set up");
});

test("offered once per administrator, only when linked and never during setup", () => {
  const empty = createCloudTour();
  const base = { tour: empty, adminId: "taylor", isAdmin: true, linkStatus: "linked" };
  assert.equal(shouldOfferCloudTour(base), true);
  assert.equal(shouldOfferCloudTour({ ...base, linkStatus: "pending" }), false);
  assert.equal(shouldOfferCloudTour({ ...base, linkStatus: "unlinked" }), false);
  assert.equal(shouldOfferCloudTour({ ...base, isAdmin: false }), false);
  assert.equal(shouldOfferCloudTour({ ...base, inSetup: true }), false);

  const seen = markCloudTourSeen(empty, "taylor", "skipped", Date.UTC(2026, 8, 27));
  assert.equal(shouldOfferCloudTour({ ...base, tour: seen }), false);
  // Another administrator still sees it once.
  assert.equal(shouldOfferCloudTour({ ...base, tour: seen, adminId: "morgan" }), true);
  // The first ending is kept.
  assert.equal(markCloudTourSeen(seen, "taylor", "finished"), seen);
  assert.deepEqual(markCloudTourSeen(empty, "taylor", "setup").seenBy.taylor.how, "setup");
  assert.throws(() => markCloudTourSeen(empty, "taylor", "closed"));
  assert.deepEqual(TOUR_ENDINGS, ["finished", "skipped", "opened-settings", "setup"]);
});

test("tour memory survives reloads and ignores damaged storage", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadCloudTour(storage), createCloudTour());
  const tour = markCloudTourSeen(createCloudTour(), "taylor", "finished", Date.UTC(2026, 8, 27));
  assert.equal(saveCloudTour(tour, storage), true);
  assert.deepEqual(loadCloudTour(storage), tour);

  storage.setItem(CLOUD_TOUR_KEY, "{not json");
  assert.deepEqual(loadCloudTour(storage), createCloudTour());
  storage.setItem(CLOUD_TOUR_KEY, JSON.stringify({ version: 1, seenBy: { taylor: "yes", jamie: { at: "x", how: "skipped" } } }));
  assert.deepEqual(Object.keys(loadCloudTour(storage).seenBy), ["jamie"]);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(loadCloudTour(blocked), createCloudTour());
  assert.equal(saveCloudTour(tour, blocked), false);
});

test("step requests are clamped", () => {
  assert.equal(clampTourStep("2"), 2);
  assert.equal(clampTourStep(-4), 0);
  assert.equal(clampTourStep(99), cloudTourSteps.length - 1);
  assert.equal(clampTourStep("nope"), 0);
  assert.equal(clampTourStep(null), 0);
});
