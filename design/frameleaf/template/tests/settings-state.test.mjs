import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMAND_CENTER_LIMITS,
  parseCommandCenter,
  reconcileAppPreferences,
} from "../src/settings-state.mjs";
import { allSettings, defaultSettings } from "../src/settings-catalog.mjs";

const fields = [
  { id: "name", type: "text" },
  { id: "prompt", type: "textarea" },
  { id: "email", type: "email" },
  { id: "issuer", type: "url" },
  { id: "enabled", type: "toggle" },
  { id: "workers", type: "number", min: 1, max: 32 },
  {
    id: "destination",
    type: "select",
    options: [{ value: "local", label: "Home" }, "cloud"],
  },
  { id: "metrics", type: "toggle", value: false, locked: true },
];
const defaults = {
  name: "Home",
  prompt: "",
  email: "photos@example.invalid",
  issuer: "",
  enabled: true,
  workers: 2,
  destination: "local",
  metrics: false,
};
const worker = (id = "home") => ({
  id,
  name: "Home GPU",
  detail: "Local / LAN",
  status: "Unqualified",
  type: "Local",
});
const initialEntities = { workers: [worker()], users: [], libraries: [] };
const change = (id = "change-1") => ({
  id,
  title: "Changed a setting",
  at: "2026-09-19T12:00:00.000Z",
  entries: [{ label: "Workers", before: "2", after: "3" }],
});
const parse = (raw) =>
  parseCommandCenter(raw, defaults, fields, initialEntities);
const base = () => ({
  settings: { ...defaults },
  draft: { ...defaults },
  history: [],
  entities: structuredClone(initialEntities),
});

test("missing, malformed and unsupported roots recover complete independent defaults", () => {
  for (const raw of [
    undefined,
    null,
    "",
    "{",
    "null",
    "[]",
    [],
    1,
    true,
    {},
    { version: 2 },
    { version: "1" },
  ]) {
    assert.deepEqual(parse(raw), base());
  }
  const recovered = parse(null);
  recovered.settings.name = "Changed";
  recovered.draft.prompt = "Draft";
  recovered.entities.workers[0].name = "Changed worker";
  assert.deepEqual(parse(null), base());
  assert.equal(defaults.name, "Home");
});

test("saved settings restore only validated known fields and normalize numeric form values", () => {
  const recovered = parse({
    version: 1,
    settings: {
      name: "Family",
      workers: " 4 ",
      enabled: false,
      destination: "cloud",
      unknown: "drop",
      email: "invalid",
      issuer: "javascript:alert(1)",
      prompt: null,
    },
  });
  assert.deepEqual(recovered.settings, {
    ...defaults,
    name: "Family",
    workers: 4,
    enabled: false,
    destination: "cloud",
  });
  assert.deepEqual(recovered.draft, recovered.settings);
  for (const settings of [
    null,
    [],
    "bad",
    { workers: " ", enabled: "false", destination: "Home", name: {} },
  ]) {
    assert.deepEqual(parse({ version: 1, settings }).settings, defaults);
  }
});

test("locked policy cannot be restored on in saved settings or draft", () => {
  const recovered = parse({
    version: 1,
    settings: { metrics: true },
    draft: { metrics: true, name: "Pending" },
  });
  assert.equal(recovered.settings.metrics, false);
  assert.equal(recovered.draft.metrics, false);
  assert.equal(recovered.draft.name, "Pending");
  const legacyDefaults = { ...defaults, metrics: true };
  assert.equal(
    parseCommandCenter(null, legacyDefaults, fields, initialEntities).settings
      .metrics,
    false,
  );
});

test("pending drafts survive JSON round trips without becoming saved settings", () => {
  const state = parse({
    version: 1,
    settings: { name: "Saved", workers: 3 },
    draft: {
      name: "Unsaved",
      workers: "",
      prompt: "Line one\nLine two",
      email: "typing@",
      issuer: "https://",
    },
  });
  assert.equal(state.settings.name, "Saved");
  assert.equal(state.settings.workers, 3);
  assert.equal(state.draft.name, "Unsaved");
  assert.equal(state.draft.workers, "");
  assert.equal(state.draft.email, "typing@");
  assert.equal(state.draft.issuer, "https://");
  assert.deepEqual(parse(JSON.stringify({ version: 1, ...state })), state);
});

test("invalid numeric draft text remains pending but unsafe value shapes fall back", () => {
  for (const workers of ["-", ".", "abc", "99", "NaN", " ", 99]) {
    const state = parse({
      version: 1,
      settings: { workers: 3 },
      draft: { workers },
    });
    assert.equal(state.settings.workers, 3);
    assert.equal(state.draft.workers, workers);
  }
  for (const workers of [
    null,
    false,
    [],
    {},
    Infinity,
    Number.NaN,
    "1".repeat(129),
  ]) {
    assert.equal(
      parse({ version: 1, draft: { workers } }).draft.workers,
      defaults.workers,
    );
  }
  assert.deepEqual(
    parse({
      version: 1,
      draft: { destination: "unknown", enabled: "false", prompt: [] },
    }).draft,
    defaults,
  );
});

