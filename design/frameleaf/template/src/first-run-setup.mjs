// First-run setup: the two admin flows (a new server, and the first Frameleaf
// launch on an existing library) and the one-time personal account tool that
// every other user sees. Pure data and state so the screens stay thin and the
// rules can be tested. Progress is saved per step, so a reload resumes.

import { passwordStrength, renderStorageTemplate, validateEmail } from "./system-data.mjs";
import { formatUsd } from "./frameleaf-cloud-data.mjs";

export const SETUP_KEY = "frameleaf:setup:v1";
export const ACCOUNT_SETUP_KEY = "frameleaf:account-setup:v1";

/** Setup always runs on the dark stage; the theme choice applies afterwards. */
export const SETUP_THEME = "dark";
export const setupStageTheme = () => SETUP_THEME;
/** The theme the app uses once setup closes. */
export const themeAfterSetup = (choice) => (choice === "light" ? "light" : "dark");

export const setupChapters = Object.freeze([
  { id: "welcome", label: "Welcome" },
  { id: "account", label: "Account" },
  { id: "library", label: "Library" },
  { id: "protection", label: "Protection" },
  { id: "ready", label: "Ready" },
]);

const step = (id, chapter, title, extra = {}) => Object.freeze({ id, chapter, title, ...extra });

export const setupFlows = Object.freeze({
  new: Object.freeze([
    step("welcome", "welcome", "Welcome to Frameleaf"),
    step("sign-in-choice", "account", "How you'll sign in"),
    step("account", "account", "Your account", { required: true }),
    step("library", "library", "Where your library lives", { required: true }),
    step("processing", "library", "Processing"),
    step("protection", "protection", "Protection"),
    step("privacy", "protection", "Privacy"),
    step("imports", "ready", "Bring everything together"),
    step("ready", "ready", "You're ready"),
  ]),
  existing: Object.freeze([
    step("admin-sign-in", "welcome", "Sign in to finish setting up", { required: true }),
    step("welcome", "welcome", "Your library is safe"),
    step("account", "account", "Your account"),
    step("library-check", "library", "Library check"),
    step("processing", "library", "Processing"),
    step("protection", "protection", "Protection"),
    step("privacy", "protection", "Privacy"),
    step("people", "ready", "Your people"),
    step("imports", "ready", "Bring everything together"),
    step("ready", "ready", "You're ready"),
  ]),
});

export const flowSteps = (flow) => setupFlows[flow] ?? setupFlows.new;
export const chapterIndex = (chapterId) =>
  Math.max(0, setupChapters.findIndex((chapter) => chapter.id === chapterId));

// ----------------------------------------------------------------- sample data

/** The library found on a server that already ran Immich. */
export const existingLibrary = Object.freeze({
  items: 48210,
  people: 312,
  albums: 86,
  bytes: 1.8e12,
  users: 4,
  missing: 12,
  damaged: 3,
  layout: "{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}",
});

/** The Cloud backup the sample Frameleaf account already has. */
export const foundBackup = Object.freeze({
  server: "taylor-nas",
  date: "2026-09-18T03:12:00Z",
  items: 51840,
  bytes: 1.94e12,
  database: { date: "2026-09-18T03:05:00Z", bytes: 412e6 },
});

export const detectedHardware = Object.freeze({
  cpu: "Intel Core i5-12400 · 6 cores",
  memory: "32 GB",
  gpu: "NVIDIA GeForce RTX 3060 · 12 GB",
  itemsPerHour: 5400,
});

export const modelTiers = Object.freeze([
  { id: "light", label: "Light", summary: "Fastest. Good search and faces on any processor.", speed: 1.6 },
  { id: "balanced", label: "Balanced", summary: "Sharper search, captions and faces. Fits your GPU.", speed: 1, recommended: true },
  { id: "best", label: "Best", summary: "Highest quality. About twice as slow on this server.", speed: 0.5 },
]);

export const layoutPresets = Object.freeze([
  { id: "year-month", label: "Year / Month / file", pattern: "{{y}}/{{MM}}/{{filename}}", recommended: true },
  { id: "date", label: "Year / Date / file", pattern: "{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}" },
  { id: "album", label: "Album / Year / file", pattern: "{{album}}/{{y}}/{{filename}}" },
  { id: "camera", label: "Camera / Year / file", pattern: "{{make}} {{model}}/{{y}}/{{filename}}" },
]);
export const KEEP_LAYOUT = "keep";

export const keyModes = Object.freeze([
  { id: "server", label: "Generated key, kept on this server", summary: "Easiest. You get a recovery kit once.", recommended: true },
  { id: "own-stored", label: "Your own key, with a copy here", summary: "You hold the key; restores still run on their own." },
  { id: "own-memory", label: "Your own key, never stored", summary: "Most private. Restores ask for the key file." },
]);

