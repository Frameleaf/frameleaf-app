import type {
  PluginMethodResponseDto,
  WorkflowCreateDto,
  WorkflowResponseDto,
  WorkflowShareResponseDto,
  WorkflowStepDto,
  WorkflowTriggerResponseDto,
  WorkflowUpdateDto,
} from '@immich/sdk';

/**
 * Workflows (FL-82), ported from the design template's `workflow-schema.mjs` and `WorkflowDesigner.jsx`.
 *
 * The designer edits a draft of the complete definition. Fields this app does not use, steps whose
 * plugin method is not installed and their parameters all stay in the draft and go back to the
 * server unchanged; the server stores them and refuses to enable or run what cannot run. Checks here
 * mirror the server's so the designer can say what is wrong before saving — the server decides.
 */

export const WORKFLOW_LIMITS = Object.freeze({
  bytes: 256_000,
  fileBytes: 100_000,
  steps: 100,
  depth: 24,
  nodes: 12_000,
});

export type WorkflowParameterSchema = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  precision?: number;
  array?: boolean;
  items?: WorkflowParameterSchema;
  required?: string[];
  properties?: Record<string, WorkflowParameterSchema>;
  uiHint?: { type?: string; order?: number };
};

export type WorkflowDraftStep = {
  /** The server's step id; keeps a stored credential that the draft leaves out. */
  id?: string;
  method: string;
  config: Record<string, unknown> | null;
  enabled: boolean;
  extra: Record<string, unknown>;
  /** Parameter paths with a stored credential the server does not return. */
  storedSecrets: string[];
};

export type WorkflowDraft = {
  name: string | null;
  description: string | null;
  trigger: string;
  enabled: boolean;
  logging: boolean;
  extra: Record<string, unknown>;
  steps: WorkflowDraftStep[];
};

export type WorkflowProblem = { step?: number; message: string };

const KNOWN_WORKFLOW_KEYS = new Set([
  'id',
  'ownerId',
  'trigger',
  'name',
  'description',
  'enabled',
  'logging',
  'steps',
  'extra',
]);
const KNOWN_STEP_KEYS = new Set(['id', 'method', 'config', 'enabled', 'extra', 'storedSecrets']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** A copy of a JSON value; unlike `structuredClone` it also copies reactive state proxies. */
// eslint-disable-next-line unicorn/prefer-structured-clone -- structuredClone throws on Svelte state proxies
export const cloneJson = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

const split = (value: Record<string, unknown>, known: Set<string>) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));

// ---------------------------------------------------------------------------------------------------
// Parsing, import and export

/**
 * A workflow definition from text or a parsed value: ordinary JSON, within the size limits, with a
 * trigger and ordered steps that each name a method. Unknown fields are kept.
 */
export function parseWorkflowDefinition(raw: unknown): Record<string, unknown> & { trigger: string; steps: unknown[] } {
  if (typeof raw === 'string' && raw.length > WORKFLOW_LIMITS.bytes) {
    throw new Error('Choose a workflow smaller than 256 KB.');
  }
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  let nodes = 0;
  const check = (item: unknown, depth: number) => {
    if (++nodes > WORKFLOW_LIMITS.nodes || depth > WORKFLOW_LIMITS.depth) {
      throw new Error('This workflow is too large or deeply nested to edit here.');
    }
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        check(child, depth + 1);
      }
      return;
    }
    if (isPlainObject(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (UNSAFE_KEYS.has(key)) {
          throw new Error('Workflow definitions cannot contain prototype keys.');
        }
        check(child, depth + 1);
      }
      return;
    }
    throw new Error('Workflow definitions must contain ordinary JSON values.');
  };
  check(value, 0);
  if (
    !isPlainObject(value) ||
    typeof value.trigger !== 'string' ||
    !value.trigger ||
    !Array.isArray(value.steps) ||
    value.steps.length > WORKFLOW_LIMITS.steps
  ) {
    throw new Error('Choose a workflow with a trigger and up to 100 ordered steps.');
  }
  for (const key of ['name', 'description'] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(`The workflow ${key} must be text or empty.`);
    }
  }
  for (const key of ['enabled', 'logging'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(`${key} must be true or false.`);
    }
  }
  for (const step of value.steps) {
    if (!isPlainObject(step) || typeof step.method !== 'string' || !step.method.trim()) {
      throw new Error('Every step needs a method name.');
    }
    if (step.config !== undefined && step.config !== null && !isPlainObject(step.config)) {
      throw new Error('Step parameters must be an object or empty.');
    }
    if (step.enabled !== undefined && typeof step.enabled !== 'boolean') {
      throw new Error('Step enabled must be true or false.');
    }
  }
  if (JSON.stringify(value).length > WORKFLOW_LIMITS.bytes) {
    throw new Error('Choose a workflow smaller than 256 KB.');
  }
  return cloneJson(value) as Record<string, unknown> & { trigger: string; steps: unknown[] };
}