test("text limits and malformed nested objects cannot overwrite recovered defaults", () => {
  for (const key of ["settings", "draft"]) {
    const recovered = parse({
      version: 1,
      [key]: { name: "x".repeat(20_001), prompt: { html: "unsafe shape" } },
    });
    assert.deepEqual(recovered[key], defaults);
  }
  const recovered = parse(
    JSON.parse(
      '{"version":1,"settings":{"__proto__":{"polluted":true}},"entities":{"__proto__":[]}}',
    ),
  );
  assert.equal(Object.getPrototypeOf(recovered.settings), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(recovered.settings, "__proto__"), false);
});

test("entity kinds are known, records have bounded strings, and explicit deletion survives", () => {
  const recovered = parse({
    version: 1,
    entities: {
      workers: [
        worker("a"),
        null,
        { ...worker("b"), name: {} },
        { ...worker("c"), detail: "x".repeat(1025) },
        { ...worker("d"), status: "" },
        { ...worker("a"), name: "Duplicate" },
        { ...worker("valid"), token: "drop" },
      ],
      users: [],
      libraries: null,
      unknown: [worker("injected")],
    },
  });
  assert.deepEqual(recovered.entities.workers, [worker("a"), worker("valid")]);
  assert.deepEqual(recovered.entities.users, []);
  assert.deepEqual(recovered.entities.libraries, []);
  assert.equal(Object.hasOwn(recovered.entities, "unknown"), false);
  assert.deepEqual(
    parse({ version: 1, entities: { workers: [] } }).entities.workers,
    [],
  );
  assert.deepEqual(
    parse({ version: 1, entities: { workers: null } }).entities.workers,
    initialEntities.workers,
  );
});

test("entity and history arrays are bounded without reordering retained records", () => {
  const recovered = parse({
    version: 1,
    entities: {
      workers: Array.from({ length: 125 }, (_, index) =>
        worker(`worker-${index}`),
      ),
    },
    history: Array.from({ length: 75 }, (_, index) =>
      change(`change-${index}`),
    ),
  });
  assert.equal(recovered.entities.workers.length, 100);
  assert.equal(recovered.entities.workers.at(-1).id, "worker-99");
  assert.equal(recovered.history.length, 50);
  assert.equal(recovered.history.at(-1).id, "change-49");
});

test("history rejects invalid timestamps and malformed entries instead of crashing change review", () => {
  const recovered = parse({
    version: 1,
    history: [
      null,
      [],
      { ...change("bad-time"), at: "yesterday" },
      { ...change("impossible-date"), at: "2026-02-30T12:00:00.000Z" },
      {
        ...change("bad-entry"),
        entries: [{ label: "Workers", before: {}, after: "3" }],
      },
      {
        ...change("huge-entry"),
        entries: [{ label: "Workers", before: "2", after: "x".repeat(20_001) }],
      },
      { ...change("bad-entries"), entries: {} },
      { ...change("long-title"), title: "x".repeat(201) },
      {
        ...change("good"),
        extra: "drop",
        entries: [{ ...change().entries[0], secret: "drop" }],
      },
      change("good"),
    ],
  });
  assert.deepEqual(recovered.history, [change("good")]);
  assert.deepEqual(parse({ version: 1, history: null }).history, []);
});

test("recovery never mutates source data or aliases nested records into its result", () => {
  const source = {
    version: 1,
    settings: { name: "Saved" },
    draft: { name: "Pending" },
    entities: { workers: [worker()] },
    history: [change()],
  };
  const snapshot = structuredClone(source);
  const recovered = parse(source);
  assert.deepEqual(source, snapshot);
  recovered.entities.workers[0].detail = "Changed";
  recovered.history[0].entries[0].after = "Changed";
  recovered.settings.name = "Changed";
  assert.deepEqual(source, snapshot);
});

test("the current release policy restores update choices and discards obsolete endpoint settings", () => {
  const recovered = parseCommandCenter(
    JSON.stringify({
      version: 1,
      settings: {
        versionChecks: true,
        releaseFeedUrl: "https://releases.photos.example.invalid/feed",
        externalVersionChecks: true,
      },
      draft: { releaseCheckSchedule: "weekly", externalVersionChecks: true },
    }),
    defaultSettings,
    allSettings,
    initialEntities,
  );
  assert.equal(recovered.settings.versionChecks, true);
  assert.equal(Object.hasOwn(recovered.settings, "releaseFeedUrl"), false);
  assert.equal(Object.hasOwn(recovered.draft, "releaseFeedUrl"), false);
  assert.equal(recovered.settings.externalVersionChecks, false);
  assert.equal(recovered.draft.externalVersionChecks, false);
  assert.equal(recovered.draft.releaseCheckSchedule, "weekly");
});

