import { AssetAnnotationKind, AssetAnnotationOrigin, type AssetAnnotationItem } from '@frameleaf/sdk';
import {
  annotationLabelValues,
  commit,
  createAnnotation,
  history,
  keyboardAnnotation,
  keyChange,
  nudge,
  resize,
  toStored,
  undo,
} from '$lib/frameleaf/boards-annotations';

const rect: AssetAnnotationItem = {
  id: 'a1',
  kind: AssetAnnotationKind.Rect,
  geometry: { x: 0.045, y: 0.27, width: 0.45, height: 0.2 },
  note: 'Headline runs to three lines on a phone.',
};
const arrow: AssetAnnotationItem = {
  id: 'a2',
  kind: AssetAnnotationKind.Arrow,
  geometry: { x: 0.36, y: 0.66, endX: 0.2, endY: 0.56 },
};
const text: AssetAnnotationItem = {
  id: 'a3',
  kind: AssetAnnotationKind.Text,
  geometry: { x: 0.44, y: 0.93 },
  text: 'v2 · check with Jamie',
  note: '',
};

describe('Boards annotation geometry', () => {
  it('moves an annotation by a step and never off the picture', () => {
    expect(nudge(rect, 0.01, 0).geometry.x).toBeCloseTo(0.055);
    expect(nudge(rect, 1, 1).geometry).toMatchObject({ x: 0.55, y: 0.8 });
    expect(nudge(rect, -1, -1).geometry).toMatchObject({ x: 0, y: 0 });
    // an arrow moves as a whole, its far end stopping at the edge
    expect(nudge(arrow, -1, 0).geometry).toMatchObject({ x: 0.16, endX: 0 });
  });

  it('resizes a rectangle, turns an arrow and leaves text alone', () => {
    expect(resize(rect, 0.05, 0.05).geometry).toMatchObject({ width: 0.5, height: 0.25 });
    expect(resize(rect, -1, -1).geometry).toMatchObject({ width: 0.02, height: 0.02 });
    expect(resize(rect, 1, 1).geometry).toMatchObject({ width: 0.955, height: 0.73 });
    expect(resize(arrow, 0.01, 0).geometry).toMatchObject({ x: 0.36, endX: 0.21 });
    expect(resize(text, 0.1, 0.1)).toBe(text);
  });

  it('reads arrow keys the way the prototype describes', () => {
    expect(keyChange(rect, { key: 'ArrowRight', shiftKey: false, altKey: false })?.geometry.x).toBeCloseTo(0.055);
    expect(keyChange(rect, { key: 'ArrowDown', shiftKey: true, altKey: false })?.geometry.y).toBeCloseTo(0.32);
    expect(keyChange(rect, { key: 'ArrowRight', shiftKey: false, altKey: true })?.geometry.width).toBeCloseTo(0.46);
    expect(keyChange(rect, { key: 'a', shiftKey: false, altKey: false })).toBeNull();
  });

  it('makes shapes from a drag, a click and the keyboard', () => {
    const dragged = createAnnotation(AssetAnnotationKind.Rect, { x: 0.6, y: 0.5 }, { x: 0.2, y: 0.1 }, 'n1');
    expect(dragged.geometry).toEqual({ x: 0.2, y: 0.1, width: 0.4, height: 0.4 });
    // a click without a drag still gives a usable rectangle that fits the picture
    expect(createAnnotation(AssetAnnotationKind.Rect, { x: 0.95, y: 0.95 }, null, 'n2').geometry).toEqual({
      x: 0.8,
      y: 0.86,
      width: 0.2,
      height: 0.14,
    });
    expect(createAnnotation(AssetAnnotationKind.Arrow, { x: 0.5, y: 0.5 }, null, 'n3').geometry).toEqual({
      x: 0.5,
      y: 0.5,
      endX: 0.38,
      endY: 0.42,
    });
    expect(keyboardAnnotation(AssetAnnotationKind.Rect, 'n4').geometry).toEqual({
      x: 0.4,
      y: 0.4,
      width: 0.2,
      height: 0.16,
    });
    expect(keyboardAnnotation(AssetAnnotationKind.Text, 'n5', 'Text')).toMatchObject({ text: 'Text' });
  });

  it('undoes one change at a time', () => {
    let state = history([rect]);
    state = commit(state, [rect, arrow]);
    state = commit(state, [arrow]);
    expect(undo(state).present).toEqual([rect, arrow]);
    expect(undo(undo(state)).present).toEqual([rect]);
    expect(undo(history([rect])).present).toEqual([rect]);
  });

  it('saves without blank notes and keeps text only on text annotations', () => {
    expect(toStored([text, { ...rect, text: 'stray' } as AssetAnnotationItem])).toEqual([
      { id: 'a3', kind: AssetAnnotationKind.Text, geometry: text.geometry, text: 'v2 · check with Jamie' },
      { id: 'a1', kind: AssetAnnotationKind.Rect, geometry: rect.geometry, note: rect.note },
    ]);
  });

  it('gives screen readers the number, kind, words, note and origin', () => {
    expect(annotationLabelValues(text, 2, 3)).toMatchObject({
      number: 3,
      total: 3,
      kind: 'text',
      hasText: 'yes',
      hasNote: 'no',
      fromEagle: 'no',
    });
    expect(annotationLabelValues({ ...rect, origin: AssetAnnotationOrigin.Eagle }, 0, 1)).toMatchObject({
      hasNote: 'yes',
      note: rect.note,
      fromEagle: 'yes',
    });
  });
});
