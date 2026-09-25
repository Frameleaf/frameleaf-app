/**
 * Server-side validation of Studio command envelopes (FL-92, `STU-205`).
 *
 * The web host validates a command before it leaves the browser, and the native clients
 * build their envelopes from the same published catalogue. Neither is trusted here: this
 * module re-checks the envelope against the generated mirror
 * (`studio-commands.generated.ts`, written by `scripts/frameleaf-studio-commands.mjs` from
 * `studio/frameleaf-studio-commands.json`) so a client that is ahead, behind or simply
 * wrong is refused with a reason instead of reaching a service with a payload nobody
 * checked.
 *
 * It is deliberately framework-free — no NestJS, no repositories — like
 * `media-policy.ts`, so a controller, a service and a worker can all apply the same rules.
 *
 * What it checks: that the id is published, that the envelope carries a usable revision,
 * idempotency key and timestamp, that every required payload field is present and every
 * present field has the declared kind, and that no unknown top-level payload field is
 * smuggled in. A payload field is an *intent*, so its own set of names is closed.
 *
 * A `time`, `duration` or `rate` field is an exact rational (FL-93), and it is checked with
 * `isRational` from `rational-time.ts` rather than with `typeof value === 'number'`: an
 * unreduced pair, a zero denominator or a float that a client rounded on the way out is
 * refused here instead of becoming a boundary the encoder cannot reproduce.
 *
 * What it deliberately does not check: the meaning of the payload — that a clip id exists,
 * that a time is inside the sequence, that the actor may edit the project, or whether the
 * command is implemented yet. Those belong to the story that owns the command, with the
 * graph, the lease and the access rules in hand. Values typed `object` or `object[]` in
 * the catalogue are graph-shaped and pass through unread, which is what keeps unknown
 * Freecut fields, nulls, arrays and rational timing extensions lossless.
 */

import { isRational } from 'src/utils/rational-time.js';
import {
  type StudioCommandCapability,
  type StudioCommandId,
  type StudioCommandMirror,
  studioCommandMirror,
} from 'src/utils/studio-commands.generated.js';

export {
  STUDIO_COMMAND_SCHEMA_VERSION,
  STUDIO_ENGINE_REVISION,
  studioCommandIds,
  studioCommandMirror,
} from 'src/utils/studio-commands.generated.js';
export type {
  StudioCommandCapability,
  StudioCommandId,
  StudioCommandMirror,
  StudioCommandScope,
} from 'src/utils/studio-commands.generated.js';

/** Longest idempotency key the host will ever mint, matched to the web boundary guard. */
export const STUDIO_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export interface StudioCommandEnvelope {
  id: StudioCommandId;
  payload: Record<string, unknown>;
  revision: number;
  idempotencyKey: string;
  issuedAt: number;
}

export type StudioCommandValidationReason = 'invalid' | 'unknown-command' | 'invalid-payload';

export type StudioCommandValidation =
  | { valid: true; envelope: StudioCommandEnvelope; definition: StudioCommandMirror }
  | { valid: false; reason: StudioCommandValidationReason; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const isStudioCommandId = (value: unknown): value is StudioCommandId =>
  typeof value === 'string' && Object.hasOwn(studioCommandMirror, value);

export const studioCommandDefinition = (id: StudioCommandId): StudioCommandMirror => studioCommandMirror[id];

/** Kinds the catalogue can declare, checked structurally rather than by name. */
const matchesFieldType = (type: string, value: unknown): boolean => {
  switch (type) {
    case 'boolean': {
      return typeof value === 'boolean';
    }
    case 'number': {
      return typeof value === 'number' && Number.isFinite(value);
    }
    case 'duration':
    case 'rate':
    case 'time': {
      return isRational(value);
    }
    case 'string': {
      return typeof value === 'string';
    }
    case 'string[]': {
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    }
    case 'object': {
      // Null is allowed: clearing a transition, a mask or a grade is a real command.
      return value === null || isRecord(value);
    }
    case 'object[]': {
      return Array.isArray(value) && value.every((item) => isRecord(item));
    }
    default: {
      return false;
    }
  }
};

export const validateStudioCommandPayload = (
  id: StudioCommandId,
  payload: unknown,
): { valid: true } | { valid: false; detail: string } => {
  if (!isRecord(payload)) {
    return { valid: false, detail: `${id}: payload must be an object` };
  }

  const declared = studioCommandMirror[id].payload as Record<string, string>;
  for (const [name, declaration] of Object.entries(declared)) {
    const optional = declaration.endsWith('?');
    const type = optional ? declaration.slice(0, -1) : declaration;
    const present = Object.hasOwn(payload, name) && payload[name] !== undefined;
    if (!present) {
      if (!optional) {
        return { valid: false, detail: `${id}: missing required field ${name}` };
      }
      continue;
    }
    if (!matchesFieldType(type, payload[name])) {
      return { valid: false, detail: `${id}: field ${name} is not ${declaration}` };
    }
  }

  for (const name of Object.keys(payload)) {
    if (!Object.hasOwn(declared, name)) {
      // A payload names an intent; an unrecognised field is a contract mismatch, not an
      // extension point. Graph-shaped data travels inside a declared `object` field, where
      // unknown keys are preserved.
      return { valid: false, detail: `${id}: unknown field ${name}` };
    }
  }

  return { valid: true };
};

export const validateStudioCommandEnvelope = (value: unknown): StudioCommandValidation => {
  if (!isRecord(value)) {
    return { valid: false, reason: 'invalid', detail: 'envelope must be an object' };
  }

  if (!isStudioCommandId(value.id)) {
    return { valid: false, reason: 'unknown-command', detail: `unknown command ${String(value.id)}` };
  }

  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    return { valid: false, reason: 'invalid', detail: `${value.id}: revision must be a non-negative integer` };
  }

  if (
    typeof value.idempotencyKey !== 'string' ||
    value.idempotencyKey.length === 0 ||
    value.idempotencyKey.length > STUDIO_IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    return { valid: false, reason: 'invalid', detail: `${value.id}: idempotency key is missing or too long` };
  }

  if (typeof value.issuedAt !== 'number' || !Number.isFinite(value.issuedAt)) {
    return { valid: false, reason: 'invalid', detail: `${value.id}: issuedAt must be a finite number` };
  }

  const payload = validateStudioCommandPayload(value.id, value.payload);
  if (!payload.valid) {
    return { valid: false, reason: 'invalid-payload', detail: payload.detail };
  }

  return {
    valid: true,
    envelope: {
      id: value.id,
      payload: value.payload as Record<string, unknown>,
      revision: value.revision,
      idempotencyKey: value.idempotencyKey,
      issuedAt: value.issuedAt,
    },
    definition: studioCommandMirror[value.id],
  };
};

