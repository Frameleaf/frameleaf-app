import test from "node:test";
import assert from "node:assert/strict";
import { media, people as basePeople } from "../src/media.js";
import {
  PEOPLE_KEY,
  ageAt,
  applyPeopleOverrides,
  dismissSuggestion,
  featuredAsset,
  formatBirthday,
  hideAll,
  hideUnnamed,
  mergePeople,
  mergeSuggestions,
  nameSuggestions,
  parsePeopleOverrides,
  pendingVisibilityChanges,
  personAssets,
  personFaces,
  readPeopleOverrides,
  remapAssetPeople,
  resetVisibility,
  resolvePersonId,
  sampleClusters,
  savePeopleOverrides,
  setBirthday,
  setFeaturedAsset,
  setPersonName,
  showAll,
  togglePersonFlag,
  visiblePeople,
} from "../src/people-data.mjs";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}
const find = (list, id) => list.find((person) => person.id === id);
const count = (person, assets) => personAssets(person, assets).length;

test("parsing is defensive and never throws", () => {
  assert.deepEqual(parsePeopleOverrides(null), {});
  assert.deepEqual(parsePeopleOverrides(""), {});
  assert.deepEqual(parsePeopleOverrides("{not json"), {});
  assert.deepEqual(parsePeopleOverrides("[]"), {});
  assert.deepEqual(parsePeopleOverrides({ version: 2, people: { Jamie: {} } }), {});
  assert.deepEqual(parsePeopleOverrides("x".repeat(600_000)), {});
  const parsed = parsePeopleOverrides(
    JSON.stringify({
      version: 1,
      people: {
        Jamie: {
          name: "  Jamie Taylor ",
          birthday: "2012-02-30",
          hidden: "yes",
          favorite: true,
          featuredAssetId: 12,
          color: "neon",
          notSameAs: ["Emma", "Jamie", 4, "Emma"],
          extra: true,
        },
        Emma: { birthday: "2012-03-04", mergedInto: "Emma" },
        Taylor: {},
        "__proto__": { hidden: true },
        "bad id!": { hidden: true },
      },
    }),
  );
  assert.deepEqual(parsed, {
    Jamie: {
      name: "Jamie Taylor",
      birthday: null,
      hidden: false,
      favorite: true,
      featuredAssetId: null,
      mergedInto: null,
      color: null,
      notSameAs: ["Emma"],
    },
    Emma: {
      name: null,
      birthday: "2012-03-04",
      hidden: false,
      favorite: false,
      featuredAssetId: null,
      mergedInto: null,
      color: null,
      notSameAs: [],
    },
  });
  assert.equal(Object.hasOwn(parsed, "__proto__"), false);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
});

test("merge cycles are broken when parsing", () => {
  const parsed = parsePeopleOverrides({
    a: { mergedInto: "b" },
    b: { mergedInto: "c" },
    c: { mergedInto: "a" },
  });
  const ids = Object.keys(parsed);
  for (const id of ids) {
    const seen = new Set();
    let cursor = id;
    while (parsed[cursor]?.mergedInto) {
      assert.equal(seen.has(cursor), false, `cycle through ${cursor}`);
      seen.add(cursor);
      cursor = parsed[cursor].mergedInto;
    }
  }
  assert.equal(resolvePersonId("a", parsed) !== undefined, true);
});

test("save and read round-trip through storage under the people key", () => {
  const store = storage();
  const saved = savePeopleOverrides(
    setBirthday(setPersonName({}, "Jamie", "Jamie T"), "Jamie", "2012-03-04"),
    store,
  );
  assert.ok(store.values.has(PEOPLE_KEY));
  assert.deepEqual(readPeopleOverrides(store), saved);
  assert.equal(readPeopleOverrides(store).Jamie.birthday, "2012-03-04");
  store.setItem(PEOPLE_KEY, "garbage");
  assert.deepEqual(readPeopleOverrides(store), {});
});

