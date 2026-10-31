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
 * Freecut fields, nulls, arrays and rational timing extensions lossless. The one exception is
 * `clip.setMask` (FL-348): its `mask` is a closed intent, not graph-shaped data, so its fields,
 * ranges and pen-path vertices are checked here as section 17.1 of the graph protocol states. The
 * `style`, `transform`, `mask` and `spans` of `shape.add`, `shape.setStyle` and `title.setStyle` are
 * closed in the same way (sections 17.4, 17.5 and 14.3.4): everything that can be judged without
 * the graph is checked here, and the engine checks the rest against the clip.
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
    case 'Array<{id:string,at:Rational,gainDb:number}>': {
      if (!Array.isArray(value) || value.length > 4096) {
        return false;
      }
      const ids = new Set<string>();
      const times = new Set<string>();
      return value.every((point) => {
        if (
          !isRecord(point) ||
          Object.keys(point).some((key) => !['id', 'at', 'gainDb'].includes(key)) ||
          typeof point.id !== 'string' ||
          point.id.length === 0 ||
          [...point.id].length > 128 ||
          ids.has(point.id) ||
          !isRational(point.at) ||
          point.at.num < 0 ||
          times.has(`${point.at.num}/${point.at.den}`) ||
          typeof point.gainDb !== 'number' ||
          !Number.isFinite(point.gainDb) ||
          point.gainDb < -60 ||
          point.gainDb > 12
        ) {
          return false;
        }
        ids.add(point.id);
        times.add(`${point.at.num}/${point.at.den}`);
        return true;
      });
    }
    default: {
      return false;
    }
  }
};

const MASK_FIELDS = new Set(['type', 'feather', 'opacity', 'invert', 'path']);
const VERTEX_FIELDS = new Set(['position', 'inHandle', 'outHandle', 'tangentMode']);
const TANGENT_MODES = new Set(['corner', 'smooth', 'continuous', 'broken']);
export const STUDIO_MASK_MAX_VERTICES = 1000;

const isPoint = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n));

const percent = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/** Section 17.1 of the Studio graph protocol: the closed shape of a `clip.setMask` mask. */
const maskProblem = (mask: Record<string, unknown>): string | undefined => {
  for (const name of Object.keys(mask)) {
    if (!MASK_FIELDS.has(name)) {
      return `unknown mask field ${name}`;
    }
  }
  if (mask.type !== undefined && mask.type !== 'clip' && mask.type !== 'alpha') {
    return 'mask type must be "clip" or "alpha"';
  }
  for (const name of ['feather', 'opacity']) {
    if (mask[name] !== undefined && !percent(mask[name])) {
      return `mask ${name} must be a number from 0 to 100`;
    }
  }
  if (mask.invert !== undefined && typeof mask.invert !== 'boolean') {
    return 'mask invert must be a boolean';
  }
  if (mask.path !== undefined) {
    const path = mask.path;
    if (!Array.isArray(path) || path.length < 3 || path.length > STUDIO_MASK_MAX_VERTICES) {
      return `mask path must have 3 to ${STUDIO_MASK_MAX_VERTICES} vertices`;
    }
    for (const vertex of path) {
      if (!isRecord(vertex) || Object.keys(vertex).some((name) => !VERTEX_FIELDS.has(name))) {
        return 'a mask path vertex must be { position, inHandle, outHandle, tangentMode? }';
      }
      if (!isPoint(vertex.position) || !isPoint(vertex.inHandle) || !isPoint(vertex.outHandle)) {
        return 'a mask path position or handle must be [x, y]';
      }
      if (vertex.tangentMode !== undefined && !TANGENT_MODES.has(vertex.tangentMode as string)) {
        return 'unknown mask path tangent mode';
      }
    }
  }
  return undefined;
};

type FieldCheck = (value: unknown) => boolean;

