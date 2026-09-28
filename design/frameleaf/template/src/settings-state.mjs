import { validateSetting } from "./settings-catalog.mjs";

export const COMMAND_CENTER_STORAGE_KEY = "frameleaf:command-center:v1";

// Form limits must match recovery so a successful save survives a reload.
export const COMMAND_CENTER_LIMITS = Object.freeze({
  jsonCharacters: 8 * 1024 * 1024,
  textCharacters: 20_000,
  numericCharacters: 128,
  entities: 100,
  history: 50,
  historyEntries: 500,
  entity: Object.freeze({
    id: 128,
    name: 160,
    detail: 1024,
    status: 120,
    type: 120,
  }),
  historyTitle: 200,
  historyLabel: 200,
});
const {
  jsonCharacters: MAX_JSON_CHARACTERS,
  textCharacters: MAX_TEXT_CHARACTERS,
  numericCharacters: MAX_NUMERIC_CHARACTERS,
  entities: MAX_ENTITIES,
  history: MAX_HISTORY,
  historyEntries: MAX_HISTORY_ENTRIES,
} = COMMAND_CENTER_LIMITS;
const own = (value, key) => Object.hasOwn(value, key);
const record = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const boundedString = (value, maximum, minimum = 0) =>
  typeof value === "string" &&
  value.length <= maximum &&
  value.trim().length >= minimum;

function safeFieldValue(field, value) {
  if (field.type === "toggle") return typeof value === "boolean";
  if (field.type === "number") {
    return (
      (typeof value === "number" && Number.isFinite(value)) ||
      boundedString(value, MAX_NUMERIC_CHARACTERS)
    );
  }
  if (field.type === "select") {
    return (
      ["string", "number", "boolean"].includes(typeof value) &&
      (typeof value !== "number" || Number.isFinite(value)) &&
      !validateSetting(field, value)
    );
  }
  if (!["text", "textarea", "url", "email"].includes(field.type)) return false;
  return boundedString(
    value,
    Math.min(field.maxLength ?? MAX_TEXT_CHARACTERS, MAX_TEXT_CHARACTERS),
  );
}

function entity(value) {
  const limits = COMMAND_CENTER_LIMITS.entity;
  if (
    !record(value) ||
    !boundedString(value.id, limits.id, 1) ||
    !boundedString(value.name, limits.name, 1) ||
    !boundedString(value.detail, limits.detail) ||
    !boundedString(value.status, limits.status, 1) ||
    !boundedString(value.type, limits.type, 1)
  )
    return null;
  return {
    id: value.id,
    name: value.name,
    detail: value.detail,
    status: value.status,
    type: value.type,
  };
}

function uniqueRecords(values, limit, parse) {
  const result = [];
  const seen = new Set();
  // Bound traversal as well as the returned arrays when callers supply parsed objects.
  for (const value of values.slice(0, limit)) {
    const parsed = parse(value);
    if (parsed && !seen.has(parsed.id)) {
      seen.add(parsed.id);
      result.push(parsed);
    }
  }
  return result;
}

function historyItem(value) {
  if (
    !record(value) ||
    !boundedString(value.id, 128, 1) ||
    !boundedString(value.title, COMMAND_CENTER_LIMITS.historyTitle, 1) ||
    !boundedString(value.at, 32, 1) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at) ||
    !Number.isFinite(Date.parse(value.at)) ||
    new Date(value.at).toISOString() !== value.at ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_HISTORY_ENTRIES
  )
    return null;
  const entries = [];
  for (const item of value.entries) {
    if (
      !record(item) ||
      !boundedString(item.label, COMMAND_CENTER_LIMITS.historyLabel, 1) ||
      !boundedString(item.before, MAX_TEXT_CHARACTERS) ||
      !boundedString(item.after, MAX_TEXT_CHARACTERS)
    )
      return null;
    entries.push({ label: item.label, before: item.before, after: item.after });
  }
  return { id: value.id, title: value.title, at: value.at, entries };
}

