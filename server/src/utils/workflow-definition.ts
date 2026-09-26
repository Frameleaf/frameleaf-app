import { WorkflowTrigger } from '@immich/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  WorkflowDefinitionDocument,
  WorkflowDefinitionStep,
} from 'src/schema/tables/workflow-definition.table.js';
import { WorkflowIssueCode, WorkflowType } from 'src/enum.js';
import { isMethodCompatible, parseMethodString, triggerMap } from 'src/utils/workflow.js';

/**
 * Workflow definitions (FL-82), ported from the design template's `workflow-schema.mjs`.
 *
 * A definition is kept exactly as its owner wrote or imported it: unknown methods, their parameters
 * and fields this server does not use all survive. What can run is decided separately, by
 * `workflowIssues`, against the plugins installed and enabled right now; a definition with issues
 * can be stored paused but never enabled or executed.
 */

export const WORKFLOW_LIMITS = Object.freeze({ bytes: 256_000, steps: 100, depth: 24, nodes: 12_000 });

/** A method an enabled, installed plugin provides, with the parameter schema it declares. */
export type WorkflowMethodDefinition = {
  id: string;
  name: string;
  pluginName: string;
  types: WorkflowType[];
  schema: WorkflowParameterSchema | null;
};

export type WorkflowParameterSchema = {
  type?: string;
  title?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  array?: boolean;
  items?: WorkflowParameterSchema;
  required?: string[];
  properties?: Record<string, WorkflowParameterSchema>;
};

export type WorkflowIssue = { step?: number; code: WorkflowIssueCode; message: string };

