import type { AssetFaceResponseDto } from '@immich/sdk';
import {
  adjustFaceBox,
  boxFromPoints,
  checkPersonName,
  draftFromFace,
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
const detected = (id: string, personId = ''): DraftFace => ({ id, personId, box, detected: true });
const added = (id: string, personId = ''): DraftFace => ({ id, personId, box, detected: false });

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
      person: { id: 'person-1' },
    } as AssetFaceResponseDto;
    const draft = draftFromFace(face);
    expect(draft).toEqual({
      id: 'face-1',
      personId: 'person-1',
      detected: true,
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

describe('face tag save planning', () => {
  it('turns the draft into deletes, reassigns and creates', () => {
    const baseline = [detected('a', 'p1'), detected('b', 'p2'), detected('c')];
    const draft = [detected('a', 'p3'), detected('c'), added('n1', 'new-1'), added('n2', 'p1')];
    const plan = planFaceTagSave(baseline, draft, [
      { id: 'new-1', name: 'Nova' },
      { id: 'new-2', name: 'Unused' },
    ]);
    expect(plan).toEqual({
      deletes: ['b'],
      reassigns: [{ faceId: 'a', personId: 'p3' }],
      creates: [
        { faceId: 'n1', personId: 'new-1', box },
        { faceId: 'n2', personId: 'p1', box },
      ],
      newPeople: [{ id: 'new-1', name: 'Nova' }],
    });
    expect(hasFaceTagChanges(plan)).toBe(true);
    expect(hasFaceTagChanges(planFaceTagSave(baseline, baseline, []))).toBe(false);
  });

  it('lets a detected face stay unassigned but needs a known person on every new region', () => {
    const known = new Set(['p1']);
    expect(isDraftSavable([detected('a'), added('n', 'p1')], known)).toBe(true);
    expect(isDraftSavable([added('n')], known)).toBe(false);
    expect(isDraftSavable([detected('a', 'gone')], known)).toBe(false);
  });

  it('re-applies only the failed changes on top of what the server now holds', () => {
    const draft = [detected('a', 'new-1'), added('n1', 'new-1'), added('n2', 'p1')];
    const server = [detected('a', 'p1'), detected('b', 'p2'), detected('saved', 'p1')];
    const rebased = rebaseAfterPartialSave(
      server,
      draft,
      { deletes: new Set(['b']), reassigns: new Set(['a']), creates: new Set(['n1']) },
      new Map([['new-1', 'real-1']]),
    );
    expect(rebased).toEqual([detected('a', 'real-1'), detected('saved', 'p1'), added('n1', 'real-1')]);
  });

  it('projects the saved state from the baseline when the server cannot be re-read', () => {
    const baseline = [detected('a', 'p1'), detected('b', 'p2'), detected('c', 'p2')];
    const plan = planFaceTagSave(baseline, [detected('a', 'new-1'), detected('c', 'p1')], [{ id: 'new-1', name: 'N' }]);
    expect(
      projectSavedFaces(baseline, plan, { deletes: new Set(), reassigns: new Set(['c']) }, new Map([['new-1', 'r1']])),
    ).toEqual([detected('a', 'r1'), detected('c', 'p2')]);
  });
});