// -------------------------------------------------------------------- pricing

export const CLOUD_BACKUP_PER_TB = 7.99;
const TB = 1e12;
/** Cloud backup is billed per started TB, 1 TB minimum, always in USD. */
export function cloudBackupMonthly(bytes) {
  const tb = Math.max(1, Math.ceil(Math.max(0, Number(bytes) || 0) / TB - 1e-9));
  return Math.round(tb * CLOUD_BACKUP_PER_TB * 100) / 100;
}
export const formatTb = (bytes) => `${(Math.max(0, Number(bytes) || 0) / TB).toFixed(1)} TB`;
export const cloudBackupQuote = (bytes) =>
  `${formatTb(bytes)} is about ${formatUsd(cloudBackupMonthly(bytes))} a month`;

/** Hours to re-index a library locally at the chosen model tier. */
export function reindexHours(items, tierId = "balanced", itemsPerHour = detectedHardware.itemsPerHour) {
  const tier = modelTiers.find((entry) => entry.id === tierId) ?? modelTiers[1];
  const rate = Math.max(1, itemsPerHour * tier.speed);
  return Math.max(1, Math.round(Math.max(0, Number(items) || 0) / rate));
}
export const CLOUD_GPU_PER_THOUSAND = 0.4;
/** Frameleaf Cloud GPU estimate: parallel workers, priced per 1,000 items. */
export function cloudReindexEstimate(items) {
  const count = Math.max(0, Number(items) || 0);
  return {
    minutes: Math.max(10, Math.round(count / 1200)),
    cost: Math.round((count / 1000) * CLOUD_GPU_PER_THOUSAND * 100) / 100,
  };
}
export const formatCount = (value) => new Intl.NumberFormat("en").format(Math.round(value));

// ------------------------------------------------------------ storage + layout

/** Simulated live check of a storage location. */
export function checkStorage(path) {
  const value = typeof path === "string" ? path.trim() : "";
  if (!value) return { status: "empty", message: "Enter a folder on this server." };
  if (!value.startsWith("/"))
    return { status: "error", message: "Use a full path that starts with /." };
  if (/\.\./.test(value)) return { status: "error", message: "The path can't contain “..”." };
  if (/^\/(proc|sys|dev|etc)(\/|$)/.test(value) || /read-?only|\/ro(\/|$)/i.test(value))
    return { status: "error", message: "Frameleaf can't write here. Pick a folder on your photo drive." };
  const free = /^\/mnt|^\/media|^\/srv|^\/volume/.test(value) ? 3.2e12 : 0.41e12;
  return {
    status: "ok",
    freeBytes: free,
    message: `Writable, ${formatTb(free)} free`,
  };
}

export function examplePath(layout, existingPattern = existingLibrary.layout) {
  const pattern =
    layout === KEEP_LAYOUT
      ? existingPattern
      : (layoutPresets.find((entry) => entry.id === layout) ?? layoutPresets[0]).pattern;
  return renderStorageTemplate(pattern).path;
}

// ---------------------------------------------------------------------- state

export function createSetup(flow = "new") {
  const existing = flow === "existing";
  return {
    version: 1,
    flow: existing ? "existing" : "new",
    step: 0,
    reached: 0,
    completed: false,
    choices: {
      language: "en",
      // New servers recommend a Frameleaf account; existing ones keep the local admin.
      signIn: existing ? "local" : "frameleaf",
      linked: false,
      // Set once the local admin exists or the admin has signed in; never the password.
      accountCreated: false,
      signedIn: false,
      restore: null,
      admin: { name: "", email: "" },
      storage: "/mnt/photos",
      layout: existing ? KEEP_LAYOUT : "year-month",
      model: "balanced",
      processing: "local",
      nightlyBackup: true,
      cloudBackup: "on",
      keyMode: "server",
      privacy: { updates: true, map: true, remote: true },
      theme: "dark",
    },
  };
}

const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);
const text = (value, max = 120) => (typeof value === "string" ? value.slice(0, max) : "");
const record = (value) => value && typeof value === "object" && !Array.isArray(value);

