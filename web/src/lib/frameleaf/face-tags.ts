/**
 * FL-38 (V-28): the pure geometry and save planning behind the Frameleaf face tagger
 * (`components/frameleaf/FaceTagger.svelte`). The box math is ported from the September 22
 * prototype's `design/frameleaf/template/src/face-tags.mjs:420-497`; the prototype's
 * localStorage face-state model (`parseFaceState`, `saveAssetFaces`, …) is design evidence
 * only and is not reproduced — faces are saved through the real `/faces` and `/people`
 * endpoints instead.
 *
 * Boxes are fractions of the full image (0–1), so they are independent of how large the
 * preview is drawn and of which rendition (preview, thumbnail, original) was loaded.
 */
import type { AssetFaceResponseDto } from '@immich/sdk';

export type FaceBox = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type ContentRect = { left: number; top: number; width: number; height: number };

/**
 * One region in the tagger's draft. `detected` regions came from the server (face detection
 * or an earlier manual tag): the API has no endpoint to change an existing face's bounding
 * box, so their position is read-only and only their person or their presence can change.
 * `personId` is `''` while nobody is chosen.
 */
export type DraftFace = { id: string; personId: string; box: FaceBox; detected: boolean };
/** A person created inside the tagger; it only reaches the server when a face using it is saved. */
export type DraftPerson = { id: string; name: string };

/** face-tags.mjs:6-7 */
export const MIN_FACE_SIZE = 0.005;
export const MAX_FACES = 100;
/** FaceTagger.jsx:143 keeps the last 30 checkpoints. */
export const HISTORY_LIMIT = 30;
/** FaceTagger.jsx:263 */
export const MAX_PERSON_NAME = 120;
/** FaceTagger.jsx:152, the region Add face places. */
export const DEFAULT_FACE_BOX: FaceBox = { x: 0.35, y: 0.3, width: 0.2, height: 0.25 };

const FIELDS = ['x', 'y', 'width', 'height'] as const;
export type FaceBoxField = (typeof FIELDS)[number];

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** face-tags.mjs:37-54 */
export const validateFaceBox = (box: FaceBox | null | undefined): box is FaceBox =>
  !!box &&
  FIELDS.every((key) => typeof box[key] === 'number' && Number.isFinite(box[key])) &&
  box.x >= 0 &&
  box.y >= 0 &&
  box.width >= MIN_FACE_SIZE &&
  box.height >= MIN_FACE_SIZE &&
  box.x + box.width <= 1 + 1e-6 &&
  box.y + box.height <= 1 + 1e-6;

