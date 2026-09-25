import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allSettings,
  defaultSettings,
  findSettings,
  settingsAreas,
  settingsDiff,
  settingsIndex,
  settingsSections,
  validateSetting,
} from "../src/settings-catalog.mjs";
import { settingsExtensions } from "../src/settings-advanced.mjs";

test("catalog defaults are valid and setting identities do not collide across areas", () => {
  const ids = new Set();
  const areaIds = new Set(settingsAreas.map((area) => area.id));
  for (const field of allSettings) {
    assert.ok(
      field.id && !ids.has(field.id),
      `Duplicate or missing field ID: ${field.id}`,
    );
    ids.add(field.id);
    assert.ok(areaIds.has(field.area), `Unknown area for ${field.id}`);
    assert.equal(
      validateSetting(field, defaultSettings[field.id]),
      "",
      `Invalid default for ${field.id}`,
    );
    if (field.type === "select") {
      const optionValues = field.options.map(
        (option) => option.value ?? option,
      );
      assert.equal(
        new Set(optionValues).size,
        optionValues.length,
        `Duplicate option value for ${field.id}`,
      );
    }
  }
  assert.deepEqual(new Set(Object.keys(defaultSettings)), ids);
});

test("settings search combines terms across explanatory content and ignores case and extra whitespace", () => {
  const snapshot = structuredClone(settingsIndex);
  const matches = findSettings("  OAUTH\t QuOtA  ");
  assert.ok(
    matches.some(
      (entry) => entry.area === "security" && entry.section === "signin",
    ),
  );
  assert.ok(
    matches.every(
      (entry) =>
        entry.search.includes("oauth") && entry.search.includes("quota"),
    ),
  );
  assert.deepEqual(matches, findSettings("oauth quota"));
  assert.deepEqual(settingsIndex, snapshot);
});

test("an empty settings query restores the index and unmatched terms produce no unrelated settings", () => {
  assert.deepEqual(findSettings(" \n\t "), settingsIndex);
  assert.deepEqual(findSettings("unmatched-setting-8f768d37"), []);
  assert.deepEqual(findSettings("OAuth unmatched-setting-8f768d37"), []);
});

test("diff returns only changed known settings with their review context and preserves inputs", () => {
  const saved = Object.freeze({ ...defaultSettings });
  const draft = Object.freeze({
    ...saved,
    serverName: "Family archive",
    smtpPort: saved.smtpPort === 465 ? 587 : 465,
    unexpectedCredential: "must-not-be-in-change-review",
  });
  const changes = settingsDiff(saved, draft);
  assert.deepEqual(
    new Set(changes.map((change) => change.id)),
    new Set(["serverName", "smtpPort"]),
  );
  for (const change of changes) {
    assert.equal(change.before, saved[change.id]);
    assert.equal(change.after, draft[change.id]);
    assert.ok(settingsAreas.some((area) => area.id === change.area));
    assert.ok(change.section && change.impact);
  }
  assert.equal(saved.serverName, defaultSettings.serverName);
  assert.equal(draft.unexpectedCredential, "must-not-be-in-change-review");
  assert.deepEqual(settingsDiff(saved, { ...saved }), []);
});

test("restoring a draft value removes it from pending changes", () => {
  const saved = { ...defaultSettings };
  const draft = { ...saved, displayName: "Updated name" };
  assert.ok(
    settingsDiff(saved, draft).some((change) => change.id === "displayName"),
  );
  draft.displayName = saved.displayName;
  assert.deepEqual(settingsDiff(saved, draft), []);
});

test("toggle validation accepts booleans without treating textual or numeric false values as choices", () => {
  const field = { type: "toggle" };
  for (const value of [true, false])
    assert.equal(validateSetting(field, value), "");
  for (const value of ["true", "false", "", 0, 1, null, undefined, [], {}]) {
    assert.notEqual(
      validateSetting(field, value),
      "",
      `Unexpected valid toggle: ${JSON.stringify(value)}`,
    );
  }
});

test("numeric settings accept finite numbers and decimal form inputs within inclusive bounds", () => {
  const field = { type: "number", min: 0, max: 1 };
  for (const value of [0, 1, 0.75, "0", "1", "0.75", " 0.5 "]) {
    assert.equal(
      validateSetting(field, value),
      "",
      `Rejected valid number: ${JSON.stringify(value)}`,
    );
  }
  for (const value of [
    -0.01,
    1.01,
    "-0.01",
    "1.01",
    Number.NaN,
    Infinity,
    -Infinity,
    "NaN",
    "Infinity",
    "abc",
  ]) {
    assert.notEqual(validateSetting(field, value), "");
  }
});