type JsonContainer = Record<string, unknown> | unknown[];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const isContainer = (value: unknown): value is JsonContainer => isPlainObject(value) || Array.isArray(value);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Refuses values that are not ordinary JSON, or that are too large or deep to store and edit. */
export const assertWorkflowJson = (value: unknown): void => {
  let nodes = 0;
  const check = (item: unknown, depth: number) => {
    if (++nodes > WORKFLOW_LIMITS.nodes || depth > WORKFLOW_LIMITS.depth) {
      throw new Error('This workflow is too large or deeply nested.');
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
  if (JSON.stringify(value).length > WORKFLOW_LIMITS.bytes) {
    throw new Error('Choose a workflow smaller than 256 KB.');
  }
};

export const isKnownTrigger = (trigger: string): trigger is WorkflowTrigger => Object.hasOwn(triggerMap, trigger);

export const resolveDefinitionMethod = (methods: WorkflowMethodDefinition[], method: string) => {
  const parsed = parseMethodString(method);
  if (!parsed) {
    return;
  }
  return methods.find((item) => item.pluginName === parsed.pluginName && item.name === parsed.methodName);
};

// ---------------------------------------------------------------------------------------------------
// Parameters

export function validateStepConfig(schema: WorkflowParameterSchema, config: unknown, path = 'Parameters'): string[] {
  const errors: string[] = [];
  if (config === undefined) {
    return [`${path} are missing.`];
  }
  if (config === null) {
    if ((schema.required ?? []).length > 0) {
      errors.push(`${path} require configured values.`);
    }
    return errors;
  }
  if (schema.array || schema.type === 'array') {
    if (!Array.isArray(config)) {
      return [`${path} must be a list.`];
    }
    const child = schema.array ? { ...schema, array: false } : (schema.items ?? {});
    for (const [index, value] of config.entries()) {
      errors.push(...validateStepConfig(child, value, `${path} ${index + 1}`));
    }
    return errors;
  }
  if (schema.properties || schema.type === 'object') {
    if (!isPlainObject(config)) {
      return [`${path} must be an object.`];
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(config, key)) {
        errors.push(`${path}: ${schema.properties?.[key]?.title ?? key} is required.`);
      }
    }
    for (const [key, value] of Object.entries(config)) {
      const property = schema.properties?.[key];
      if (property) {
        errors.push(...validateStepConfig(property, value, `${path} / ${property.title ?? key}`));
      }
    }
    return errors;
  }
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

/**
 * Everything that stops a definition from running on this server. Every step counts, including a
 * disabled one, so turning a step on later never turns on something that cannot run.
 */
export function workflowIssues(
  definition: Pick<WorkflowDefinitionDocument, 'trigger' | 'steps'>,
  methods: WorkflowMethodDefinition[],
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const knownTrigger = isKnownTrigger(definition.trigger);
  if (!knownTrigger) {
    issues.push({
      code: WorkflowIssueCode.TriggerUnavailable,
      message: 'This trigger is unavailable. Scheduled workflows are not supported.',
    });
  }
  for (const [index, step] of definition.steps.entries()) {
    const label = `Step ${index + 1}`;
    const method = resolveDefinitionMethod(methods, step.method);
    if (!method) {
      issues.push({
        step: index,
        code: WorkflowIssueCode.MethodUnavailable,
        message: `${label}: this plugin method is unavailable. Its definition is retained.`,
      });
      continue;
    }
    if (knownTrigger && !isMethodCompatible(method, definition.trigger as WorkflowTrigger)) {
      issues.push({
        step: index,
        code: WorkflowIssueCode.MethodIncompatible,
        message: `${label}: this method cannot run for this trigger.`,
      });
    }
    const configErrors = validateStepConfig(method.schema ?? {}, step.config ?? {}, label);
    if (configErrors.length > 0) {
      issues.push({ step: index, code: WorkflowIssueCode.ConfigInvalid, message: configErrors[0]! });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------
// Credentials

/** Parameter names whose text values are credentials: kept on the server, never read back. */
const CREDENTIAL_KEY = /^(headerValue|password|token|secret|authorization|apiKey|clientSecret)$/i;

/** The key path of every non-empty credential value in a step's parameters. */
export function credentialPaths(value: unknown, path: string[] = []): string[][] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const current = [...path, key];
    if (CREDENTIAL_KEY.test(key) && typeof child === 'string' && child.trim()) {
      return [current];
    }
    return credentialPaths(child, current);
  });
}

const readPath = (value: unknown, path: string[]): unknown => {
  let cursor = value;
  for (const key of path) {
    if (!isContainer(cursor) || !Object.hasOwn(cursor, key) || UNSAFE_KEYS.has(key)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
};

const hasPath = (value: unknown, path: string[]): boolean => {
  let cursor = value;
  for (const key of path) {
    if (!isContainer(cursor) || !Object.hasOwn(cursor, key)) {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return true;
};

const writePath = (value: Record<string, unknown>, path: string[], next: unknown) => {
  if (path.some((key) => UNSAFE_KEYS.has(key))) {
    throw new Error('Workflow definitions cannot contain prototype keys.');
  }
  let cursor: Record<string, unknown> = value;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(cursor, key) || !isContainer(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const last = path.at(-1)!;
  if (next === undefined) {
    delete cursor[last];
  } else {
    cursor[last] = next;
  }
};

/** Parameters without their credential values, and where those values are kept. */
export function redactCredentials(config: Record<string, unknown> | null): {
  config: Record<string, unknown> | null;
  storedSecrets: string[];
} {
  if (!config) {
    return { config, storedSecrets: [] };
  }
  const paths = credentialPaths(config);
  if (paths.length === 0) {
    return { config, storedSecrets: [] };
  }
  const redacted = structuredClone(config);
  for (const path of paths) {
    writePath(redacted, path, undefined);
  }
  return { config: redacted, storedSecrets: paths.map((path) => path.join('.')) };
}

/**
 * A credential left out of an edited step keeps its stored value; one that is sent, even empty,
 * replaces it. The caller only passes the stored parameters of the same step with the same method.
 */
export function restoreCredentials(
  config: Record<string, unknown> | null,
  stored: Record<string, unknown> | null,
): Record<string, unknown> | null {
  assertWorkflowJson(config);
  assertWorkflowJson(stored);
  const paths = credentialPaths(stored);
  if (paths.length === 0) {
    return config;
  }
  if (
    paths.some((path) => !hasPath(config, path)) &&
    !isDeepStrictEqual(redactCredentials(config).config, redactCredentials(stored).config)
  ) {
    throw new Error('Re-enter stored credentials when changing the fields around them.');
  }
  const next = structuredClone(config ?? {});
  for (const path of paths) {
    if (!hasPath(next, path)) {
      writePath(next, path, readPath(stored, path));
    }
  }
  return next;
}

/**
 * A failure message fit for run history: shortened, and without the step's credentials.
 *
 * `secrets` is everything the failing step could have echoed back — its parameters and the extra
 * fields its definition carries (FL-82) — and every credential-named value anywhere in it is scrubbed.
 */
export function redactRunError(message: string, secrets: unknown, maxLength = 500): string {
  let result = message;
  for (const path of credentialPaths(secrets)) {
    const secret = readPath(secrets, path);
    if (typeof secret === 'string' && secret.length >= 4) {
      result = result.split(secret).join('[credential]');
    }
  }
  return result.length > maxLength ? `${result.slice(0, maxLength - 1)}…` : result;
}

// ---------------------------------------------------------------------------------------------------
// Documents

const KNOWN_STEP_KEYS = new Set(['id', 'method', 'config', 'enabled', 'extra']);
const KNOWN_WORKFLOW_KEYS = new Set(['id', 'trigger', 'name', 'description', 'enabled', 'logging', 'steps', 'extra']);

const withoutKnown = (extra: Record<string, unknown> | null | undefined, known: Set<string>) =>
  Object.fromEntries(Object.entries(extra ?? {}).filter(([key]) => !known.has(key)));

export type WorkflowDefinitionInput = {
  trigger: string;
  extra?: Record<string, unknown> | null;
  steps: Array<{
    id?: string;
    method: string;
    config: Record<string, unknown> | null;
    enabled?: boolean;
    extra?: Record<string, unknown> | null;
  }>;
};

/** A stored definition from a request, keeping each step's id when it has a unique one. */
export function toDefinition(input: WorkflowDefinitionInput): WorkflowDefinitionDocument {
  if (input.steps.length > WORKFLOW_LIMITS.steps) {
    throw new Error('Choose a workflow with up to 100 ordered steps.');
  }
  const seen = new Set<string>();
  const steps: WorkflowDefinitionStep[] = input.steps.map((step) => {
    const id = step.id && !seen.has(step.id) ? step.id : randomUUID();
    seen.add(id);
    return {
      id,
      method: step.method,
      config: step.config ?? null,
      enabled: step.enabled ?? true,
      extra: withoutKnown(step.extra, KNOWN_STEP_KEYS),
    };
  });
  const definition: WorkflowDefinitionDocument = {
    version: 1,
    trigger: input.trigger,
    extra: withoutKnown(input.extra, KNOWN_WORKFLOW_KEYS),
    steps,
  };
  assertWorkflowJson(definition);
  return definition;
}

/** The definition of a workflow stored before definitions were kept: its runnable steps, in order. */
export function definitionFromSteps(
  trigger: string,
  steps: Array<{ id: string; pluginName: string; methodName: string; config: unknown; enabled: boolean }>,
): WorkflowDefinitionDocument {
  return {
    version: 1,
    trigger,
    extra: {},
    steps: steps.map((step) => ({
      id: step.id,
      method: `${step.pluginName}#${step.methodName}`,
      config: (step.config as Record<string, unknown> | null) ?? null,
      enabled: step.enabled,
      extra: {},
    })),
  };
}