/** A draft from a complete definition document, keeping every field this app does not use. */
export function draftFromDocument(raw: unknown, previous?: WorkflowDraft): WorkflowDraft {
  const value = parseWorkflowDefinition(raw);
  const previousById = new Map(previous?.steps.filter((step) => step.id).map((step) => [step.id, step]));
  const seenIds = new Set<string>();
  const steps = (value.steps as Record<string, unknown>[]).map((step) => {
    const id = typeof step.id === 'string' ? step.id : undefined;
    const before = id && !seenIds.has(id) ? previousById.get(id) : undefined;
    if (id) {
      seenIds.add(id);
    }
    // A JSON edit carries a stored credential only with its explicit step id and unchanged public config.
    const same =
      before &&
      before.method === step.method &&
      JSON.stringify(withoutCredentials(before.config)) === JSON.stringify(withoutCredentials(step.config ?? null));
    return {
      id: same ? before.id : undefined,
      method: step.method as string,
      config: (step.config as Record<string, unknown> | null | undefined) ?? null,
      enabled: step.enabled !== false,
      extra: { ...(isPlainObject(step.extra) && step.extra), ...split(step, KNOWN_STEP_KEYS) },
      storedSecrets: same ? before.storedSecrets : [],
    };
  });
  return {
    name: (value.name as string | null | undefined) ?? null,
    description: (value.description as string | null | undefined) ?? null,
    trigger: value.trigger,
    enabled: value.enabled === true,
    logging: value.logging !== false,
    extra: { ...(isPlainObject(value.extra) && value.extra), ...split(value, KNOWN_WORKFLOW_KEYS) },
    steps,
  };
}

/** The complete definition as one document: additional fields inline, as they were imported. */
export function draftToDocument(draft: WorkflowDraft): Record<string, unknown> {
  return {
    ...draft.extra,
    name: draft.name,
    description: draft.description,
    trigger: draft.trigger,
    enabled: draft.enabled,
    logging: draft.logging,
    steps: draft.steps.map((step) => ({
      ...step.extra,
      ...(step.id && { id: step.id }),
      method: step.method,
      config: step.config,
      ...(!step.enabled && { enabled: false }),
    })),
  };
}

const withoutCredentials = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => withoutCredentials(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(isCredentialKey(key) && typeof child === 'string'))
      .map(([key, child]) => [key, withoutCredentials(child)]),
  );
};

/** The draft as a portable file: paused, with any credential typed into it left out. */
export function exportDraft(draft: WorkflowDraft): Record<string, unknown> {
  const { enabled: _, ...document } = draftToDocument(draft);
  return {
    ...document,
    steps: (document.steps as Record<string, unknown>[]).map(({ id: _, ...step }) => ({
      ...step,
      config: withoutCredentials(step.config),
    })),
  };
}

/** The portable file for a stored workflow: no ids, no stored credentials, every additional field. */
export function exportDocument(share: WorkflowShareResponseDto): Record<string, unknown> {
  return {
    ...share.extra,
    name: share.name,
    description: share.description,
    trigger: share.trigger,
    steps: share.steps.map((step) => ({
      ...step.extra,
      method: step.method,
      config: step.config,
      ...(step.enabled === false && { enabled: false }),
    })),
  };
}

export function draftFromWorkflow(workflow: WorkflowResponseDto): WorkflowDraft {
  return {
    name: workflow.name,
    description: workflow.description,
    trigger: workflow.trigger,
    enabled: workflow.enabled,
    logging: workflow.logging,
    extra: cloneJson(workflow.extra),
    steps: workflow.steps.map((step) => ({
      id: step.id,
      method: step.method,
      config: cloneJson(step.config),
      enabled: step.enabled,
      extra: cloneJson(step.extra),
      storedSecrets: step.storedSecrets,
    })),
  };
}

export const emptyDraft = (trigger = 'AssetCreate'): WorkflowDraft => ({
  name: null,
  description: null,
  trigger,
  enabled: false,
  logging: true,
  extra: {},
  steps: [],
});

const toStepDto = (step: WorkflowDraftStep): WorkflowStepDto => ({
  ...(step.id && { id: step.id }),
  method: step.method,
  config: step.config,
  enabled: step.enabled,
  extra: step.extra,
});