/** Validates saved progress; anything unexpected falls back to the default. */
export function parseSetup(raw, flow) {
  let source;
  try {
    source = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!record(source) || source.version !== 1) return null;
  const chosenFlow = flow ?? source.flow;
  if (flow && source.flow !== flow) return null;
  const base = createSetup(chosenFlow);
  const last = flowSteps(base.flow).length - 1;
  const clampStep = (value) =>
    Number.isInteger(value) ? Math.min(last, Math.max(0, value)) : 0;
  const choices = record(source.choices) ? source.choices : {};
  const defaults = base.choices;
  const privacy = record(choices.privacy) ? choices.privacy : {};
  const admin = record(choices.admin) ? choices.admin : {};
  const reached = Math.max(clampStep(source.reached), clampStep(source.step));
  const parsed = {
    ...base,
    step: clampStep(source.step),
    reached,
    completed: source.completed === true,
    choices: {
      language: text(choices.language, 12) || defaults.language,
      signIn: oneOf(choices.signIn, ["frameleaf", "local"], defaults.signIn),
      linked: bool(choices.linked, false),
      accountCreated: bool(choices.accountCreated, false),
      signedIn: bool(choices.signedIn, false),
      restore: oneOf(choices.restore, ["restore", "fresh"], null),
      admin: { name: text(admin.name), email: text(admin.email) },
      storage: typeof choices.storage === "string" ? text(choices.storage, 240) : defaults.storage,
      layout: oneOf(choices.layout, [KEEP_LAYOUT, ...layoutPresets.map((entry) => entry.id)], defaults.layout),
      model: oneOf(choices.model, modelTiers.map((entry) => entry.id), defaults.model),
      processing: oneOf(choices.processing, ["local", "cloud", "later"], defaults.processing),
      nightlyBackup: bool(choices.nightlyBackup, true),
      cloudBackup: oneOf(choices.cloudBackup, ["on", "later"], defaults.cloudBackup),
      keyMode: oneOf(choices.keyMode, keyModes.map((entry) => entry.id), defaults.keyMode),
      privacy: {
        updates: bool(privacy.updates, true),
        map: bool(privacy.map, true),
        remote: bool(privacy.remote, true),
      },
      theme: oneOf(choices.theme, ["dark", "light"], "dark"),
    },
  };
  // Resume never lands past a required step that no longer checks out.
  const invalid = firstInvalidStep(parsed, parsed.step);
  return invalid < 0 ? parsed : { ...parsed, step: invalid, completed: false };
}

