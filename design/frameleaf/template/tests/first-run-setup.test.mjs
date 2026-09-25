import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCOUNT_SETUP_KEY,
  KEEP_LAYOUT,
  SETUP_KEY,
  SETUP_THEME,
  accountToolSections,
  checkStorage,
  cloudBackupMonthly,
  cloudBackupQuote,
  createSetup,
  examplePath,
  existingLibrary,
  flowSteps,
  goToStep,
  loadAccountTool,
  loadSetup,
  markSection,
  parseSetup,
  processingOptions,
  queuedJobs,
  reindexHours,
  saveAccountTool,
  saveSetup,
  setupChapters,
  setupStageTheme,
  themeAfterSetup,
  validateStep,
} from "../src/first-run-setup.mjs";

const memoryStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};
const ids = (flow) => flowSteps(flow).map((step) => step.id);
const strong = { password: "Mountain-Lake-42", confirm: "Mountain-Lake-42" };

test("five chapters on the rail, in order", () => {
  assert.deepEqual(
    setupChapters.map((chapter) => chapter.label),
    ["Welcome", "Account", "Library", "Protection", "Ready"],
  );
});

test("the new-server flow runs welcome to ready with imports just before ready", () => {
  assert.deepEqual(ids("new"), [
    "welcome",
    "sign-in-choice",
    "account",
    "library",
    "processing",
    "protection",
    "privacy",
    "imports",
    "ready",
  ]);
});

test("the existing-library flow signs the admin in first, never registers, and previews people", () => {
  assert.deepEqual(ids("existing"), [
    "admin-sign-in",
    "welcome",
    "account",
    "library-check",
    "processing",
    "protection",
    "privacy",
    "people",
    "imports",
    "ready",
  ]);
  for (const flow of ["new", "existing"]) {
    const steps = flowSteps(flow);
    const chapters = steps.map((step) => setupChapters.findIndex((chapter) => chapter.id === step.chapter));
    assert.deepEqual(chapters, [...chapters].sort((a, b) => a - b), `${flow} chapters never go backwards`);
    assert.equal(steps.at(-2).id, "imports");
  }
});

test("only the account and a working storage location are required in a new server", () => {
  assert.deepEqual(
    flowSteps("new").filter((step) => step.required).map((step) => step.id),
    ["account", "library"],
  );
  const state = createSetup("new");
  assert.equal(validateStep(state, "account").ok, false, "Frameleaf sign-in must be linked");
  assert.equal(validateStep({ ...state, choices: { ...state.choices, linked: true } }, "account").ok, true);
  const local = { ...state, choices: { ...state.choices, signIn: "local", admin: { name: "Taylor", email: "taylor@example.test" } } };
  assert.deepEqual(Object.keys(validateStep(local, "account", { password: "short", confirm: "short" }).errors), ["password"]);
  assert.deepEqual(Object.keys(validateStep(local, "account", { ...strong, confirm: "other" }).errors), ["confirm"]);
  assert.equal(validateStep(local, "account", strong).ok, true);
  const noEmail = { ...local, choices: { ...local.choices, admin: { name: "", email: "nope" } } };
  assert.deepEqual(Object.keys(validateStep(noEmail, "account", strong).errors).sort(), ["email", "name"]);
  for (const id of ["sign-in-choice", "processing", "protection", "privacy", "imports"])
    assert.equal(validateStep(state, id).ok, true, `${id} has a recommended default`);
});

test("the storage check reports free space and blocks unusable paths", () => {
  assert.equal(checkStorage("/mnt/photos").message, "Writable, 3.2 TB free");
  assert.equal(checkStorage("").status, "empty");
  assert.equal(checkStorage("photos").status, "error");
  assert.equal(checkStorage("/etc/frameleaf").status, "error");
  assert.equal(checkStorage("/mnt/../etc").status, "error");
  const state = createSetup("new");
  assert.equal(validateStep({ ...state, choices: { ...state.choices, storage: "/proc" } }, "library").ok, false);
  assert.equal(validateStep(state, "library").ok, true);
});

test("steps can't be skipped past a required one", () => {
  const state = { ...createSetup("new"), step: 2, reached: 2 };
  assert.equal(goToStep(state, 5).step, 2);
  const linked = { ...state, choices: { ...state.choices, linked: true } };
  const moved = goToStep(linked, 5);
  assert.equal(moved.step, 5);
  assert.equal(moved.reached, 5);
  assert.equal(goToStep(moved, 1).reached, 5, "going back keeps how far you got");
});