const APP_PREFERENCES = [
  {
    prop: "theme",
    field: "themePreference",
    values: { dark: "Dark", light: "Light" },
  },
  {
    prop: "destination",
    field: "destination",
    values: { local: "local", cloud: "cloud" },
  },
  {
    prop: "defaultLayout",
    field: "defaultLayout",
    values: { timeline: "Timeline", browse: "Browse", work: "Work" },
  },
];

/**
 * Reconcile app-owned preferences without overwriting unfinished settings edits.
 * Props use app values: dark/light, local/cloud, and browse/work. Missing or
 * unknown props are ignored. Omitting previousProps reconciles all supplied props.
 * Unchanged settings and drafts retain their references for effect callers.
 */
export function reconcileAppPreferences(
  settings,
  draft,
  nextProps,
  previousProps = {},
) {
  let nextSettings = settings;
  let nextDraft = draft;
  for (const { prop, field, values } of APP_PREFERENCES) {
    const incoming = nextProps?.[prop];
    if (typeof incoming !== "string" || !own(values, incoming)) continue;
    if (incoming === previousProps?.[prop]) continue;
    const value = values[incoming];
    const pending = own(draft, field) && draft[field] !== settings[field];
    if (settings[field] !== value) {
      if (nextSettings === settings) nextSettings = { ...settings };
      nextSettings[field] = value;
    }
    if (!pending && draft[field] !== value) {
      if (nextDraft === draft) nextDraft = { ...draft };
      nextDraft[field] = value;
    }
  }
  return { settings: nextSettings, draft: nextDraft };
}

/**
 * Recover browser-only preview state. Saved settings are validated; unfinished
 * input can survive in the draft without being promoted to saved configuration.
 * Callers persist with JSON.stringify({ version: 1, ...state }), including draft.
 */
export function parseCommandCenter(raw, defaults, fields, initialEntities) {
  const knownFields = fields.filter((field) => own(defaults, field.id));
  const settings = Object.fromEntries(
    knownFields.map((field) => [
      field.id,
      field.locked && own(field, "value") ? field.value : defaults[field.id],
    ]),
  );
  const entities = Object.fromEntries(
    Object.entries(initialEntities).map(([kind, values]) => [
      kind,
      Array.isArray(values) ? uniqueRecords(values, MAX_ENTITIES, entity) : [],
    ]),
  );
  const fallback = { settings, draft: { ...settings }, history: [], entities };
  let source = raw;
  if (typeof source === "string") {
    if (source.length > MAX_JSON_CHARACTERS) return fallback;
    try {
      source = JSON.parse(source);
    } catch {
      return fallback;
    }
  }
  if (!record(source) || source.version !== 1) return fallback;

  if (record(source.settings)) {
    for (const field of knownFields) {
      if (field.locked || !own(source.settings, field.id)) continue;
      const rawValue = source.settings[field.id];
      const value =
        field.legacyValues && own(field.legacyValues, rawValue)
          ? field.legacyValues[rawValue]
          : rawValue;
      if (safeFieldValue(field, value) && !validateSetting(field, value)) {
        settings[field.id] = field.type === "number" ? Number(value) : value;
      }
    }
  }

  const draft = { ...settings };
  if (record(source.draft)) {
    for (const field of knownFields) {
      if (field.locked || !own(source.draft, field.id)) continue;
      const rawValue = source.draft[field.id];
      const value =
        field.legacyValues && own(field.legacyValues, rawValue)
          ? field.legacyValues[rawValue]
          : rawValue;
      if (safeFieldValue(field, value)) draft[field.id] = value;
    }
  }

  if (record(source.entities)) {
    for (const kind of Object.keys(entities)) {
      if (own(source.entities, kind) && Array.isArray(source.entities[kind])) {
        entities[kind] = uniqueRecords(
          source.entities[kind],
          MAX_ENTITIES,
          entity,
        );
      }
    }
  }
  const history = Array.isArray(source.history)
    ? uniqueRecords(source.history, MAX_HISTORY, historyItem)
    : [];
  return { settings, draft, history, entities };
}