/** `#rrggbb` or `#rrggbbaa`; no other CSS colour form is a command value. */
const isHexColour: FieldCheck = (value) => typeof value === 'string' && /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
const isBoolean: FieldCheck = (value) => typeof value === 'boolean';
const within =
  (min: number, max: number): FieldCheck =>
  (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const oneOf =
  (...options: string[]): FieldCheck =>
  (value) =>
    options.includes(value as string);

export const STUDIO_SHAPE_TYPES = ['rectangle', 'circle', 'triangle', 'ellipse', 'star', 'polygon', 'heart', 'path'];

/** Section 17.5: each shape style field, the shape types that have it, and whether null may clear it. */
const SHAPE_STYLE_FIELDS: Record<string, { check: FieldCheck; shapes?: string[]; kept?: boolean }> = {
  fillColor: { check: isHexColour, kept: true },
  fillEnabled: { check: isBoolean },
  fillType: { check: oneOf('solid', 'linear') },
  gradientStartColor: { check: isHexColour },
  gradientEndColor: { check: isHexColour },
  gradientAngle: { check: within(-180, 180) },
  strokeColor: { check: isHexColour },
  strokeWidth: { check: within(0, 50) },
  strokeEnabled: { check: isBoolean },
  strokeLineCap: { check: oneOf('butt', 'round', 'square') },
  strokeLineJoin: { check: oneOf('miter', 'round', 'bevel') },
  strokeMiterLimit: { check: within(1, 20) },
  trimPathStart: { check: within(0, 100) },
  trimPathEnd: { check: within(0, 100) },
  trimPathOffset: { check: within(-360, 360) },
  taperStartWidth: { check: within(0, 200) },
  taperEndWidth: { check: within(0, 200) },
  taperStartLength: { check: within(0, 100) },
  taperEndLength: { check: within(0, 100) },
  cornerRadius: { check: within(0, 100), shapes: ['rectangle', 'triangle', 'star', 'polygon'] },
  direction: { check: oneOf('up', 'down', 'left', 'right'), shapes: ['triangle'] },
  points: { check: (value) => Number.isSafeInteger(value) && within(3, 12)(value), shapes: ['star', 'polygon'] },
  innerRadius: { check: within(0.1, 0.9), shapes: ['star'] },
  pathClosed: { check: isBoolean, shapes: ['path'], kept: true },
};

const pathProblem = (path: unknown, minimum: number): string | undefined => {
  if (!Array.isArray(path) || path.length < minimum || path.length > STUDIO_MASK_MAX_VERTICES) {
    return `a path must have ${minimum} to ${STUDIO_MASK_MAX_VERTICES} vertices`;
  }
  for (const vertex of path) {
    if (!isRecord(vertex) || Object.keys(vertex).some((name) => !VERTEX_FIELDS.has(name))) {
      return 'a path vertex must be { position, inHandle, outHandle, tangentMode? }';
    }
    if (!isPoint(vertex.position) || !isPoint(vertex.inHandle) || !isPoint(vertex.outHandle)) {
      return 'a path position or handle must be [x, y]';
    }
    if (vertex.tangentMode !== undefined && !TANGENT_MODES.has(vertex.tangentMode as string)) {
      return 'unknown path tangent mode';
    }
  }
  return undefined;
};

/** Section 17.5. `shapeType` is known for `shape.add`; `shape.setStyle` leaves that check to the engine. */
const shapeStyleProblem = (style: unknown, shapeType?: string): string | undefined => {
  if (!isRecord(style)) {
    return 'style must be an object';
  }
  for (const [name, value] of Object.entries(style)) {
    if (name === 'pathVertices') {
      if (shapeType !== undefined && shapeType !== 'path') {
        return 'style.pathVertices needs a path shape';
      }
      const problem = pathProblem(value, 2);
      if (problem) {
        return problem;
      }
      continue;
    }
    const field = Object.hasOwn(SHAPE_STYLE_FIELDS, name) ? SHAPE_STYLE_FIELDS[name] : undefined;
    if (!field) {
      return `unknown style field ${name}`;
    }
    if (shapeType !== undefined && field.shapes && !field.shapes.includes(shapeType)) {
      return `style.${name} does not apply to a ${shapeType} shape`;
    }
    if (value === null ? field.kept : !field.check(value)) {
      return `style.${name} is outside its type or range`;
    }
  }
  return undefined;
};

const SHAPE_BOX_FIELDS: Record<string, FieldCheck> = {
  x: within(-Number.MAX_VALUE, Number.MAX_VALUE),
  y: within(-Number.MAX_VALUE, Number.MAX_VALUE),
  width: (value) => within(0, Number.MAX_VALUE)(value) && (value as number) > 0,
  height: (value) => within(0, Number.MAX_VALUE)(value) && (value as number) > 0,
  rotation: within(0, 360),
  opacity: within(0, 1),
  aspectRatioLocked: isBoolean,
};

const closedObjectProblem = (
  what: string,
  value: unknown,
  fields: Record<string, FieldCheck>,
  required = false,
): string | undefined => {
  if (!isRecord(value)) {
    return `${what} must be an object`;
  }
  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(fields, name)) {
      return `unknown ${what} field ${name}`;
    }
  }
  for (const [name, check] of Object.entries(fields)) {
    if (value[name] === undefined ? required : !check(value[name])) {
      return `${what}.${name} is outside its type or range`;
    }
  }
  return undefined;
};