export function loadSetup(flow, storage = globalThis.localStorage) {
  try {
    return parseSetup(storage?.getItem(SETUP_KEY) ?? null, flow) ?? createSetup(flow);
  } catch {
    return createSetup(flow);
  }
}
/** Saved after every step. Passwords are never written. */
export function saveSetup(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(SETUP_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
export function clearSetup(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(SETUP_KEY);
  } catch {
    /* preview only */
  }
}

/**
 * What still blocks the current step. Only the account and a working storage
 * location are required; every other step has a recommended choice.
 * `secrets` carries the password fields, which never enter saved state.
 */
export function validateStep(state, stepId, secrets = {}) {
  const errors = {};
  const { choices } = state;
  if (stepId === "account" && state.flow === "new") {
    if (choices.signIn === "frameleaf") {
      if (!choices.linked) errors.link = "Sign in with Frameleaf to continue, or go back and choose a local account.";
    } else {
      if (!choices.admin.name.trim()) errors.name = "Enter your name.";
      if (!validateEmail(choices.admin.email.trim())) errors.email = "Enter a valid email address.";
      const created = choices.accountCreated && !secrets.password;
      if (!created && !passwordStrength(secrets.password).acceptable)
        errors.password = "Choose a stronger password that meets the requirements.";
      else if (!created && secrets.password !== secrets.confirm) errors.confirm = "The passwords don't match.";
    }
  }
  if (stepId === "library" && checkStorage(choices.storage).status !== "ok")
    errors.storage = checkStorage(choices.storage).message;
  if (stepId === "admin-sign-in" && !choices.signedIn && !String(secrets.password ?? "").trim())
    errors.password = "Enter your password.";
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Moves to a step; forward moves are only allowed past valid steps. */
export function goToStep(state, target, secrets) {
  const steps = flowSteps(state.flow);
  const next = Math.min(steps.length - 1, Math.max(0, target));
  if (next > state.step) {
    for (let index = state.step; index < next; index += 1) {
      if (!validateStep(state, steps[index].id, secrets).ok) return state;
    }
  }
  const passed = steps.slice(0, next).map((step) => step.id);
  const choices = { ...state.choices };
  if (passed.includes("account") && state.flow === "new" && choices.signIn === "local") choices.accountCreated = true;
  if (passed.includes("admin-sign-in")) choices.signedIn = true;
  return { ...state, choices, step: next, reached: Math.max(state.reached, next) };
}

/**
 * The first required step before `upTo` (every step when omitted) that doesn't
 * validate without secrets, or -1. Used on resume and before finishing.
 */
export function firstInvalidStep(state, upTo = Infinity) {
  const steps = flowSteps(state.flow);
  return steps.findIndex(
    (step, index) => index < upTo && step.required && !validateStep(state, step.id).ok,
  );
}

/** Links or unlinks the server; unlinking drops the choices that need Frameleaf. */
export function setLinked(state, linked) {
  const choices = { ...state.choices, linked };
  if (!linked) {
    if (choices.processing === "cloud") choices.processing = "local";
    choices.restore = null;
  }
  return { ...state, choices };
}

/** Steps that apply: the Cloud processing option only shows when linked. */
export const processingOptions = (state) =>
  state.choices.linked
    ? ["local", "cloud", ...(state.flow === "existing" ? ["later"] : [])]
    : ["local", ...(state.flow === "existing" ? ["later"] : [])];

/** The checklist shown on Ready. */
export function setupSummary(state) {
  const { choices } = state;
  const linked = choices.linked;
  const tier = modelTiers.find((entry) => entry.id === choices.model);
  const rows = [
    ["Account", linked ? "Linked to your Frameleaf account" : state.flow === "new" ? "Local admin account" : "Local admin, unchanged"],
    ["Library", state.flow === "existing" && choices.layout === KEEP_LAYOUT ? "Current folder layout kept" : examplePath(choices.layout)],
    ["Processing", `${tier.label} models · ${choices.processing === "cloud" ? "this server + Frameleaf Cloud" : choices.processing === "later" ? "decide later" : "this server"}`],
    ["Database backups", choices.nightlyBackup ? "Nightly, kept 14 days" : "Off"],
  ];
  if (linked)
    rows.push(["Cloud backup", choices.cloudBackup === "on" ? `On · ${keyModes.find((mode) => mode.id === choices.keyMode).label}` : "Remind me later"]);
  const on = [choices.privacy.updates && "update checks", choices.privacy.map && "map tiles", linked && choices.privacy.remote && "remote access"].filter(Boolean).join(", ");
  rows.push(["Privacy", on ? on[0].toUpperCase() + on.slice(1) : "Everything off"]);
  return rows;
}

/** Jobs queued when setup finishes (visible in Activity). */
export function queuedJobs(state) {
  if (state.flow === "new")
    return [{ id: "index", label: "Indexing your library", detail: "Starts as photos arrive" }];
  const hours = reindexHours(existingLibrary.items, state.choices.model);
  const cloud = cloudReindexEstimate(existingLibrary.items);
  if (state.choices.processing === "later") return [];
  return [
    {
      id: "reindex",
      label: `Re-indexing ${formatCount(existingLibrary.items)} items`,
      detail:
        state.choices.processing === "cloud"
          ? `Frameleaf Cloud · about ${cloud.minutes} min · ${formatUsd(cloud.cost)}`
          : `This server · about ${hours} h`,
    },
    { id: "health", label: "Library health scan", detail: "Checks every original quietly in the background" },
  ];
}

// -------------------------------------------------------- personal account tool

export const accountToolSections = Object.freeze([
  { id: "profile", title: "Profile", icon: "mdiAccountCircleOutline" },
  { id: "appearance", title: "Appearance", icon: "mdiPaletteOutline" },
  { id: "privacy", title: "Privacy and notifications", icon: "mdiShieldAccountOutline" },
  { id: "mobile", title: "The mobile app", icon: "mdiCellphone" },
  { id: "frameleaf", title: "Your Frameleaf account", icon: "mdiCloudOutline" },
]);

export function createAccountTool() {
  return {
    version: 1,
    done: [],
    completed: false,
    theme: "dark",
    language: "en",
    notifications: { albums: true, memories: true, email: false },
    sharedLocation: true,
    linked: false,
  };
}
export function parseAccountTool(raw) {
  let source;
  try {
    source = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!record(source) || source.version !== 1) return null;
  const base = createAccountTool();
  const ids = accountToolSections.map((entry) => entry.id);
  const notes = record(source.notifications) ? source.notifications : {};
  return {
    ...base,
    done: Array.isArray(source.done) ? [...new Set(source.done.filter((id) => ids.includes(id)))] : [],
    completed: source.completed === true,
    theme: oneOf(source.theme, ["dark", "light"], "dark"),
    language: text(source.language, 12) || "en",
    notifications: {
      albums: bool(notes.albums, true),
      memories: bool(notes.memories, true),
      email: bool(notes.email, false),
    },
    sharedLocation: bool(source.sharedLocation, true),
    linked: bool(source.linked, false),
  };
}
export function loadAccountTool(storage = globalThis.localStorage) {
  try {
    return parseAccountTool(storage?.getItem(ACCOUNT_SETUP_KEY) ?? null) ?? createAccountTool();
  } catch {
    return createAccountTool();
  }
}
export function saveAccountTool(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(ACCOUNT_SETUP_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
export const markSection = (state, id) =>
  state.done.includes(id) ? state : { ...state, done: [...state.done, id] };
export const accountToolProgress = (state) => ({
  done: state.done.length,
  total: accountToolSections.length,
});
