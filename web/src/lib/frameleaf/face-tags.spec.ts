import { SourceType, type AssetFaceResponseDto } from '@immich/sdk';
import {
  adjustFaceBox,
  boxFromPoints,
  checkPersonName,
  draftFromFace,
  faceProvenance,
  hasFaceTagChanges,
  imageContentRect,
  imagePoint,
  isDraftSavable,
  keyboardFaceBox,
  moveFaceBox,
  planFaceTagSave,
  projectSavedFaces,
  pushHistory,
  rebaseAfterPartialSave,
  toPercent,
  toPixelBox,
  type DraftFace,
} from './face-tags';

const box = { x: 0.2, y: 0.2, width: 0.2, height: 0.2 };
const detected = (id: string, personId = '', revision = `r-${id}`): DraftFace => ({
  id,
  personId,
  box,
  stored: true,
  provenance: 'detected',
  revision,
});
const added = (id: string, personId = ''): DraftFace => ({ id, personId, box, stored: false, provenance: 'manual' });

describe('face tag geometry', () => {
  it('letterboxes the image inside the stage', () => {
    expect(imageContentRect({ width: 400, height: 400 }, { width: 800, height: 400 })).toEqual({
      left: 0,
      top: 100,
      width: 400,
      height: 200,
    });
    expect(imageContentRect({ width: 0, height: 400 }, { width: 800, height: 400 })).toBeNull();
    expect(imageContentRect({ width: 400, height: 400 }, null)).toBeNull();
  });

  it('maps a pointer to image fractions, rejecting the margins unless clamped', () => {
    const content = { left: 0, top: 100, width: 400, height: 200 };
    const stage = { left: 10, top: 10 };
    expect(imagePoint(210, 210, stage, content)).toEqual({ x: 0.5, y: 0.5 });
    expect(imagePoint(210, 50, stage, content)).toBeNull();
    expect(imagePoint(210, 50, stage, content, { clampToImage: true })).toEqual({ x: 0.5, y: 0 });
    expect(imagePoint(0, 0, stage, null)).toBeNull();
  });

  it('draws a box from two corners in either order and drops a click-sized one', () => {
    expect(boxFromPoints({ x: 0.6, y: 0.5 }, { x: 0.2, y: 0.1 })).toEqual({ x: 0.2, y: 0.1, width: 0.4, height: 0.4 });
    expect(boxFromPoints({ x: 0.2, y: 0.2 }, { x: 0.201, y: 0.3 })).toBeNull();
    expect(boxFromPoints(null, { x: 0.2, y: 0.2 })).toBeNull();
  });

  it('keeps an adjusted box inside the image and above the minimum size', () => {
    expect(adjustFaceBox(box, 'x', 0.95)).toEqual({ ...box, x: 0.8 });
    expect(adjustFaceBox(box, 'width', 0)).toEqual({ ...box, width: 0.005 });
    expect(adjustFaceBox(box, 'height', NaN)).toBe(box);
    expect(moveFaceBox(box, -1, 1)).toEqual({ ...box, x: 0, y: 0.8 });
  });

  it('moves with arrows, resizes with Alt and steps further with Shift', () => {
    expect(keyboardFaceBox(box, 'ArrowRight')).toEqual({ ...box, x: 0.205 });
    expect(keyboardFaceBox(box, 'ArrowUp', { shiftKey: true })).toEqual({ ...box, y: 0.18 });
    expect(keyboardFaceBox(box, 'ArrowDown', { altKey: true })).toEqual({ ...box, height: 0.205 });
    expect(keyboardFaceBox(box, 'ArrowLeft', { altKey: true, shiftKey: true })).toEqual({ ...box, width: 0.18 });
    expect(keyboardFaceBox(box, 'Enter')).toBeNull();
  });

  it('shows fractions as one-decimal percentages', () => {
    expect(toPercent(0.1234)).toBe(12.3);
  });

  it('converts between server pixel boxes and fractions', () => {
    const face = {
      id: 'face-1',
      imageWidth: 1000,
      imageHeight: 500,
      boundingBoxX1: 100,
      boundingBoxY1: 50,
      boundingBoxX2: 300,
      boundingBoxY2: 250,
      revision: 'rev-1',
      correctedAt: null,
      hiddenAt: null,
      sourceType: SourceType.MachineLearning,
      person: { id: 'person-1' },
    } as AssetFaceResponseDto;
    const draft = draftFromFace(face);
    expect(draft).toEqual({
      id: 'face-1',
      personId: 'person-1',
      stored: true,
      provenance: 'detected',
      revision: 'rev-1',
      box: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 },
    });
    expect(draftFromFace({ ...face, person: null }).personId).toBe('');
    expect(toPixelBox(draft.box, { width: 2000, height: 1000 })).toEqual({ x: 200, y: 100, width: 400, height: 400 });
    expect(toPixelBox({ x: 1, y: 1, width: 0.5, height: 0.5 }, { width: 10, height: 10 })).toEqual({
      x: 9,
      y: 9,
      width: 1,
      height: 1,
    });
  });

  it('keeps only the most recent 30 history entries', () => {
    let history: number[] = [];
    for (let index = 0; index < 35; index++) {
      history = pushHistory(history, index);
    }
    expect(history).toHaveLength(30);
    expect(history[0]).toBe(5);
    expect(history.at(-1)).toBe(34);
  });

  it('checks a new person name like the prototype', () => {
    const people = [{ name: 'Alex' }];
    expect(checkPersonName('  Bailey ', people)).toEqual({ name: 'Bailey' });
    expect(checkPersonName(' '.repeat(3), people)).toEqual({ problem: 'invalid' });
    expect(checkPersonName('x'.repeat(121), people)).toEqual({ problem: 'invalid' });
    expect(checkPersonName('a\u{7}b', people)).toEqual({ problem: 'invalid' });
    expect(checkPersonName(' alex', people)).toEqual({ problem: 'duplicate' });
  });
});