/** A font family is a catalogue name, never a locator (section 14.3.4); the engine holds the catalogue. */
const isFontFamilyName: FieldCheck = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[/\\:]/.test(value);

const TITLE_STYLE_FIELDS: Record<string, { check: FieldCheck; kept?: boolean }> = {
  color: { check: isHexColour, kept: true },
  fontSize: { check: within(8, 500) },
  fontFamily: { check: isFontFamilyName },
  fontWeight: { check: oneOf('normal', 'medium', 'semibold', 'bold') },
  fontStyle: { check: oneOf('normal', 'italic') },
  underline: { check: isBoolean },
  lineHeight: { check: within(0.5, 3) },
  letterSpacing: { check: within(-20, 100) },
  textPadding: { check: within(0, 160) },
  backgroundColor: { check: isHexColour },
  backgroundRadius: { check: within(0, 999) },
  textStyleScale: { check: within(0.5, 6), kept: true },
};
const TITLE_STYLE_OBJECTS: Record<string, Record<string, FieldCheck>> = {
  textShadow: { offsetX: within(-100, 100), offsetY: within(-100, 100), blur: within(0, 160), color: isHexColour },
  stroke: { width: within(0, 24), color: isHexColour },
};
const TITLE_SPAN_FIELDS = new Set([
  'fontSize',
  'fontFamily',
  'fontWeight',
  'fontStyle',
  'underline',
  'color',
  'letterSpacing',
]);
export const STUDIO_TITLE_MAX_SPANS = 64;

/** Section 14.3.4: the closed `style`, `spans` and `spanLayout` of `title.setStyle`. */
const titleStyleProblem = (payload: Record<string, unknown>): string | undefined => {
  const { style, spans, spanLayout } = payload;
  if (!isRecord(style)) {
    return 'style must be an object';
  }
  for (const [name, value] of Object.entries(style)) {
    if (Object.hasOwn(TITLE_STYLE_OBJECTS, name)) {
      const problem =
        value === null ? undefined : closedObjectProblem(`style.${name}`, value, TITLE_STYLE_OBJECTS[name], true);
      if (problem) {
        return problem;
      }
      continue;
    }
    const field = Object.hasOwn(TITLE_STYLE_FIELDS, name) ? TITLE_STYLE_FIELDS[name] : undefined;
    if (!field) {
      return `unknown style field ${name}`;
    }
    if (value === null ? field.kept : !field.check(value)) {
      return `style.${name} is outside its type or range`;
    }
  }
  if (spans !== undefined && spans !== null) {
    if (!Array.isArray(spans) || spans.length === 0 || spans.length > STUDIO_TITLE_MAX_SPANS) {
      return `spans must be null or 1 to ${STUDIO_TITLE_MAX_SPANS} spans`;
    }
    for (const span of spans as Record<string, unknown>[]) {
      if (typeof span.text !== 'string') {
        return 'a span needs text';
      }
      for (const [name, value] of Object.entries(span)) {
        if (name !== 'text' && (!TITLE_SPAN_FIELDS.has(name) || !TITLE_STYLE_FIELDS[name].check(value))) {
          return `span ${name} is unknown or outside its type or range`;
        }
      }
    }
  }
  if (spanLayout !== undefined && spanLayout !== null && spanLayout !== 'stack' && spanLayout !== 'inline') {
    return 'spanLayout must be "stack", "inline" or null';
  }
  return undefined;
};

/** Section 17.4: everything of a `shape.add` that does not depend on the graph. */
const shapeAddProblem = (payload: Record<string, unknown>): string | undefined => {
  const shapeType = payload.shapeType as string;
  if (!STUDIO_SHAPE_TYPES.includes(shapeType)) {
    return 'shapeType is not a shape type';
  }
  for (const name of ['trackId', 'style', 'transform', 'mask']) {
    if (payload[name] === null) {
      return `${name} cannot be null`;
    }
  }
  if (payload.trackId === '') {
    return 'trackId must not be empty';
  }
  if (shapeType === 'path' && (!isRecord(payload.style) || payload.style.pathVertices === undefined)) {
    return 'a path needs style.pathVertices';
  }
  if (payload.mask !== undefined) {
    const mask = payload.mask as Record<string, unknown>;
    if (mask.path !== undefined) {
      return 'unknown mask field path';
    }
    const problem = maskProblem(mask);
    if (problem) {
      return problem;
    }
  }
  return (
    (payload.style === undefined ? undefined : shapeStyleProblem(payload.style, shapeType)) ??
    (payload.transform === undefined
      ? undefined
      : closedObjectProblem('transform', payload.transform, SHAPE_BOX_FIELDS))
  );
};