/** face-tags.mjs:420-439: where an `object-fit: contain` image sits inside its stage. */
export const imageContentRect = (viewport: Size | null, natural: Size | null): ContentRect | null => {
  if (
    !viewport ||
    !natural ||
    [viewport.width, viewport.height, natural.width, natural.height].some(
      (value) => !Number.isFinite(value) || value <= 0,
    )
  ) {
    return null;
  }
  const scale = Math.min(viewport.width / natural.width, viewport.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { left: (viewport.width - width) / 2, top: (viewport.height - height) / 2, width, height };
};

/** face-tags.mjs:440-456: a pointer position as a fraction of the image, or null outside it. */
export const imagePoint = (
  clientX: number,
  clientY: number,
  stageRect: { left: number; top: number },
  contentRect: ContentRect | null,
  { clampToImage = false } = {},
): Point | null => {
  if (!contentRect) {
    return null;
  }
  const x = (clientX - stageRect.left - contentRect.left) / contentRect.width;
  const y = (clientY - stageRect.top - contentRect.top) / contentRect.height;
  if ([x, y].some((value) => !Number.isFinite(value)) || (!clampToImage && (x < 0 || x > 1 || y < 0 || y > 1))) {
    return null;
  }
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
};

/** face-tags.mjs:457-466: the box a drag drew, or null when it is too small to be a face. */
export const boxFromPoints = (start: Point | null, end: Point | null): FaceBox | null => {
  if (!start || !end) {
    return null;
  }
  const box = {
    x: round(Math.min(start.x, end.x)),
    y: round(Math.min(start.y, end.y)),
    width: round(Math.abs(start.x - end.x)),
    height: round(Math.abs(start.y - end.y)),
  };
  return validateFaceBox(box) ? box : null;
};

/** face-tags.mjs:467-492: sets one field, kept inside the image and above the minimum size. */
export const adjustFaceBox = (box: FaceBox, field: FaceBoxField, value: number): FaceBox => {
  if (!validateFaceBox(box) || !FIELDS.includes(field) || !Number.isFinite(value)) {
    return box;
  }
  const max = {
    x: 1 - box.width,
    y: 1 - box.height,
    width: 1 - box.x,
    height: 1 - box.y,
  }[field];
  const min = field === 'width' || field === 'height' ? MIN_FACE_SIZE : 0;
  return { ...box, [field]: round(clamp(value, min, max)) };
};

/** face-tags.mjs:493-495 */
export const moveFaceBox = (box: FaceBox, dx: number, dy: number): FaceBox =>
  adjustFaceBox(adjustFaceBox(box, 'x', box.x + dx), 'y', box.y + dy);

/** FaceTagger.jsx:211-215: a resize drag or Alt+arrow grows the box from its top-left corner. */
export const resizeFaceBox = (box: FaceBox, width: number, height: number): FaceBox =>
  adjustFaceBox(adjustFaceBox(box, 'width', width), 'height', height);

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * FaceTagger.jsx:337-366: arrows move the selected region, Alt+arrows resize it and Shift
 * takes larger steps. Returns null for a key the tagger does not handle.
 */
export const keyboardFaceBox = (
  box: FaceBox,
  key: string,
  { shiftKey = false, altKey = false }: { shiftKey?: boolean; altKey?: boolean } = {},
): FaceBox | null => {
  const direction = ARROWS[key];
  if (!direction) {
    return null;
  }
  const amount = shiftKey ? 0.02 : 0.005;
  const [dx, dy] = [direction[0] * amount, direction[1] * amount];
  return altKey ? resizeFaceBox(box, box.width + dx, box.height + dy) : moveFaceBox(box, dx, dy);
};

/** FaceTagger.jsx:19: a fraction shown as a percentage with one decimal. */
export const toPercent = (value: number) => Math.round(value * 1000) / 10;

/** A server face as a draft region, its pixel box converted to fractions of its own image size. */
export const draftFromFace = (face: AssetFaceResponseDto): DraftFace => {
  const width = face.imageWidth || 1;
  const height = face.imageHeight || 1;
  const x = clamp(face.boundingBoxX1 / width, 0, 1);
  const y = clamp(face.boundingBoxY1 / height, 0, 1);
  return {
    id: face.id,
    personId: face.person?.id ?? '',
    detected: true,
    box: {
      x: round(x),
      y: round(y),
      width: round(clamp(face.boundingBoxX2 / width, 0, 1) - x),
      height: round(clamp(face.boundingBoxY2 / height, 0, 1) - y),
    },
  };
};

/** The integer pixel rectangle `createFace` expects, inside an image of `natural` size. */
export const toPixelBox = (box: FaceBox, natural: Size) => {
  const x = clamp(Math.round(box.x * natural.width), 0, natural.width - 1);
  const y = clamp(Math.round(box.y * natural.height), 0, natural.height - 1);
  return {
    x,
    y,
    width: clamp(Math.round(box.width * natural.width), 1, natural.width - x),
    height: clamp(Math.round(box.height * natural.height), 1, natural.height - y),
  };
};

/** FaceTagger.jsx:142-143: the history keeps the most recent checkpoints only. */
export const pushHistory = <T>(history: T[], entry: T, limit = HISTORY_LIMIT): T[] => [...history, entry].slice(-limit);

export type PersonNameProblem = 'invalid' | 'duplicate';

/** FaceTagger.jsx:262-277: a new person's name, or why it cannot be used. */
export const checkPersonName = (
  raw: string,
  existing: { name: string }[],
): { name: string; problem?: undefined } | { name?: undefined; problem: PersonNameProblem } => {
  const name = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > MAX_PERSON_NAME || /[\u{0}-\u{1F}]/u.test(name)) {
    return { problem: 'invalid' };
  }
  const lower = name.toLocaleLowerCase();
  if (existing.some((person) => person.name.trim().toLocaleLowerCase() === lower)) {
    return { problem: 'duplicate' };
  }
  return { name };
};

