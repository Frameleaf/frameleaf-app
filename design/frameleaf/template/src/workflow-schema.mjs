import core from "./reference/plugin-core-manifest.json" with { type: "json" };

// Source: plugin-core manifest and plugin-sdk/src/types.ts. This is a schema
// editor, not a plugin runtime. No method in this file sends requests or edits media.
export const workflowTriggers = Object.freeze([
  { value: "AssetCreate", label: "Photo or video uploaded" },
  { value: "AssetMetadataExtraction", label: "Metadata extracted" },
  { value: "AssetTagged", label: "Tags changed" },
]);
export const workflowMethods = core.methods.map((method) => ({
  ...method,
  key: `${core.name}#${method.name}`,
}));
export const workflowTemplates = core.templates;
export const workflowLimits = Object.freeze({
  bytes: 256000,
  steps: 100,
  depth: 24,
  nodes: 12000,
});
export const methodByKey = (key) =>
  workflowMethods.find((method) => method.key === key);
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function parseWorkflowDefinition(raw) {
  if (typeof raw === "string" && raw.length > workflowLimits.bytes)
    throw Error("Choose a workflow smaller than 256 KB.");
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  let nodes = 0;
  function check(item, depth = 0) {
    if (++nodes > workflowLimits.nodes || depth > workflowLimits.depth)
      throw Error("This workflow is too large or deeply nested to edit here.");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      for (const child of item) check(child, depth + 1);
      return;
    }
    if (plain(item)) {
      for (const child of Object.values(item)) check(child, depth + 1);
      return;
    }
    throw Error("Workflow definitions must contain ordinary JSON values.");
  }
  check(value);
  if (
    !plain(value) ||
    typeof value.trigger !== "string" ||
    !value.trigger ||
    !Array.isArray(value.steps) ||
    value.steps.length > workflowLimits.steps
  )
    throw Error(
      "Choose a workflow with a trigger and up to 100 ordered steps.",
    );
  if (
    value.name !== undefined &&
    value.name !== null &&
    typeof value.name !== "string"
  )
    throw Error("The workflow name must be text or null.");
  if (
    value.description !== undefined &&
    value.description !== null &&
    typeof value.description !== "string"
  )
    throw Error("The description must be text or null.");
  for (const key of ["enabled", "logging"])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw Error(`${key} must be true or false.`);
  for (const step of value.steps) {
    if (!plain(step) || typeof step.method !== "string" || !step.method.trim())
      throw Error("Every step needs a method name.");
    if (
      step.config !== undefined &&
      step.config !== null &&
      !plain(step.config)
    )
      throw Error("Step parameters must be an object or null.");
    if (step.enabled !== undefined && typeof step.enabled !== "boolean")
      throw Error("Step enabled must be true or false.");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > workflowLimits.bytes)
    throw Error("Choose a workflow smaller than 256 KB.");
  return JSON.parse(serialized);
}

// Earlier prototype files are migrated with their original definition retained.
// Source-format files (including unknown plugin data) are never projected to a
// fixed whitelist or silently stripped.
export function migrateLegacyWorkflow(raw) {
  const value = parseWorkflowDefinition(raw);
  const triggers = {
    "Asset upload": "AssetCreate",
    "Metadata extraction": "AssetMetadataExtraction",
  };
  const methods = {
    "Filter media type": (v) => ({
      method: `${core.name}#assetTypeFilter`,
      config: {
        allowedTypes: [
          { Image: "IMAGE", Video: "VIDEO", Audio: "AUDIO", Other: "OTHER" }[
            v
          ] ?? v,
        ],
      },
    }),
    "Add tag": (v) => ({
      method: `${core.name}#assetAddTags`,
      config: {
        tags: v
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      },
    }),
    Archive: () => ({
      method: `${core.name}#assetArchive`,
      config: { inverse: false },
    }),
    "Add to album": (v) => ({
      method: `${core.name}#assetAddToAlbums`,
      config: { albumIds: [], albumName: v },
    }),
  };
  const legacy =
    !!triggers[value.trigger] ||
    value.steps.some(
      (step) => methods[step.method] && typeof step.value === "string",
    );
  if (!legacy) return value;
  return {
    ...value,
    legacyDefinition: structuredClone(value),
    trigger: triggers[value.trigger] ?? value.trigger,
    steps: value.steps.map((step) =>
      methods[step.method] && typeof step.value === "string"
        ? { ...step, ...methods[step.method](step.value) }
        : step,
    ),
  };
}