export const draftToCreateDto = (draft: WorkflowDraft): WorkflowCreateDto => ({
  name: draft.name,
  description: draft.description,
  trigger: draft.trigger,
  enabled: draft.enabled,
  logging: draft.logging,
  extra: draft.extra,
  steps: draft.steps.map((step) => toStepDto(step)),
});

export const draftToUpdateDto = (draft: WorkflowDraft): WorkflowUpdateDto => draftToCreateDto(draft);

/** A workflow file chosen for import, as a paused draft. */
export function importWorkflowFile(text: string, size: number): WorkflowDraft {
  if (size > WORKFLOW_LIMITS.fileBytes) {
    throw new Error('Choose a workflow file smaller than 100 KB.');
  }
  return { ...draftFromDocument(text), enabled: false };
}

// ---------------------------------------------------------------------------------------------------
// Schemas and parameters

export const methodSchema = (method: PluginMethodResponseDto | undefined): WorkflowParameterSchema =>
  (method?.schema as WorkflowParameterSchema | undefined) ?? {};

export const isObjectSchema = (schema: WorkflowParameterSchema) =>
  !schema.array && schema.type !== 'array' && (!!schema.properties || schema.type === 'object');

export const isArraySchema = (schema: WorkflowParameterSchema) => !!schema.array || schema.type === 'array';

export function schemaDefaults(schema: WorkflowParameterSchema): unknown {
  if (Object.hasOwn(schema, 'default')) {
    return cloneJson(schema.default);
  }
  if (isArraySchema(schema)) {
    return [];
  }
  if (schema.properties || schema.type === 'object') {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key, property]) => (schema.required ?? []).includes(key) || Object.hasOwn(property, 'default'))
        .map(([key, property]) => [key, schemaDefaults(property)]),
    );
  }
  if (schema.enum) {
    return schema.enum[0];
  }
  if (schema.type === 'boolean') {
    return false;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return schema.minimum ?? 0;
  }
  return '';
}

/** Properties in the order the plugin asks for, then as declared. */
export const orderedProperties = (schema: WorkflowParameterSchema) =>
  [...Object.entries(schema.properties ?? {})].sort(
    ([, a], [, b]) => (a.uiHint?.order ?? 99) - (b.uiHint?.order ?? 99),
  );

export function validateStepConfig(schema: WorkflowParameterSchema, config: unknown, path = 'Parameters'): string[] {
  if (config === undefined) {
    return [`${path} are missing.`];
  }
  if (config === null) {
    return (schema.required ?? []).length > 0 ? [`${path} require configured values.`] : [];
  }
  if (isArraySchema(schema)) {
    if (!Array.isArray(config)) {
      return [`${path} must be a list.`];
    }
    const child = schema.array ? { ...schema, array: false } : (schema.items ?? {});
    return config.flatMap((value, index) => validateStepConfig(child, value, `${path} ${index + 1}`));
  }
  if (schema.properties || schema.type === 'object') {
    if (!isPlainObject(config)) {
      return [`${path} must be an object.`];
    }
    const errors = (schema.required ?? [])
      .filter((key) => !Object.hasOwn(config, key))
      .map((key) => `${path}: ${schema.properties?.[key]?.title ?? key} is required.`);
    for (const [key, value] of Object.entries(config)) {
      const property = schema.properties?.[key];
      if (property) {
        errors.push(...validateStepConfig(property, value, `${path} / ${property.title ?? key}`));
      }
    }
    return errors;
  }
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(config)) {
    errors.push(`${path} is not an available choice.`);
  }
  if (schema.type === 'string' && typeof config !== 'string') {
    errors.push(`${path} must be text.`);
  }
  if (schema.type === 'boolean' && typeof config !== 'boolean') {
    errors.push(`${path} must be on or off.`);
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof config !== 'number' ||
      !Number.isFinite(config) ||
      (schema.type === 'integer' && !Number.isSafeInteger(config))
    ) {
      errors.push(`${path} must be a valid ${schema.type}.`);
    } else if (
      (schema.minimum !== undefined && config < schema.minimum) ||
      (schema.maximum !== undefined && config > schema.maximum)
    ) {
      errors.push(`${path} is outside the allowed range.`);
    }
  }
  return errors;
}

/** Credential parameter names: the server keeps their values and never returns them. */
export const isCredentialKey = (key: string) =>
  /^(headerValue|password|token|secret|authorization|apiKey|clientSecret)$/i.test(key);