test("blank and nonnumeric form values cannot coerce into an accepted numeric zero", () => {
  const field = { type: "number", min: 0, max: 10 };
  for (const value of [
    "",
    " ",
    "\t\n",
    null,
    undefined,
    false,
    true,
    [],
    [1],
    {},
    { valueOf: () => 1 },
  ]) {
    assert.notEqual(
      validateSetting(field, value),
      "",
      `Coerced invalid number: ${JSON.stringify(value)}`,
    );
  }
});

test("select validation uses option values, including false and zero, rather than display labels", () => {
  const field = {
    type: "select",
    options: [
      "automatic",
      { value: "local", label: "Home network" },
      { value: 0, label: "None" },
      { value: false, label: "Disabled" },
    ],
  };
  for (const value of ["automatic", "local", 0, false])
    assert.equal(validateSetting(field, value), "");
  for (const value of [
    "Home network",
    "None",
    "Disabled",
    "0",
    "false",
    "unknown",
    null,
    undefined,
  ]) {
    assert.notEqual(validateSetting(field, value), "");
  }
});

test("URL settings permit explicit empty or HTTP(S) URLs and reject executable or filesystem schemes", () => {
  const field = { type: "url" };
  for (const value of [
    "",
    "https://photos.example.invalid",
    "http://192.0.2.1:3003/",
  ]) {
    assert.equal(validateSetting(field, value), "");
  }
  for (const value of [
    "not-a-url",
    "//photos.example.invalid",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "file:///private/photos",
    42,
    null,
  ]) {
    assert.notEqual(validateSetting(field, value), "");
  }
});

test("email and plain text validation keep types and invalid address boundaries explicit", () => {
  assert.equal(
    validateSetting({ type: "email" }, "photos+alerts@example.invalid"),
    "",
  );
  for (const value of [
    "",
    "photos",
    "photos@",
    "@example.invalid",
    "person name@example.invalid",
    null,
  ]) {
    assert.notEqual(validateSetting({ type: "email" }, value), "");
  }
  for (const type of ["text", "textarea"]) {
    for (const value of [
      "",
      "Describe the visible scene.\nKeep manual names.",
    ]) {
      assert.equal(validateSetting({ type }, value), "");
    }
    for (const value of [null, undefined, {}, 12, true])
      assert.notEqual(validateSetting({ type }, value), "");
  }
});

test("advanced controls are integrated into canonical sections, defaults, search, and change review", () => {
  const sectionIds = Object.entries(settingsSections).flatMap(
    ([area, sections]) => sections.map((section) => `${area}/${section.id}`),
  );
  assert.equal(new Set(sectionIds).size, sectionIds.length);

  for (const [area, sections] of Object.entries(settingsExtensions)) {
    for (const section of sections) {
      assert.equal(
        settingsSections[area].filter((item) => item.id === section.id).length,
        1,
      );
      assert.ok(
        settingsIndex.some(
          (entry) => entry.area === area && entry.section === section.id,
        ),
      );
      // Extensions currently describe resource prerequisites rather than adding
      // buttons that have no corresponding prototype workflow.
      assert.equal(section.actionKind, undefined);
      for (const field of section.fields) {
        const registered = allSettings.filter((item) => item.id === field.id);
        assert.equal(registered.length, 1);
        assert.equal(registered[0].area, area);
        assert.equal(registered[0].section, section.id);
        assert.deepEqual(defaultSettings[field.id], field.value);
      }
    }
  }

  for (const [query, section] of [
    ["recognized names", "advanced-description-identity"],
    ["endpoint health timeout", "advanced-ml-endpoints"],
    ["icloud staging", "advanced-icloud"],
    ["locked tags", "advanced-protected-suppression"],
    ["persistent worker", "advanced-video-profile"],
  ])
    assert.ok(
      findSettings(query).some((entry) => entry.section === section),
      query,
    );

  const draft = {
    ...defaultSettings,
    advancedDescriptionNameCap: 7,
    advancedMlHealthTimeout: 5000,
  };
  const changes = settingsDiff(defaultSettings, draft);
  assert.deepEqual(
    new Set(changes.map((item) => item.id)),
    new Set(["advancedDescriptionNameCap", "advancedMlHealthTimeout"]),
  );
  assert.ok(
    changes.every(
      (item) => item.section.startsWith("advanced-") && item.sectionTitle,
    ),
  );
});

test("advanced protection guarantees cannot enter the editable change review", () => {
  const protectedFields = allSettings.filter(
    (field) => field.id.startsWith("advanced") && field.locked,
  );
  assert.ok(
    protectedFields.some((field) => field.id === "advancedSuppressionPin"),
  );
  assert.ok(
    protectedFields.some((field) => field.id === "advancedVideoDestination"),
  );
  assert.ok(
    protectedFields.some((field) => field.id === "advancedDedupReferences"),
  );
  const forged = { ...defaultSettings };
  for (const field of protectedFields)
    forged[field.id] =
      typeof field.value === "boolean" ? !field.value : "Changed";
  assert.deepEqual(settingsDiff(defaultSettings, forged), []);
});