export function schemaDefaults(schema) {
  if (Object.hasOwn(schema, "default")) return structuredClone(schema.default);
  if (schema.array || schema.type === "array") return [];
  if (schema.properties || schema.type === "object")
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(
          ([key, property]) =>
            (schema.required ?? []).includes(key) ||
            Object.hasOwn(property, "default"),
        )
        .map(([key, property]) => [key, schemaDefaults(property)]),
    );
  if (schema.enum) return schema.enum[0];
  if (schema.type === "boolean") return false;
  if (["number", "integer"].includes(schema.type)) return schema.minimum ?? 0;
  return "";
}
export function validateStepConfig(schema, config, path = "Parameters") {
  const errors = [];
  if (config === undefined) {
    errors.push(`${path} are missing.`);
    return errors;
  }
  if (config === null) {
    if ((schema.required ?? []).length)
      errors.push(`${path} require configured values.`);
    return errors;
  }
  if (schema.array || schema.type === "array") {
    if (!Array.isArray(config)) return [`${path} must be a list.`];
    const child = schema.array
      ? { ...schema, array: false }
      : (schema.items ?? {});
    for (const [index, value] of config.entries())
      errors.push(...validateStepConfig(child, value, `${path} ${index + 1}`));
    return errors;
  }
  if (schema.properties || schema.type === "object") {
    if (!plain(config)) return [`${path} must be an object.`];
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(config, key))
        errors.push(
          `${path}: ${schema.properties?.[key]?.title ?? key} is required.`,
        );
    for (const [key, value] of Object.entries(config))
      if (schema.properties?.[key])
        errors.push(
          ...validateStepConfig(
            schema.properties[key],
            value,
            `${path} / ${schema.properties[key].title ?? key}`,
          ),
        );
    return errors;
  }
  if (schema.enum && !schema.enum.includes(config))
    errors.push(`${path} is not an available choice.`);
  if (schema.type === "string" && typeof config !== "string")
    errors.push(`${path} must be text.`);
  if (schema.type === "boolean" && typeof config !== "boolean")
    errors.push(`${path} must be on or off.`);
  if (["number", "integer"].includes(schema.type)) {
    if (
      typeof config !== "number" ||
      !Number.isFinite(config) ||
      (schema.type === "integer" && !Number.isInteger(config))
    )
      errors.push(`${path} must be a valid ${schema.type}.`);
    else if (
      (schema.minimum !== undefined && config < schema.minimum) ||
      (schema.maximum !== undefined && config > schema.maximum)
    )
      errors.push(`${path} is outside the allowed range.`);
  }
  return errors;
}
export function workflowExecutionErrors(value) {
  let workflow;
  try {
    workflow = parseWorkflowDefinition(value);
  } catch (error) {
    return [error.message];
  }
  const errors = [];
  if (!workflowTriggers.some((trigger) => trigger.value === workflow.trigger))
    errors.push(
      "The trigger is unavailable. Scheduled workflows are not supported by this source workflow service.",
    );
  for (const [index, step] of workflow.steps.entries()) {
    const method = methodByKey(step.method);
    if (!method) {
      errors.push(
        `Step ${index + 1}: this plugin method is unavailable. Its definition is retained.`,
      );
      continue;
    }
    if (!method.types.includes("AssetV1"))
      errors.push(
        `Step ${index + 1}: this method is incompatible with asset events.`,
      );
    errors.push(
      ...validateStepConfig(
        method.schema ?? {},
        step.config,
        `Step ${index + 1}`,
      ),
    );
  }
  return errors;
}
export function workflowCredentialPaths(value, path = "") {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const current = path ? `${path}.${key}` : key;
    if (
      /^(headerValue|password|token|secret|authorization|apiKey|clientSecret)$/i.test(
        key,
      ) &&
      typeof child === "string" &&
      child.trim()
    )
      return [current];
    return workflowCredentialPaths(child, current);
  });
}
export function workflowPersistenceError(value) {
  try {
    parseWorkflowDefinition(value);
  } catch (error) {
    return error.message;
  }
  if (workflowCredentialPaths(value).length)
    return "Remove credential values before saving or exporting this workflow on this device. Configure credentials securely on the server.";
  if (value.enabled) {
    const problems = workflowExecutionErrors(value);
    if (problems.length)
      return "Pause this workflow before saving. " + problems[0];
  }
  return "";
}
export function exportWorkflowDefinition(value) {
  const error = workflowPersistenceError({ ...value, enabled: false });
  if (error) throw Error(error);
  return parseWorkflowDefinition(value);
}
export function updateWorkflowParameter(config, path, value) {
  if (
    !Array.isArray(path) ||
    !path.length ||
    path.some((key) => ["__proto__", "prototype", "constructor"].includes(key))
  )
    throw Error("Unsupported parameter path.");
  const next = structuredClone(config ?? {});
  let cursor = next;
  for (const key of path.slice(0, -1)) {
    if (!plain(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  if (value === undefined) delete cursor[path.at(-1)];
  else cursor[path.at(-1)] = value;
  return next;
}
