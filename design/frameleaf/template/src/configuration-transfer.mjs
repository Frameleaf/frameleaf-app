import {
  allSettings,
  validateSetting,
  normalizeSettingChange,
} from "./settings-catalog.mjs";
export function exportConfiguration(values) {
  return {
    format: "frameleaf-settings",
    version: 1,
    values: Object.fromEntries(
      allSettings
        .filter((field) => !field.locked)
        .map((field) => [field.id, values[field.id]]),
    ),
  };
}
export function importConfiguration(raw, current) {
  if (typeof raw === "string" && raw.length > 8 * 1024 * 1024)
    throw Error("Choose a settings file smaller than 8 MB.");
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (
    !value ||
    value.format !== "frameleaf-settings" ||
    value.version !== 1 ||
    !value.values ||
    typeof value.values !== "object" ||
    Array.isArray(value.values)
  )
    throw Error("Choose a Frameleaf settings export.");
  let next = { ...current };
  for (const [id, rawValue] of Object.entries(value.values)) {
    const field = allSettings.find((field) => field.id === id);
    if (!field)
      throw Error(
        `This file includes an unrecognized setting: ${id.slice(0, 80)}.`,
      );
    if (field.locked) continue;
    const candidate =
      field.legacyValues && Object.hasOwn(field.legacyValues, rawValue)
        ? field.legacyValues[rawValue]
        : rawValue;
    const error = validateSetting(field, candidate);
    if (error) throw Error(`${field.label}: ${error}`);
    next = normalizeSettingChange(next, id, candidate);
  }
  if (!next.passwordLogin && !next.oauthEnabled)
    throw Error("Keep at least one sign-in method enabled.");
  return next;
}
export function previewStoragePath(template) {
  const fields = {
    y: "2026",
    yy: "26",
    MM: "09",
    M: "9",
    dd: "19",
    d: "19",
    filename: "Moraine Lake",
    ext: "jpg",
    filetype: "IMAGE",
    album: "Summer in the Rockies",
  };
  const unknown = [];
  const path = String(template).replace(
    /{{\s*([^{}]+?)\s*}}/g,
    (token, name) => {
      if (Object.hasOwn(fields, name)) return fields[name];
      unknown.push(name);
      return token;
    },
  );
  if (unknown.length)
    return {
      error: `Sample preview does not recognize: ${[...new Set(unknown)].join(", ")}.`,
      path: null,
    };
  if (
    path.startsWith("/") ||
    path.split("/").some((part) => part === "..") ||
    path.includes("\\")
  )
    return {
      error: "Use a relative path within the account’s storage folder.",
      path: null,
    };
  return { path: `taylor/${path}${path.endsWith(".jpg") ? "" : ".jpg"}`, error: null };
}