const CROP_FIELDS: Record<string, FieldCheck> = {
  left: within(0, 1),
  right: within(0, 1),
  top: within(0, 1),
  bottom: within(0, 1),
  softness: within(-1, 1),
};
const CORNERS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
const isPositive: FieldCheck = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Section 17.6: the closed `crop` and `cornerPin` of a `clip.setCrop`. */
const cropProblem = (payload: Record<string, unknown>): string | undefined => {
  const { crop, cornerPin } = payload;
  if (payload.clipId === '') {
    return 'clipId must not be empty';
  }
  if (crop === undefined && cornerPin === undefined) {
    return 'needs crop or cornerPin';
  }
  if (crop !== undefined && crop !== null) {
    const problem = closedObjectProblem('crop', crop, CROP_FIELDS);
    if (problem) {
      return problem;
    }
    const sides = crop as Record<string, number | undefined>;
    if ((sides.left ?? 0) + (sides.right ?? 0) > 0.999 || (sides.top ?? 0) + (sides.bottom ?? 0) > 0.999) {
      return 'opposite crop sides must leave part of the picture';
    }
  }
  if (cornerPin !== undefined && cornerPin !== null) {
    const pin = cornerPin as Record<string, unknown>;
    if (
      Object.keys(pin).some(
        (name) => !CORNERS.includes(name) && name !== 'referenceWidth' && name !== 'referenceHeight',
      )
    ) {
      return 'unknown cornerPin field';
    }
    if (CORNERS.some((corner) => !isPoint(pin[corner]))) {
      return 'a cornerPin corner must be [x, y]';
    }
    if (!isPositive(pin.referenceWidth) || !isPositive(pin.referenceHeight)) {
      return 'cornerPin needs a positive referenceWidth and referenceHeight';
    }
  }
  return undefined;
};

/** Section 13.9: the closed `ducking` of a `clip.setAudio`. */
const duckingProblem = (ducking: unknown): string | undefined => {
  const problem = closedObjectProblem('ducking', ducking, {
    duckOthersDb: (value) => value === undefined || within(-60, 0)(value),
    attackSec: within(0, 5),
    releaseSec: within(0, 5),
    targetTrackIds: (value) =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((id) => typeof id === 'string' && id.length > 0) &&
      new Set(value).size === value.length,
  });
  return (
    problem ??
    ((ducking as Record<string, unknown>).duckOthersDb === undefined ? 'ducking needs duckOthersDb' : undefined)
  );
};

/** Checks the catalogue's field kinds cannot express, for the commands whose payload is closed. */
const refinedPayloadProblem = (id: StudioCommandId, payload: Record<string, unknown>): string | undefined => {
  switch (id) {
    case 'clip.setMask': {
      if (!Object.hasOwn(payload, 'mask')) {
        return 'missing required field mask (null removes the mask)';
      }
      return payload.mask === null ? undefined : maskProblem(payload.mask as Record<string, unknown>);
    }
    case 'clip.relink': {
      return payload.clipId === '' || payload.assetId === '' ? 'clipId and assetId must not be empty' : undefined;
    }
    case 'clip.setCrop': {
      return cropProblem(payload);
    }
    case 'clip.setAudio': {
      return payload.ducking === undefined || payload.ducking === null ? undefined : duckingProblem(payload.ducking);
    }
    case 'shape.add': {
      return shapeAddProblem(payload);
    }
    case 'shape.setStyle': {
      return payload.clipId === '' ? 'clipId must not be empty' : shapeStyleProblem(payload.style);
    }
    case 'title.setStyle': {
      return payload.clipId === '' ? 'clipId must not be empty' : titleStyleProblem(payload);
    }
    default: {
      return undefined;
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
    // An optional field given as null clears what it names: no parent, no expression (FL-100).
    if (optional && present && payload[name] === null && type !== 'Array<{id:string,at:Rational,gainDb:number}>') {
      continue;
    }
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

  const problem = refinedPayloadProblem(id, payload);
  if (problem) {
    return { valid: false, detail: `${id}: ${problem}` };
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
 * a head later than the one this save builds on, a key used twice, or a command the catalogue does
 * not flag `mutatesGraph` (those never reach a revision). Only that catalogue flag is checked: the
 * server does not re-run the command, so it cannot tell whether it actually changed the graph. A
 * command issued against an earlier head is normal: edits made while the previous autosave was in
 * flight travel in the next one. The revision's summary is then counted from the envelopes rather
 * than trusted from the client.
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