test("empty overrides are dropped and invalid values clear a field", () => {
  let overrides = togglePersonFlag({}, "Jamie", "favorite", true);
  assert.equal(overrides.Jamie.favorite, true);
  overrides = togglePersonFlag(overrides, "Jamie", "favorite", false);
  assert.deepEqual(overrides, {});
  overrides = setBirthday({}, "Jamie", "not-a-date");
  assert.deepEqual(overrides, {});
  overrides = setBirthday(setBirthday({}, "Jamie", "2012-03-04"), "Jamie", "");
  assert.deepEqual(overrides, {});
  overrides = setFeaturedAsset({}, "Jamie", "5");
  assert.equal(overrides.Jamie.featuredAssetId, "5");
  assert.deepEqual(togglePersonFlag({}, "Jamie", "mergedInto", true), {});
});

test("sample clusters appear as unnamed people and count their assets", () => {
  const people = applyPeopleOverrides(basePeople, {});
  const clusters = sampleClusters();
  assert.equal(people.length, basePeople.length + clusters.length);
  const cluster = find(people, "cluster-unnamed-1");
  assert.equal(cluster.name, "");
  assert.equal(count(cluster, media), 4);
  const remapped = remapAssetPeople(media, {});
  assert.ok(
    remapped
      .filter((asset) => clusters[0].assetIds.includes(asset.id))
      .every((asset) => asset.personIds.includes("cluster-unnamed-1")),
  );
  assert.equal(count(cluster, remapped), 4);
  // Applying twice does not duplicate people or lose the source name.
  const twice = applyPeopleOverrides(people, {});
  assert.equal(twice.length, people.length);
  assert.equal(find(twice, "Jamie").name, "Jamie");
});

test("re-applying with changed overrides is authoritative", () => {
  const renamed = applyPeopleOverrides(
    basePeople,
    setPersonName({}, "Jamie", "Jamie Taylor"),
  );
  assert.equal(find(renamed, "Jamie").name, "Jamie Taylor");
  const reverted = applyPeopleOverrides(renamed, {});
  assert.equal(find(reverted, "Jamie").name, "Jamie");
  const hidden = applyPeopleOverrides(
    basePeople,
    togglePersonFlag({}, "Jamie", "hidden", true),
  );
  assert.equal(find(hidden, "Jamie").hidden, true);
  assert.equal(find(applyPeopleOverrides(hidden, {}), "Jamie").hidden, false);
});

test("merging moves assets to the target and removes the merged person", () => {
  const before = applyPeopleOverrides(basePeople, {});
  const jamieBefore = count(find(before, "Jamie"), media);
  const clusterBefore = count(find(before, "cluster-unnamed-1"), media);
  assert.ok(clusterBefore > 0);
  const overrides = mergePeople({}, "cluster-unnamed-1", "Jamie");
  assert.equal(overrides["cluster-unnamed-1"].mergedInto, "Jamie");
  const after = applyPeopleOverrides(basePeople, overrides);
  assert.equal(find(after, "cluster-unnamed-1"), undefined);
  const jamie = find(after, "Jamie");
  assert.deepEqual(jamie.mergedIds, ["cluster-unnamed-1"]);
  // Cluster photos all already feature Jamie, so the total stays and nothing is lost.
  assert.equal(count(jamie, media), jamieBefore);
  const jamieIds = new Set(personAssets(jamie, media).map((asset) => asset.id));
  for (const id of sampleClusters()[0].assetIds) assert.ok(jamieIds.has(id));
  // Remapped assets point at the target and no longer at the merged cluster.
  const remapped = remapAssetPeople(media, overrides);
  assert.ok(remapped.every((asset) => !asset.personIds.includes("cluster-unnamed-1")));
  assert.equal(count(jamie, remapped), jamieBefore);
  assert.equal(resolvePersonId("cluster-unnamed-1", overrides), "Jamie");
});

test("merging a disjoint person adds its assets to the target", () => {
  const overrides = mergePeople({}, "Emma", "Taylor");
  const before = applyPeopleOverrides(basePeople, {});
  const emma = count(find(before, "Emma"), media),
    taylor = count(find(before, "Taylor"), media);
  const shared = media.filter(
    (asset) => asset.personIds.includes("Emma") && asset.personIds.includes("Taylor"),
  ).length;
  const after = applyPeopleOverrides(basePeople, overrides);
  assert.equal(find(after, "Emma"), undefined);
  assert.equal(count(find(after, "Taylor"), media), emma + taylor - shared);
  assert.equal(visiblePeople(after).some((person) => person.id === "Emma"), false);
});