test("progress is saved per step and a reload resumes; passwords never persist", () => {
  const storage = memoryStorage();
  const state = createSetup("new");
  const moved = goToStep({ ...state, choices: { ...state.choices, linked: true, layout: "album" } }, 4);
  saveSetup(moved, storage);
  assert.ok(storage.map.has(SETUP_KEY));
  assert.doesNotMatch(storage.map.get(SETUP_KEY), /password/i);
  const resumed = loadSetup("new", storage);
  assert.equal(resumed.step, 4);
  assert.equal(resumed.choices.layout, "album");
  assert.equal(resumed.choices.linked, true);
  assert.equal(loadSetup("existing", storage).step, 0, "a different flow starts fresh");
  const hostile = parseSetup(
    JSON.stringify({ version: 1, flow: "new", step: 99, completed: "yes", choices: { layout: "../", processing: "gpu", theme: "neon" } }),
  );
  assert.equal(hostile.step, flowSteps("new").length - 1);
  assert.equal(hostile.completed, false);
  assert.equal(hostile.choices.layout, "year-month");
  assert.equal(hostile.choices.processing, "local");
  assert.equal(hostile.choices.theme, "dark");
  assert.equal(parseSetup("not json"), null);
  assert.deepEqual(loadSetup("new", memoryStorage()), createSetup("new"));
});

test("recommended defaults: Year / Month layout for new servers, keep the layout for existing ones", () => {
  assert.equal(createSetup("new").choices.layout, "year-month");
  assert.equal(examplePath("year-month"), "library/taylor/2026/09/IMG_4021.jpg");
  assert.equal(createSetup("existing").choices.layout, KEEP_LAYOUT);
  assert.equal(examplePath(KEEP_LAYOUT), "library/taylor/2026/2026-09-14/IMG_4021.jpg");
});

test("Cloud processing is only offered once the server is linked", () => {
  const state = createSetup("new");
  assert.deepEqual(processingOptions(state), ["local"]);
  assert.deepEqual(processingOptions({ ...state, choices: { ...state.choices, linked: true } }), ["local", "cloud"]);
  const existing = createSetup("existing");
  assert.deepEqual(processingOptions(existing), ["local", "later"]);
});

test("cloud backup is $7.99 USD per TB with a 1 TB minimum", () => {
  assert.equal(cloudBackupMonthly(0), 7.99);
  assert.equal(cloudBackupMonthly(0.4e12), 7.99);
  assert.equal(cloudBackupMonthly(1.8e12), 15.98);
  assert.equal(cloudBackupQuote(existingLibrary.bytes), "1.8 TB is about $15.98 a month");
});

test("re-indexing the existing library is estimated and queued only at the end", () => {
  assert.equal(reindexHours(existingLibrary.items), 9);
  const state = createSetup("existing");
  assert.match(queuedJobs(state)[0].detail, /about 9 h/);
  assert.deepEqual(queuedJobs({ ...state, choices: { ...state.choices, processing: "later" } }), []);
  assert.equal(queuedJobs(createSetup("new"))[0].id, "index");
});

test("setup always runs dark; the theme choice only applies afterwards", () => {
  assert.equal(SETUP_THEME, "dark");
  assert.equal(setupStageTheme(), "dark");
  const state = createSetup("new");
  const light = { ...state, choices: { ...state.choices, theme: "light" } };
  assert.equal(setupStageTheme(light), "dark");
  assert.equal(themeAfterSetup(light.choices.theme), "light");
  assert.equal(themeAfterSetup("system"), "dark");
  const storage = memoryStorage();
  saveAccountTool({ ...loadAccountTool(storage), theme: "light" }, storage);
  assert.equal(loadAccountTool(storage).theme, "light");
  assert.equal(setupStageTheme(loadAccountTool(storage)), "dark");
});

test("the account tool's sections can be finished in any order and resume", () => {
  assert.deepEqual(
    accountToolSections.map((section) => section.id),
    ["profile", "appearance", "privacy", "mobile", "frameleaf"],
  );
  const storage = memoryStorage();
  let state = loadAccountTool(storage);
  state = markSection(markSection(state, "mobile"), "profile");
  state = markSection(state, "mobile");
  assert.deepEqual(state.done, ["mobile", "profile"]);
  saveAccountTool(state, storage);
  assert.ok(storage.map.has(ACCOUNT_SETUP_KEY));
  assert.deepEqual(loadAccountTool(storage).done, ["mobile", "profile"]);
  storage.setItem(ACCOUNT_SETUP_KEY, JSON.stringify({ version: 1, done: ["mobile", "admin"], theme: "neon" }));
  assert.deepEqual(loadAccountTool(storage).done, ["mobile"]);
  assert.equal(loadAccountTool(storage).theme, "dark");
});