test("update preferences are configurable while release infrastructure and external reporting remain protected", () => {
  const byId = Object.fromEntries(
    allSettings.map((field) => [field.id, field]),
  );
  for (const id of [
    "versionChecks",
    "releaseCheckSchedule",
    "releaseChannel",
    "notifyUpdates",
    "localMetrics",
  ]) {
    assert.ok(byId[id]);
    assert.notEqual(byId[id].locked, true, id);
  }
  assert.equal(defaultSettings.versionChecks, false);
  assert.equal(Object.hasOwn(defaultSettings, "releaseFeedUrl"), false);
  assert.equal(byId.releaseFeedUrl, undefined);
  assert.equal(
    settingsSections.server
      .find((section) => section.id === "updates")
      .fields.some((field) => field.type === "url"),
    false,
  );
  assert.equal(defaultSettings.releaseChannel, "stable");
  assert.equal(defaultSettings.installedBuildChannel, "Development");
  assert.equal(byId.installedBuildChannel.locked, true);
  for (const id of ["externalVersionChecks", "metrics"]) {
    assert.equal(defaultSettings[id], false);
    assert.equal(byId[id].locked, true);
  }

  const draft = {
    ...defaultSettings,
    versionChecks: true,
    releaseFeedUrl: "https://obsolete.example.invalid/feed",
    releaseCheckSchedule: "weekly",
    releaseChannel: "beta",
    notifyUpdates: true,
    localMetrics: true,
    externalVersionChecks: true,
    metrics: true,
  };
  assert.deepEqual(
    new Set(settingsDiff(defaultSettings, draft).map((field) => field.id)),
    new Set([
      "versionChecks",
      "releaseCheckSchedule",
      "releaseChannel",
      "notifyUpdates",
      "localMetrics",
    ]),
  );
  assert.equal(byId.versionChecks.label, "Check for updates");
  assert.equal(byId.releaseChannel.label, "Update channel");
  assert.equal(byId.releaseCheckSchedule.label, "Check frequency");
  assert.equal(byId.notifyUpdates.label, "Update notifications");
  assert.ok(
    findSettings("update channel").some((entry) => entry.section === "updates"),
  );
});

test("settings explanations describe user choices without exposing development caveats or configuration paths", () => {
  const developmentCopy =
    /\b(?:our|fork|prototype|production|proposed|upstream|DTO|Immich|queues?|queued|admission|endpoints?|sidecars?|embeddings?|payloads?|config|drafts?|revisions?|capabilit(?:y|ies)|qualif(?:y|ied|ication))\b/i;
  const configurationPath =
    /\b(?:machineLearning|imageDescription|zeroShotTagging|localFeatures|physicalDeduplication|integrityChecks|privacy\.suppression|smartAlbums|ffmpeg|serverless|runpod)\.[a-zA-Z]/;
  for (const section of Object.values(settingsSections).flat()) {
    assert.doesNotMatch(
      `${section.title} ${section.description}`,
      developmentCopy,
      section.id,
    );
  }
  for (const field of allSettings) {
    assert.doesNotMatch(
      `${field.label} ${field.help} ${field.impact}`,
      developmentCopy,
      field.id,
    );
    assert.doesNotMatch(field.help, configurationPath, field.id);
  }
});

test("integral worker, timeout and prompt counts reject fractions while durations remain fractional", () => {
  const byId = Object.fromEntries(
    allSettings.map((field) => [field.id, field]),
  );
  for (const id of [
    "advancedDescriptionNameCap",
    "advancedDescriptionSentences",
    "advancedMlHealthTimeout",
    "advancedVideoDuplicateFrames",
  ]) {
    const field = byId[id];
    assert.equal(validateSetting(field, String(field.value)), "");
    assert.notEqual(validateSetting(field, field.value + 0.5), "", id);
  }
  assert.equal(validateSetting(byId.advancedVideoProfileRuntime, "1.5"), "");
});

test("the maintenance area is indexed with its sections and plain-language keywords", () => {
  const area = settingsAreas.find((item) => item.id === "maintenance");
  assert.ok(area);
  assert.equal(area.group, "Your server");
  assert.equal(area.icon, "mdiWrenchOutline");
  assert.deepEqual(
    settingsSections.maintenance.map((section) => section.id),
    ["mode", "backups", "integrity"],
  );
  for (const section of settingsSections.maintenance) {
    assert.equal(section.module, "Maintenance");
    assert.deepEqual(section.fields, []);
    assert.ok(
      settingsIndex.some(
        (entry) => entry.area === "maintenance" && entry.section === section.id,
      ),
    );
  }
  for (const [query, section] of [
    ["restore backup", "backups"],
    ["maintenance page", "mode"],
    ["orphaned csv", "integrity"],
    ["checksum", "integrity"],
  ])
    assert.ok(
      findSettings(query).some(
        (entry) => entry.area === "maintenance" && entry.section === section,
      ),
      query,
    );
});