/**
 * The commands in an ordered batch that would change the stored graph. A batch with any of
 * them needs the write lease and the caller's revision; a batch without them (job
 * submissions, a bundle export) does not.
 */
export const studioBatchMutatesGraph = (envelopes: readonly StudioCommandEnvelope[]): boolean =>
  envelopes.some((envelope) => studioCommandMirror[envelope.id].mutatesGraph);

/** Worker capabilities an ordered batch requires, sorted and de-duplicated. */
export const studioBatchCapabilities = (envelopes: readonly StudioCommandEnvelope[]): StudioCommandCapability[] =>
  [
    ...new Set(
      envelopes
        .map((envelope) => studioCommandMirror[envelope.id].capability)
        .filter((capability): capability is StudioCommandCapability => capability !== null),
    ),
  ].sort();

/** The most canonical commands one revision may carry. */
export const STUDIO_MAX_COMMANDS_PER_SAVE = 500;

export type StudioCommandBatchCheck =
  { ok: true; counts: Record<string, number>; total: number } | { ok: false; detail: string };

/**
 * The canonical commands a saved revision claims to contain (FL-92). The editor applied them with
 * the engine before saving the graph they produced; the server cannot re-run the engine, but it can
 * refuse a batch that is not one: an unknown command, a malformed payload, a command issued against
 * a head later than the one this save builds on, a key used twice, or a command that changes nothing
 * in the graph (those never reach a revision). A command issued against an earlier head is normal:
 * edits made while the previous autosave was in flight travel in the next one. The revision's summary is then counted from
 * the envelopes rather than trusted from the client.
 */
export const checkStudioCommandBatch = (
  commands: readonly unknown[],
  expectedRevision: number,
): StudioCommandBatchCheck => {
  if (commands.length > STUDIO_MAX_COMMANDS_PER_SAVE) {
    return { ok: false, detail: `A revision carries at most ${STUDIO_MAX_COMMANDS_PER_SAVE} commands` };
  }
  const keys = new Set<string>();
  const counts: Record<string, number> = {};
  for (const [index, candidate] of commands.entries()) {
    const checked = validateStudioCommandEnvelope(candidate);
    if (!checked.valid) {
      return { ok: false, detail: `command ${index}: ${checked.detail}` };
    }
    const { envelope, definition } = checked;
    if (!definition.mutatesGraph) {
      return { ok: false, detail: `command ${index}: ${envelope.id} does not change the graph` };
    }
    if (envelope.revision > expectedRevision) {
      return {
        ok: false,
        detail: `command ${index}: ${envelope.id} was issued against revision ${envelope.revision}, after ${expectedRevision}`,
      };
    }
    if (keys.has(envelope.idempotencyKey)) {
      return { ok: false, detail: `command ${index}: idempotency key ${envelope.idempotencyKey} is used twice` };
    }
    keys.add(envelope.idempotencyKey);
    counts[envelope.id] = (counts[envelope.id] ?? 0) + 1;
  }
  return { ok: true, counts, total: commands.length };
};