test("merge carries name, birthday and favorite and flattens chains", () => {
  let overrides = setPersonName({}, "cluster-unnamed-2", "Emma Rose");
  overrides = setBirthday(overrides, "cluster-unnamed-2", "2012-03-04");
  overrides = togglePersonFlag(overrides, "cluster-unnamed-2", "favorite", true);
  const people = applyPeopleOverrides(basePeople, overrides);
  overrides = mergePeople(overrides, "cluster-unnamed-2", "cluster-unnamed-1", people);
  const target = overrides["cluster-unnamed-1"];
  assert.equal(target.name, "Emma Rose");
  assert.equal(target.birthday, "2012-03-04");
  assert.equal(target.favorite, true);
  overrides = mergePeople(overrides, "cluster-unnamed-1", "Emma", people);
  assert.equal(overrides["cluster-unnamed-2"].mergedInto, "Emma");
  assert.equal(overrides["cluster-unnamed-1"].mergedInto, "Emma");
  assert.equal(resolvePersonId("cluster-unnamed-2", overrides), "Emma");
  // Emma already has a name, so the merged name does not replace it.
  assert.equal(overrides.Emma?.name ?? null, null);
  // Without the people list a name never carries over, since base names are unknown.
  assert.equal(
    mergePeople(setPersonName({}, "cluster-unnamed-2", "Rose"), "cluster-unnamed-2", "cluster-unnamed-1")["cluster-unnamed-1"]?.name ?? null,
    null,
  );
  // Self merges, reverse merges and unknown ids are ignored.
  assert.equal(mergePeople(overrides, "Emma", "Emma"), overrides);
  assert.equal(mergePeople(overrides, "Emma", "cluster-unnamed-1"), overrides);
  assert.equal(mergePeople(overrides, "bad id!", "Emma"), overrides);
});

test("age math handles birthdays before and after the date", () => {
  assert.equal(ageAt("2012-03-04", "2026-03-03"), 13);
  assert.equal(ageAt("2012-03-04", "2026-03-04"), 14);
  assert.equal(ageAt("2012-03-04", "2026-09-22T07:14:00"), 14);
  assert.equal(ageAt("2012-03-04", new Date(2026, 2, 3)), 13);
  assert.equal(ageAt("2012-03-04", new Date(2026, 2, 4)), 14);
  assert.equal(ageAt("2012-02-29", "2027-02-28"), 14);
  assert.equal(ageAt("2030-01-01", "2026-01-01"), null);
  assert.equal(ageAt("2012-13-01", "2026-01-01"), null);
  assert.equal(ageAt("2012-03-04", "soon"), null);
  assert.equal(ageAt(null), null);
  assert.equal(formatBirthday("2012-03-04", "en-US"), "March 4, 2012");
  assert.equal(formatBirthday("nope"), "");
});

test("visibility batches only touch the hidden flag", () => {
  const people = applyPeopleOverrides(basePeople, {});
  const saved = togglePersonFlag({}, "Jamie", "favorite", true);
  let draft = hideAll(saved, people);
  assert.ok(people.every((person) => draft[person.id]?.hidden === true));
  assert.equal(draft.Jamie.favorite, true);
  assert.equal(pendingVisibilityChanges(people, saved, draft), people.length);
  draft = showAll(draft, people);
  assert.ok(people.every((person) => !draft[person.id]?.hidden));
  assert.equal(pendingVisibilityChanges(people, saved, draft), 0);
  draft = hideUnnamed(saved, people);
  assert.equal(draft["cluster-unnamed-1"].hidden, true);
  assert.equal(draft["cluster-unnamed-2"].hidden, true);
  assert.equal(draft.Jamie?.hidden ?? false, false);
  assert.equal(pendingVisibilityChanges(people, saved, draft), 2);
  const savedHidden = togglePersonFlag(saved, "Emma", "hidden", true);
  draft = showAll(savedHidden, people);
  assert.equal(pendingVisibilityChanges(people, savedHidden, draft), 1);
  draft = resetVisibility(draft, savedHidden, people);
  assert.deepEqual(draft, savedHidden);
  assert.equal(pendingVisibilityChanges(people, savedHidden, draft), 0);
  const applied = applyPeopleOverrides(basePeople, savedHidden);
  assert.equal(visiblePeople(applied).some((person) => person.id === "Emma"), false);
  assert.equal(
    visiblePeople(applied, { showHidden: true }).some((person) => person.id === "Emma"),
    true,
  );
});