test("area headlines are plain names with one-sentence subtitles", () => {
  for (const area of settingsAreas) {
    assert.doesNotMatch(area.title, /[.!]$/, area.id);
    assert.ok(area.title.length <= 24, area.id);
    assert.match(area.description, /^[A-Z].*\.$/, area.id);
    assert.doesNotMatch(area.description, /!/, area.id);
    assert.equal(area.description.split(/\.\s/).length, 1, area.id);
  }
  assert.equal(settingsAreas.find((area) => area.id === "care").title, "Library care");
});

test("Frameleaf Cloud replaces the retired GPU-provider settings in one optional area", () => {
  const area = settingsAreas.find((item) => item.id === "cloud");
  assert.ok(area);
  assert.equal(area.title, "Frameleaf Cloud");
  assert.equal(area.group, "Your server");
  assert.deepEqual(
    settingsSections.cloud.map((section) => section.id),
    [
      "cloud-account",
      "cloud-plan",
      "cloud-license",
      "cloud-remote",
      "cloud-processing",
      "cloud-backup",
    ],
  );
  for (const section of settingsSections.cloud) {
    assert.equal(section.module, "FrameleafCloud");
    assert.deepEqual(
      section.fields.map((field) => field.id),
      section.id === "cloud-remote" ? ["externalUrl"] : [],
    );
  }
  assert.ok(
    !settingsSections.server.some((section) =>
      section.fields.some((field) => field.id === "externalUrl"),
    ),
    "the public server URL lives with remote access",
  );
  assert.ok(
    settingsSections.security.some((section) => section.id === "frameleaf-signin"),
  );
  assert.ok(
    settingsSections.preferences.some(
      (section) => section.id === "frameleaf-account",
    ),
  );
  for (const [query, section] of [
    ["device code", "cloud-account"],
    ["product key", "cloud-license"],
    ["subscription", "cloud-plan"],
    ["custom domain", "cloud-remote"],
    ["upnp", "cloud-remote"],
    ["ai wallet", "cloud-processing"],
    ["recovery kit", "cloud-backup"],
  ])
    assert.ok(
      findSettings(query).some(
        (entry) => entry.area === "cloud" && entry.section === section,
      ),
      query,
    );

  const destination = allSettings.find((field) => field.id === "destination");
  assert.deepEqual(
    destination.options.map((option) => option.value ?? option),
    ["local", "cloud"],
  );
  assert.equal(defaultSettings.destination, "local");
  const sectionIds = Object.values(settingsSections)
    .flat()
    .map((section) => section.id);
  for (const retired of [
    "runpod",
    "advanced-runpod-ordinary",
    "advanced-runpod-pod",
    "advanced-runpod-serverless",
  ])
    assert.equal(sectionIds.includes(retired), false, retired);
  for (const section of Object.values(settingsSections).flat()) {
    assert.doesNotMatch(
      `${section.title} ${section.description} ${(section.credentials || [])
        .map((item) => `${item.label} ${item.help}`)
        .join(" ")}`,
      /runpod/i,
      section.id,
    );
  }
  for (const field of allSettings) {
    assert.doesNotMatch(field.id, /runpod|serverless/i, field.id);
    assert.doesNotMatch(
      `${field.label} ${field.help} ${JSON.stringify(field.options ?? [])} ${field.value}`,
      /runpod/i,
      field.id,
    );
  }
});

test("every settings section has a real, distinct directory icon", async () => {
  const mdi = await import("@mdi/js");
  const areas = settingsAreas;
  const sections = settingsSections;
  let count = 0;
  for (const area of areas) {
    const list = sections[area.id] ?? [];
    // Library care also lists these repair tools from Utilities in its directory.
    const shown =
      area.id === "care"
        ? [...list, ...(sections.utilities ?? []).filter((item) => ["duplicates", "missing-media", "corrupt-media", "live-photos"].includes(item.id))]
        : list;
    for (const section of list) {
      assert.equal(typeof section.icon, "string", `${area.id}/${section.id} has an icon`);
      assert.ok(mdi[section.icon], `${area.id}/${section.id}: ${section.icon} exists in @mdi/js`);
      count += 1;
    }
    const icons = shown.map((section) => section.icon);
    assert.equal(new Set(icons).size, icons.length, `icons are unique within ${area.id}: ${icons.join(", ")}`);
  }
  assert.ok(count >= 100);
});
