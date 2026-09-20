import assert from "node:assert/strict";
import { test } from "node:test";
import { allSettings } from "../src/settings-catalog.mjs";
import {
  createAccountPreferences,
  applyAccountPreferences,
} from "../src/account-preferences.mjs";
import {
  ACCOUNT_PREFERENCE_SETTING_IDS,
  accountPreferencesToSettings,
  settingsToAccountPreferencesPatch,
} from "../src/account-preference-settings.mjs";
const GiB = 1024 ** 3;

test("every bridge key exists in the real catalog with matching control types", () => {
  const defaults = accountPreferencesToSettings(createAccountPreferences());
  assert.deepEqual(Object.keys(defaults), ACCOUNT_PREFERENCE_SETTING_IDS);
  for (const [id, value] of Object.entries(defaults)) {
    const field = allSettings.find((item) => item.id === id);
    assert.ok(field, `Missing catalog field ${id}`);
    assert.equal(typeof value, field.type === "number" ? "number" : "boolean");
  }
  assert.equal(defaults.advancedDownloadArchiveSize, 4);
  assert.equal(defaults.memories, true);
  assert.equal(defaults.peopleEnabled, true);
});

test("only changed submitted fields form the partial update", () => {
  const previous = accountPreferencesToSettings(undefined);
  const next = {
    ...previous,
    foldersEnabled: true,
    peopleSidebar: true,
    personalAlbumUpdateEmail: false,
    arbitraryServerKey: "leave alone",
  };
  assert.deepEqual(settingsToAccountPreferencesPatch(next, previous), {
    folders: { enabled: true },
    people: { sidebarWeb: true },
    emailNotifications: { albumUpdate: false },
  });
  assert.deepEqual(settingsToAccountPreferencesPatch({}, previous), {});
  assert.deepEqual(settingsToAccountPreferencesPatch(previous, previous), {});
  assert.equal(previous.foldersEnabled, false);
});

test("valid decimal numeric input normalizes semantically and GiB converts to integer bytes", () => {
  assert.deepEqual(
    settingsToAccountPreferencesPatch(
      { memoriesDuration: "5", peopleMinimumFaces: "3.0" },
      { memoriesDuration: 5, peopleMinimumFaces: 3 },
    ),
    {},
  );
  const patch = settingsToAccountPreferencesPatch(
    {
      advancedDownloadArchiveSize: "1.1",
      memoriesDuration: "7",
      peopleMinimumFaces: 5,
    },
    {
      advancedDownloadArchiveSize: 4,
      memoriesDuration: 5,
      peopleMinimumFaces: 3,
    },
  );
  assert.deepEqual(patch, {
    memories: { duration: 7 },
    people: { minimumFaces: 5 },
    download: { archiveSize: Math.round(1.1 * GiB) },
  });
  for (const archiveSize of [1, 123456789, 4 * GiB, Number.MAX_SAFE_INTEGER]) {
    const canonical = applyAccountPreferences(undefined, {
      download: { archiveSize },
    });
    assert.equal(
      settingsToAccountPreferencesPatch(accountPreferencesToSettings(canonical))
        .download.archiveSize,
      archiveSize,
    );
  }
});

test("changed invalid values fail rather than silently altering account preferences", () => {
  for (const value of ["", "1e2", "NaN", "0x10", null, true, Infinity, -1, 1.5])
    assert.throws(
      () =>
        settingsToAccountPreferencesPatch(
          { memoriesDuration: value },
          { memoriesDuration: 5 },
        ),
      /memoriesDuration/,
    );
  for (const value of ["", false, 0, 1e-15, Number.MAX_VALUE])
    assert.throws(
      () =>
        settingsToAccountPreferencesPatch(
          { advancedDownloadArchiveSize: value },
          { advancedDownloadArchiveSize: 4 },
        ),
      /advancedDownloadArchiveSize/,
    );
  assert.throws(
    () =>
      settingsToAccountPreferencesPatch(
        { tagsEnabled: "false" },
        { tagsEnabled: true },
      ),
    /tagsEnabled/,
  );
  assert.throws(() => settingsToAccountPreferencesPatch(null), /plain objects/);
});

test("private suppression and unrelated account fields survive a personal settings save", () => {
  const account = applyAccountPreferences(undefined, {
    privacy: {
      suppression: {
        tagIds: ["12345678-1234-4234-9234-123456789abc"],
        personIds: ["abcdefab-cdef-4abc-8def-abcdefabcdef"],
        scope: "visible",
      },
    },
    albums: { defaultAssetOrder: "asc" },
    purchase: { hideBuyButtonUntil: "2030-01-01" },
  });
  const before = structuredClone(account),
    previous = accountPreferencesToSettings(account);
  const patch = settingsToAccountPreferencesPatch(
    { ...previous, memories: false },
    previous,
  );
  const updated = applyAccountPreferences(account, patch);
  assert.deepEqual(updated.privacy, before.privacy);
  assert.deepEqual(updated.albums, before.albums);
  assert.equal(updated.purchase.hideBuyButtonUntil, "2030-01-01");
  assert.deepEqual(account, before);
  assert.ok(
    !Object.keys(previous).some((key) =>
      /suppression|personIds|tagIds/i.test(key),
    ),
  );
});

test("unsupported album-view mode and device/server settings never map into user preferences", () => {
  assert.deepEqual(
    settingsToAccountPreferencesPatch(
      {
        albumSort: "Shared album order",
        birthdayMemories: false,
        videoMoments: false,
        themePreference: "Light",
        defaultLayout: "Browse",
        photoJobs: 5,
        suppressionPeople: "secret",
      },
      { albumSort: "Newest first" },
    ),
    {},
  );
  assert.ok(
    !Object.hasOwn(accountPreferencesToSettings(undefined), "albumSort"),
  );
});

test("an unrelated save preserves unchanged invalid draft text and can repair a changed malformed value", () => {
  assert.deepEqual(
    settingsToAccountPreferencesPatch(
      { memoriesDuration: "pending", foldersEnabled: true },
      { memoriesDuration: "pending", foldersEnabled: false },
    ),
    { folders: { enabled: true } },
  );
  assert.deepEqual(
    settingsToAccountPreferencesPatch(
      { memoriesDuration: 9 },
      { memoriesDuration: "pending" },
    ),
    { memories: { duration: 9 } },
  );
});
