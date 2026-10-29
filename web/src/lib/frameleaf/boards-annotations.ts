/**
 * Boards annotations (FL-652, approved prototype `src/boards-annotations.mjs`): rectangles, arrows
 * and text drawn over a picture, each with a short note. They are kept with the item, never drawn
 * into the file. Positions are fractions of the picture (0..1), so they fit any preview size; the
 * prototype's percentages are the same numbers divided by 100.
 */
import { AssetAnnotationKind, type AssetAnnotationItem } from '@frameleaf/sdk';
import { mdiArrowTopRight, mdiCursorDefaultOutline, mdiFormatText, mdiRectangleOutline } from '@mdi/js';
import type { Translations } from 'svelte-i18n';

export type AnnotationTool = 'select' | AssetAnnotationKind;
export type Point = { x: number; y: number };

/** The toolbar: id, translation key, icon and the key that chooses it. */
export const ANNOTATION_TOOLS: {
  id: AnnotationTool;
  label: Translations;
  icon: string;
  key: string;
}[] = [
  { id: 'select', label: 'frameleaf_boards_annotate_choose', icon: mdiCursorDefaultOutline, key: 'V' },
  { id: AssetAnnotationKind.Rect, label: 'frameleaf_boards_annotate_rectangle', icon: mdiRectangleOutline, key: 'R' },
  { id: AssetAnnotationKind.Arrow, label: 'frameleaf_boards_annotate_arrow', icon: mdiArrowTopRight, key: 'A' },
  { id: AssetAnnotationKind.Text, label: 'frameleaf_boards_annotate_text', icon: mdiFormatText, key: 'T' },
];

export const ANNOTATION_ICON: Record<AssetAnnotationKind, string> = {
  [AssetAnnotationKind.Rect]: mdiRectangleOutline,
  [AssetAnnotationKind.Arrow]: mdiArrowTopRight,
  [AssetAnnotationKind.Text]: mdiFormatText,
};

/** One arrow-key step, and the Shift step: 1% and 5% of the picture. */
export const STEP = 0.01;
export const BIG_STEP = 0.05;
export const NOTE_MAX = 280;
export const TEXT_MAX = 200;

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
/** Four decimal places are finer than any screen pixel and keep the stored document small. */
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** Values for the screen-reader label `frameleaf_boards_annotation_label`. */
export const annotationLabelValues = (annotation: AssetAnnotationItem, index: number, total: number) => ({
  number: index + 1,
  total,
  kind: annotation.kind,
  hasText: annotation.kind === AssetAnnotationKind.Text && annotation.text ? 'yes' : 'no',
  text: annotation.text ?? '',
  hasNote: annotation.note ? 'yes' : 'no',
  note: annotation.note ?? '',
  fromEagle: annotation.origin === 'eagle' ? 'yes' : 'no',
});

/** Arrow keys move an annotation (Shift for bigger steps); it never leaves the picture. */
export function nudge(annotation: AssetAnnotationItem, dx: number, dy: number): AssetAnnotationItem {
  const g = annotation.geometry;
  if (annotation.kind === AssetAnnotationKind.Arrow) {
    const endX = g.endX ?? g.x;
    const endY = g.endY ?? g.y;
    const mx = clamp(dx, -Math.min(g.x, endX), 1 - Math.max(g.x, endX));
    const my = clamp(dy, -Math.min(g.y, endY), 1 - Math.max(g.y, endY));
    return {
      ...annotation,
      geometry: { x: round(g.x + mx), y: round(g.y + my), endX: round(endX + mx), endY: round(endY + my) },
    };
  }
  const width = g.width ?? 0;
  const height = g.height ?? 0;
  return {
    ...annotation,
    geometry: { ...g, x: round(clamp(g.x + dx, 0, 1 - width)), y: round(clamp(g.y + dy, 0, 1 - height)) },
  };
}

/** Alt + arrow keys resize: a rectangle's size, or where an arrow points. Text keeps its size. */
export function resize(annotation: AssetAnnotationItem, dw: number, dh: number): AssetAnnotationItem {
  const g = annotation.geometry;
  if (annotation.kind === AssetAnnotationKind.Arrow) {
    return {
      ...annotation,
      geometry: { ...g, endX: round(clamp((g.endX ?? g.x) + dw)), endY: round(clamp((g.endY ?? g.y) + dh)) },
    };
  }
  if (annotation.kind === AssetAnnotationKind.Rect) {
    return {
      ...annotation,
      geometry: {
        ...g,
        width: round(clamp((g.width ?? 0) + dw, 0.02, 1 - g.x)),
        height: round(clamp((g.height ?? 0) + dh, 0.02, 1 - g.y)),
      },
    };
  }
  return annotation;
}