export type FaceTagPlan = {
  /** Detected faces the user removed; deleted permanently, as "Remove face" does. */
  deletes: string[];
  /** Detected faces moved to another person. */
  reassigns: { faceId: string; personId: string }[];
  /** New regions, with their fraction boxes. */
  creates: { faceId: string; personId: string; box: FaceBox }[];
  /** People created in the tagger that at least one saved face uses. */
  newPeople: DraftPerson[];
};

/** Turns the edited draft into the smallest set of server calls that applies it. */
export const planFaceTagSave = (baseline: DraftFace[], draft: DraftFace[], added: DraftPerson[]): FaceTagPlan => {
  const kept = new Map(draft.filter((face) => face.detected).map((face) => [face.id, face]));
  const deletes = baseline.filter((face) => !kept.has(face.id)).map((face) => face.id);
  const reassigns = baseline.flatMap((face) => {
    const next = kept.get(face.id);
    return next && next.personId && next.personId !== face.personId
      ? [{ faceId: face.id, personId: next.personId }]
      : [];
  });
  const creates = draft
    .filter((face) => !face.detected)
    .map((face) => ({ faceId: face.id, personId: face.personId, box: face.box }));
  const used = new Set([...reassigns, ...creates].map((change) => change.personId));
  return { deletes, reassigns, creates, newPeople: added.filter((person) => used.has(person.id)) };
};

export const hasFaceTagChanges = (plan: FaceTagPlan) =>
  plan.deletes.length + plan.reassigns.length + plan.creates.length > 0;

/**
 * FaceTagger.jsx:95-103: a save needs the image measured and a person on every new region.
 * A detected face that was never assigned may stay unassigned.
 */
export const isDraftSavable = (draft: DraftFace[], knownPersonIds: Set<string>) =>
  draft.every((face) => (face.personId ? knownPersonIds.has(face.personId) : face.detected));

/**
 * After a save that only partly landed: the new baseline is what the server now holds, and
 * the draft re-applies only the changes that failed, so a retry never repeats a change that
 * already succeeded. `personIds` maps in-tagger people that were created to their server ids.
 */
export const rebaseAfterPartialSave = (
  serverFaces: DraftFace[],
  draft: DraftFace[],
  failed: { deletes: Set<string>; reassigns: Set<string>; creates: Set<string> },
  personIds: Map<string, string>,
): DraftFace[] => {
  const resolve = (id: string) => personIds.get(id) ?? id;
  const wanted = new Map(draft.map((face) => [face.id, face]));
  const rebased = serverFaces
    .filter((face) => !failed.deletes.has(face.id))
    .map((face) => {
      const pending = failed.reassigns.has(face.id) ? wanted.get(face.id) : undefined;
      return pending ? { ...face, personId: resolve(pending.personId) } : face;
    });
  const retry = draft
    .filter((face) => !face.detected && failed.creates.has(face.id))
    .map((face) => ({ ...face, personId: resolve(face.personId) }));
  return [...rebased, ...retry];
};

/**
 * What the server should now hold when it cannot be re-read after a partial save: the old
 * baseline with the deletes and reassigns that succeeded applied. New faces that were created
 * are left out until the viewer re-reads them, since `createFace` does not return their ids.
 */
export const projectSavedFaces = (
  baseline: DraftFace[],
  plan: FaceTagPlan,
  failed: { deletes: Set<string>; reassigns: Set<string> },
  personIds: Map<string, string>,
): DraftFace[] => {
  const deleted = new Set(plan.deletes.filter((id) => !failed.deletes.has(id)));
  const moved = new Map(
    plan.reassigns
      .filter((change) => !failed.reassigns.has(change.faceId))
      .map((change) => [change.faceId, personIds.get(change.personId) ?? change.personId]),
  );
  return baseline
    .filter((face) => !deleted.has(face.id))
    .map((face) => (moved.has(face.id) ? { ...face, personId: moved.get(face.id)! } : face));
};