describe('face provenance', () => {
  it('tells detected, manual and corrected faces apart', () => {
    expect(faceProvenance({ sourceType: SourceType.MachineLearning, correctedAt: null })).toBe('detected');
    expect(faceProvenance({ sourceType: SourceType.Manual, correctedAt: null })).toBe('manual');
    expect(faceProvenance({ sourceType: SourceType.MachineLearning, correctedAt: '2026-09-25T00:00:00Z' })).toBe(
      'corrected',
    );
    expect(faceProvenance({ sourceType: undefined, correctedAt: null })).toBe('detected');
  });
});

describe('face tag geometry across orientation and edits', () => {
  // The server answers in the displayed (upright, edited) image; a 1500x2000 view of a rotated,
  // cropped original, drawn on a 750x1000 preview, keeps its place as fractions of either size.
  const face = {
    id: 'f',
    imageWidth: 1500,
    imageHeight: 2000,
    boundingBoxX1: 200,
    boundingBoxY1: 400,
    boundingBoxX2: 300,
    boundingBoxY2: 600,
    revision: 'r',
    correctedAt: null,
    hiddenAt: null,
    person: null,
  } as AssetFaceResponseDto;

  it('round-trips a server box through fractions and the preview size the tagger loaded', () => {
    const draft = draftFromFace(face);
    expect(draft.box).toEqual({ x: 0.133333, y: 0.2, width: 0.066667, height: 0.1 });
    expect(toPixelBox(draft.box, { width: 750, height: 1000 })).toEqual({ x: 100, y: 200, width: 50, height: 100 });
    expect(toPixelBox(draft.box, { width: 1500, height: 2000 })).toEqual({ x: 200, y: 400, width: 100, height: 200 });
  });

  it('keeps a landscape face on a portrait (rotated) display inside the image', () => {
    const edge = draftFromFace({ ...face, boundingBoxX1: 1400, boundingBoxX2: 1600 });
    expect(edge.box.x + edge.box.width).toBeLessThanOrEqual(1);
    expect(
      toPixelBox(edge.box, { width: 750, height: 1000 }).x + toPixelBox(edge.box, { width: 750, height: 1000 }).width,
    ).toBeLessThanOrEqual(750);
  });
});

describe('face tag save planning', () => {
  it('turns the draft into revision-checked deletes, updates and creates', () => {
    const moved = { x: 0.3, y: 0.3, width: 0.2, height: 0.2 };
    const baseline = [
      detected('a', 'p1'),
      detected('b', 'p2'),
      detected('c'),
      detected('d', 'p4'),
      detected('e', 'p5'),
    ];
    const draft = [
      detected('a', 'p3'),
      detected('c'),
      { ...detected('d', ''), box: moved },
      { ...detected('e', 'p5'), box: moved },
      added('n1', 'new-1'),
      added('n2', 'p1'),
    ];
    const plan = planFaceTagSave(baseline, draft, [
      { id: 'new-1', name: 'Nova' },
      { id: 'new-2', name: 'Unused' },
    ]);
    expect(plan).toEqual({
      deletes: [{ faceId: 'b', revision: 'r-b' }],
      updates: [
        { faceId: 'a', revision: 'r-a', personId: 'p3' },
        { faceId: 'd', revision: 'r-d', personId: null, box: moved },
        { faceId: 'e', revision: 'r-e', box: moved },
      ],
      creates: [
        { faceId: 'n1', personId: 'new-1', box },
        { faceId: 'n2', personId: 'p1', box },
      ],
      newPeople: [{ id: 'new-1', name: 'Nova' }],
    });
    expect(hasFaceTagChanges(plan)).toBe(true);
    expect(hasFaceTagChanges(planFaceTagSave(baseline, baseline, []))).toBe(false);
  });

  it('lets a stored face stay or become unassigned but needs a known person on every new region', () => {
    const known = new Set(['p1']);
    expect(isDraftSavable([detected('a'), added('n', 'p1')], known)).toBe(true);
    expect(isDraftSavable([added('n')], known)).toBe(false);
    expect(isDraftSavable([detected('a', 'gone')], known)).toBe(false);
  });

  it('re-applies only the failed changes on top of what the server now holds', () => {
    const moved = { x: 0.5, y: 0.5, width: 0.1, height: 0.1 };
    const draft = [{ ...detected('a', 'new-1'), box: moved }, added('n1', 'new-1'), added('n2', 'p1')];
    const server = [detected('a', 'p1', 'r2'), detected('b', 'p2'), detected('saved', 'p1')];
    const rebased = rebaseAfterPartialSave(
      server,
      draft,
      { deletes: new Set(['b']), updates: new Set(['a']), creates: new Set(['n1']) },
      new Map([['new-1', 'real-1']]),
    );
    expect(rebased).toEqual([
      { ...detected('a', 'real-1', 'r2'), box: moved },
      detected('saved', 'p1'),
      added('n1', 'real-1'),
    ]);
  });

  it('projects the saved state from the baseline when the server cannot be re-read', () => {
    const baseline = [detected('a', 'p1'), detected('b', 'p2'), detected('c', 'p2')];
    const plan = planFaceTagSave(baseline, [detected('a', 'new-1'), detected('c', 'p1')], [{ id: 'new-1', name: 'N' }]);
    expect(
      projectSavedFaces(baseline, plan, { deletes: new Set(), updates: new Set(['c']) }, new Map([['new-1', 'r1']])),
    ).toEqual([{ ...detected('a', 'r1', 'r-a'), provenance: 'corrected' }, detected('c', 'p2')]);
  });
});