test("merge suggestions pair unnamed clusters with co-occurring people and can be dismissed", () => {
  const people = applyPeopleOverrides(basePeople, {});
  const suggestions = mergeSuggestions(people, media);
  assert.ok(suggestions.some((s) => s.from === "cluster-unnamed-1" && s.into === "Jamie"));
  assert.ok(suggestions.some((s) => s.from === "cluster-unnamed-2" && s.into === "Emma"));
  assert.ok(suggestions.every((s) => s.reason && s.score > 0));
  const dismissed = dismissSuggestion({}, "cluster-unnamed-1", "Jamie");
  const after = mergeSuggestions(applyPeopleOverrides(basePeople, dismissed), media);
  assert.equal(after.some((s) => s.from === "cluster-unnamed-1" && s.into === "Jamie"), false);
  assert.ok(after.some((s) => s.from === "cluster-unnamed-2"));
  const named = applyPeopleOverrides(
    basePeople,
    setPersonName({}, "cluster-unnamed-2", "Emma Rose"),
  );
  const byName = mergeSuggestions(named, media);
  const pair = byName.find((s) => s.from === "cluster-unnamed-2" && s.into === "Emma");
  assert.ok(pair);
  assert.match(pair.reason, /named Emma/);
  const merged = applyPeopleOverrides(basePeople, mergePeople({}, "cluster-unnamed-1", "Jamie"));
  assert.equal(mergeSuggestions(merged, media).some((s) => s.from === "cluster-unnamed-1"), false);
});

test("name suggestions rank prefixes first and exclude the person being renamed", () => {
  const people = applyPeopleOverrides(
    [...basePeople, { id: "x", name: "Sam Emmerson" }, { id: "y", name: "Emma" }],
    {},
  );
  assert.deepEqual(
    nameSuggestions("em", people).map((s) => s.name),
    ["Emma", "Sam Emmerson"],
  );
  assert.deepEqual(
    nameSuggestions("em", people, { exclude: "Emma" }).map((s) => s.name),
    ["Emma", "Sam Emmerson"],
  );
  assert.deepEqual(
    nameSuggestions("em", people, { exclude: "Emma" }).map((s) => s.id),
    ["y", "x"],
  );
  assert.equal(nameSuggestions("", people).length, 4);
  assert.equal(nameSuggestions("zzz", people).length, 0);
  assert.ok(nameSuggestions("", people).every((s) => !/unnamed/i.test(s.name)));
});

test("featured asset honors the override and otherwise prefers the best photo", () => {
  const people = applyPeopleOverrides(basePeople, {});
  const jamie = find(people, "Jamie");
  const auto = featuredAsset(jamie, media);
  assert.equal(auto.type, "photo");
  assert.ok(personAssets(jamie, media).every((asset) =>
    asset.type === "video" || asset.bestPhotosScore <= auto.bestPhotosScore,
  ));
  const chosen = find(applyPeopleOverrides(basePeople, setFeaturedAsset({}, "Jamie", "1")), "Jamie");
  assert.equal(featuredAsset(chosen, media).id, "1");
  const stale = find(applyPeopleOverrides(basePeople, setFeaturedAsset({}, "Jamie", "8")), "Jamie");
  assert.equal(featuredAsset(stale, media).id, auto.id);
  assert.equal(featuredAsset({ id: "nobody" }, media), null);
});

test("person faces include tagged regions and placeholders for untagged photos", () => {
  const people = applyPeopleOverrides(basePeople, {});
  const jamie = find(people, "Jamie");
  const owned = personAssets(jamie, media);
  const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
  const faces = personFaces(jamie, media, [
    { assetId: owned[0].id, faceId: "f1", box, personId: "Jamie" },
    { assetId: owned[0].id, faceId: "f2", box, personId: "Emma" },
    { assetId: "zzz", faceId: "f3", box, personId: "Jamie" },
  ]);
  assert.equal(faces.length, owned.length);
  assert.equal(faces[0].faceId, "f1");
  assert.ok(faces.slice(1).every((face) => face.faceId === null && face.box === null));
  assert.equal(personFaces(null, media).length, 0);
});