/** Sets (or with `undefined`, removes) one parameter, keeping every other field of the step. */
export function updateWorkflowParameter(config: unknown, path: string[], value: unknown): Record<string, unknown> {
  if (path.length === 0 || path.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
    throw new Error('Unsupported parameter path.');
  }
  const next = cloneJson(isPlainObject(config) ? config : {});
  let cursor: Record<string, unknown> = next;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const last = path.at(-1)!;
  if (value === undefined) {
    delete cursor[last];
  } else {
    cursor[last] = value;
  }
  return next;
}

// ---------------------------------------------------------------------------------------------------
// What can run

const parseMethod = (method: string) => /^([^@#\s]+)(?:@[^#\s]*)?#([^@#\s]+)$/.exec(method);

/** The installed method a step names, with or without a version. */
export function findMethod(methods: PluginMethodResponseDto[], method: string) {
  const match = parseMethod(method);
  return match ? methods.find((item) => item.key === `${match[1]}#${match[2]}`) : undefined;
}

/** What stops a draft from running with the installed methods and triggers; every step counts. */
export function workflowProblems(
  draft: Pick<WorkflowDraft, 'trigger' | 'steps'>,
  methods: PluginMethodResponseDto[],
  triggers: WorkflowTriggerResponseDto[],
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const trigger = triggers.find((item) => item.trigger === draft.trigger);
  if (!trigger) {
    problems.push({ message: 'This trigger is unavailable. Scheduled workflows are not supported.' });
  }
  for (const [index, step] of draft.steps.entries()) {
    const label = `Step ${index + 1}`;
    const method = findMethod(methods, step.method);
    if (!method) {
      problems.push({
        step: index,
        message: `${label}: this plugin method is unavailable. Its definition is retained.`,
      });
      continue;
    }
    if (trigger && method.types.every((type) => !trigger.types.includes(type))) {
      problems.push({ step: index, message: `${label}: this method cannot run for this trigger.` });
    }
    // a stored credential is on the server even though the draft does not hold it
    let config: unknown = step.config ?? {};
    for (const path of step.storedSecrets) {
      const keys = path.split('.');
      if (!hasPath(config, keys)) {
        config = updateWorkflowParameter(config, keys, '•');
      }
    }
    const [first] = validateStepConfig(methodSchema(method), config, label);
    if (first) {
      problems.push({ step: index, message: first });
    }
  }
  return problems;
}

export type WorkflowPreviewStep = {
  index: number;
  method: string;
  /** The installed method's title, when the step names one. */
  title?: string;
  result: 'validated' | 'disabled';
};

/**
 * "Check and preview" (FL-82): a dry run built on the client from the plugin method schemas, as the
 * prototype's `previewWorkflow` (utilities-data.mjs) does. It only succeeds for a definition with no
 * problems and says, step by step, what a run would do. Nothing is executed and no webhook is sent;
 * running still needs the server's workflow service (owner decision FL-146: client-side dry run).
 */
export function previewWorkflow(
  draft: Pick<WorkflowDraft, 'trigger' | 'steps'>,
  methods: PluginMethodResponseDto[],
  triggers: WorkflowTriggerResponseDto[],
): { problems: WorkflowProblem[]; steps: WorkflowPreviewStep[] } {
  const problems = workflowProblems(draft, methods, triggers);
  if (problems.length > 0) {
    return { problems, steps: [] };
  }
  return {
    problems,
    steps: draft.steps.map((step, index) => ({
      index,
      method: step.method,
      title: findMethod(methods, step.method)?.title,
      result: step.enabled ? 'validated' : 'disabled',
    })),
  };
}

const hasPath = (value: unknown, path: string[]) => {
  let cursor = value;
  for (const key of path) {
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, key)) {
      return false;
    }
    cursor = cursor[key];
  }
  return true;
};

export type WorkflowStatus = 'enabled' | 'blocked' | 'paused';

/** Enabled, paused, or enabled but blocked because the server can no longer run it. */
export const workflowStatus = (workflow: Pick<WorkflowResponseDto, 'enabled' | 'issues'>): WorkflowStatus =>
  workflow.enabled ? (workflow.issues.length > 0 ? 'blocked' : 'enabled') : 'paused';

export const isFilterMethod = (method: PluginMethodResponseDto | undefined) => !!method?.uiHints.includes('Filter');

/** The file name of an exported workflow. */
export const exportFileName = (name: string | null) =>
  `${
    (name ?? '')
      .trim()
      .replaceAll(/[^\w -]+/g, '')
      .replaceAll(/\s+/g, '-')
      .toLowerCase() || 'frameleaf-workflow'
  }.json`;