test("entity values accepted at the shared form boundaries survive a reload", () => {
  const value = Object.fromEntries(
    Object.entries(COMMAND_CENTER_LIMITS.entity).map(([key, length]) => [
      key,
      "x".repeat(length),
    ]),
  );
  const state = parse({ version: 1, entities: { workers: [value] } });
  assert.deepEqual(state.entities.workers, [value]);
  assert.deepEqual(parse(JSON.stringify({ version: 1, ...state })), state);
  for (const key of Object.keys(value)) {
    assert.deepEqual(
      parse({
        version: 1,
        entities: { workers: [{ ...value, [key]: `${value[key]}x` }] },
      }).entities.workers,
      [],
    );
  }
});

const appSettings = () => ({
  themePreference: "Dark",
  destination: "local",
  defaultLayout: "Work",
  workers: 2,
});
const appProps = () => ({
  theme: "dark",
  destination: "local",
  defaultLayout: "work",
});

test("app preference changes refresh clean fields without applying other pending settings", () => {
  const settings = Object.freeze(appSettings());
  const draft = Object.freeze({ ...settings, workers: "-" });
  const previous = Object.freeze(appProps());
  const next = Object.freeze({
    theme: "light",
    destination: "cloud",
    defaultLayout: "browse",
  });
  const result = reconcileAppPreferences(settings, draft, next, previous);
  assert.deepEqual(result.settings, {
    ...settings,
    themePreference: "Light",
    destination: "cloud",
    defaultLayout: "Browse",
  });
  assert.deepEqual(result.draft, { ...result.settings, workers: "-" });
  assert.deepEqual(settings, appSettings());
  assert.deepEqual(previous, appProps());
});

test("a global theme change preserves a pending destination and layout", () => {
  const settings = appSettings();
  const draft = { ...settings, destination: "cloud", defaultLayout: "Browse" };
  const result = reconcileAppPreferences(
    settings,
    draft,
    { ...appProps(), theme: "light" },
    appProps(),
  );
  assert.deepEqual(result.settings, { ...settings, themePreference: "Light" });
  assert.deepEqual(result.draft, { ...draft, themePreference: "Light" });
  assert.equal(result.settings.destination, "local");
  assert.equal(result.settings.defaultLayout, "Work");
});

test("a parent change matching a pending preference makes that field clean", () => {
  const settings = appSettings();
  const draft = { ...settings, themePreference: "Light", workers: "3" };
  const result = reconcileAppPreferences(
    settings,
    draft,
    { ...appProps(), theme: "light" },
    appProps(),
  );
  assert.equal(result.settings.themePreference, result.draft.themePreference);
  assert.equal(result.draft, draft);
  assert.equal(result.settings.workers, 2);
  assert.equal(result.draft.workers, "3");
});

test("initial reconciliation aligns all supplied props and retains a recovered pending preference", () => {
  const settings = appSettings();
  const draft = { ...settings, themePreference: "Light" };
  const result = reconcileAppPreferences(settings, draft, {
    theme: "dark",
    destination: "cloud",
    defaultLayout: "browse",
  });
  assert.deepEqual(result.settings, {
    ...settings,
    destination: "cloud",
    defaultLayout: "Browse",
  });
  assert.deepEqual(result.draft, {
    ...result.settings,
    themePreference: "Light",
  });
});

test("unchanged, missing and unsupported app props leave both references untouched", () => {
  const settings = appSettings();
  const draft = { ...settings, themePreference: "Light", workers: "" };
  for (const [next, previous] of [
    [appProps(), appProps()],
    [{}, undefined],
    [null, undefined],
    [
      {
        theme: "system",
        destination: "fallback",
        defaultLayout: {},
        workers: 8,
      },
      appProps(),
    ],
  ]) {
    const result = reconcileAppPreferences(settings, draft, next, previous);
    assert.equal(result.settings, settings);
    assert.equal(result.draft, draft);
  }
});

test("parent acknowledgement after saving does not rewrite an already-applied preference", () => {
  const settings = { ...appSettings(), themePreference: "Light" };
  const draft = { ...settings };
  const result = reconcileAppPreferences(
    settings,
    draft,
    { ...appProps(), theme: "light" },
    appProps(),
  );
  assert.equal(result.settings, settings);
  assert.equal(result.draft, draft);
});