/**
 * A new annotation from a drag (pointer) or from Enter (keyboard, placed in the middle). A click
 * without a drag still makes a usable rectangle or arrow.
 */
export function createAnnotation(
  kind: AssetAnnotationKind,
  from: Point,
  to: Point | null,
  id: string,
  defaultText = 'Text',
): AssetAnnotationItem {
  const a = { x: clamp(from.x), y: clamp(from.y) };
  if (kind === AssetAnnotationKind.Arrow) {
    // a click, or a drag too short to see, still gives an arrow you can see and then turn
    const dragged = !!to && Math.hypot(to.x - a.x, to.y - a.y) >= 0.02;
    const end = dragged ? to : { x: a.x - 0.12, y: a.y - 0.08 };
    return {
      id,
      kind,
      geometry: { x: round(a.x), y: round(a.y), endX: round(clamp(end.x)), endY: round(clamp(end.y)) },
      note: '',
    };
  }
  if (kind === AssetAnnotationKind.Text) {
    return { id, kind, geometry: { x: round(a.x), y: round(a.y) }, text: defaultText, note: '' };
  }
  const b = { x: clamp(to?.x ?? a.x), y: clamp(to?.y ?? a.y) };
  const dragged = Math.abs(b.x - a.x) >= 0.02 && Math.abs(b.y - a.y) >= 0.02;
  const x = dragged ? Math.min(a.x, b.x) : Math.min(a.x, 0.8);
  const y = dragged ? Math.min(a.y, b.y) : Math.min(a.y, 0.86);
  return {
    id,
    kind,
    geometry: {
      x: round(x),
      y: round(y),
      width: round(dragged ? Math.abs(b.x - a.x) : 0.2),
      height: round(dragged ? Math.abs(b.y - a.y) : 0.14),
    },
    note: '',
  };
}

/** Where Enter adds an annotation with the keyboard: in the middle of the picture. */
export const keyboardAnnotation = (kind: AssetAnnotationKind, id: string, defaultText?: string) =>
  createAnnotation(
    kind,
    { x: 0.4, y: 0.4 },
    kind === AssetAnnotationKind.Rect ? { x: 0.6, y: 0.56 } : null,
    id,
    defaultText,
  );

/** A short id, unique within the document. */
export const newAnnotationId = (taken: AssetAnnotationItem[]) => {
  const used = new Set(taken.map(({ id }) => id));
  for (let n = taken.length + 1; ; n++) {
    const id = `n${Date.now().toString(36)}${n}`;
    if (!used.has(id)) {
      return id;
    }
  }
};

/** The document the server stores: empty notes and text are left out rather than saved blank. */
export const toStored = (items: AssetAnnotationItem[]): AssetAnnotationItem[] =>
  items.map(({ note, text, ...item }) => ({
    ...item,
    ...(note && { note: note.slice(0, NOTE_MAX) }),
    ...(item.kind === AssetAnnotationKind.Text && text && { text: text.slice(0, TEXT_MAX) }),
  }));

/** Undo keeps the drawings as they were before each change. */
export type History = { past: AssetAnnotationItem[][]; present: AssetAnnotationItem[] };
export const history = (initial: AssetAnnotationItem[]): History => ({ past: [], present: initial });
export const commit = (state: History, next: AssetAnnotationItem[]): History => ({
  past: [...state.past, state.present],
  present: next,
});
export const undo = (state: History): History =>
  state.past.length > 0 ? { past: state.past.slice(0, -1), present: state.past.at(-1)! } : state;

/** The arrowhead at (x2, y2), drawn as a shape so it keeps its colour in every browser. */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const left = angle + Math.PI * 0.84;
  const right = angle - Math.PI * 0.84;
  return `${x2},${y2} ${x2 + size * Math.cos(left)},${y2 + size * Math.sin(left)} ${x2 + size * Math.cos(right)},${y2 + size * Math.sin(right)}`;
}

/** What an arrow key does to the chosen annotation, or null when the key isn't one of them. */
export function keyChange(
  annotation: AssetAnnotationItem,
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey'>,
): AssetAnnotationItem | null {
  const step = event.shiftKey ? BIG_STEP : STEP;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const move = moves[event.key];
  if (!move) {
    return null;
  }
  return event.altKey ? resize(annotation, move[0], move[1]) : nudge(annotation, move[0], move[1]);
}
