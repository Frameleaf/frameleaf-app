import type { OcrBoundingBox } from '$lib/stores/ocr.svelte';
import type { Point, Size } from '$lib/utils/container-utils';

export type { Point } from '$lib/utils/container-utils';
export type VerticalMode = 'none' | 'cjk' | 'rotated';
export type OcrBox = {
  id: string;
  points: Point[];
  text: string;
  confidence: number;
  verticalMode: VerticalMode;
};

const CJK_PATTERN =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\u{3000}-\u{303F}\u{AC00}-\u{D7AF}\u{FF00}-\u{FFEF}]/u;
const VERTICAL_ASPECT_RATIO = 1.5;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const containsCjk = (text: string) => CJK_PATTERN.test(text);

const getVerticalMode = (width: number, height: number, text: string): VerticalMode =>
  height / width >= VERTICAL_ASPECT_RATIO ? (containsCjk(text) ? 'cjk' : 'rotated') : 'none';

/** Maps the four corners of a text rectangle to its image quadrilateral in CSS matrix3d order. */
export const calculateBoundingBoxMatrix = (points: Point[]): Size & { matrix: number[] } => {
  const [origin, right, opposite, bottom] = points;
  const width = Math.max(distance(origin, right), distance(bottom, opposite));
  const height = Math.max(distance(origin, bottom), distance(right, opposite));
  const rightX = right.x - opposite.x;
  const rightY = right.y - opposite.y;
  const bottomX = bottom.x - opposite.x;
  const bottomY = bottom.y - opposite.y;
  const determinant = rightX * bottomY - bottomX * rightY;

  if (!width || !height || !determinant || !Number.isFinite(determinant)) {
    return { width: 0, height: 0, matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, origin.x, origin.y, 0, 1] };
  }

  const skewX = origin.x - right.x + opposite.x - bottom.x;
  const skewY = origin.y - right.y + opposite.y - bottom.y;
  const perspectiveX = (skewX * bottomY - bottomX * skewY) / determinant;
  const perspectiveY = (rightX * skewY - skewX * rightY) / determinant;

  return {
    width,
    height,
    matrix: [
      ((1 + perspectiveX) * right.x - origin.x) / width,
      ((1 + perspectiveX) * right.y - origin.y) / width,
      0,
      perspectiveX / width,
      ((1 + perspectiveY) * bottom.x - origin.x) / height,
      ((1 + perspectiveY) * bottom.y - origin.y) / height,
      0,
      perspectiveY / height,
      0,
      0,
      1,
      0,
      origin.x,
      origin.y,
      0,
      1,
    ],
  };
};

const BORDER_SIZE = 4;
const HORIZONTAL_PADDING = 16 + BORDER_SIZE;
const VERTICAL_PADDING = 8 + BORDER_SIZE;
const REFERENCE_FONT_SIZE = 100;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 96;
const FALLBACK_FONT = `${REFERENCE_FONT_SIZE}px sans-serif`;
let sharedCanvasContext: CanvasRenderingContext2D | null = null;
let resolvedFont: string | undefined;

const getCanvasContext = (): CanvasRenderingContext2D | null => {
  sharedCanvasContext ??= document.createElement('canvas').getContext('2d');
  return sharedCanvasContext;
};

const getReferenceFont = (): string => {
  if (resolvedFont === undefined) {
    const family = globalThis.getComputedStyle?.(document.documentElement).getPropertyValue('--font-sans').trim();
    resolvedFont = family ? `${REFERENCE_FONT_SIZE}px ${family}` : FALLBACK_FONT;
  }
  return resolvedFont;
};

export const calculateFittedFontSize = (
  text: string,
  boxWidth: number,
  boxHeight: number,
  verticalMode: VerticalMode,
): number => {
  const vertical = verticalMode !== 'none';
  const width = boxWidth - (vertical ? VERTICAL_PADDING : HORIZONTAL_PADDING);
  const height = boxHeight - (vertical ? HORIZONTAL_PADDING : VERTICAL_PADDING);
  const fitWidth = verticalMode === 'rotated' ? height : width;
  const fitHeight = verticalMode === 'rotated' ? width : height;
  const context = getCanvasContext();
  let fitted: number;

  if (!context) {
    const characters = Array.from(text).length;
    fitted = verticalMode === 'cjk' ? Math.min(width, height / characters) : (1.4 * fitWidth) / characters;
  } else {
    context.font = getReferenceFont();
    let measuredWidth = 0;
    let measuredHeight = 0;
    if (verticalMode === 'cjk') {
      for (const character of text) {
        const metric = context.measureText(character);
        measuredWidth = Math.max(measuredWidth, metric.width);
        measuredHeight += Math.max(metric.width, metric.actualBoundingBoxAscent + metric.actualBoundingBoxDescent);
      }
    } else {
      const metric = context.measureText(text);
      measuredWidth = metric.width;
      measuredHeight = metric.actualBoundingBoxAscent + metric.actualBoundingBoxDescent;
    }
    fitted = Math.min(fitWidth / measuredWidth, fitHeight / measuredHeight) * REFERENCE_FONT_SIZE;
  }

  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fitted));
};

/** Own the display points; retain the server's text, identifiers and confidence without mutation. */
export const getOcrBoundingBoxes = (ocrData: OcrBoundingBox[], imageSize: Size): OcrBox[] => {
  const boxes: OcrBox[] = [];
  for (const region of ocrData) {
    const points = [
      { x: region.x1 * imageSize.width, y: region.y1 * imageSize.height },
      { x: region.x2 * imageSize.width, y: region.y2 * imageSize.height },
      { x: region.x3 * imageSize.width, y: region.y3 * imageSize.height },
      { x: region.x4 * imageSize.width, y: region.y4 * imageSize.height },
    ];
    const width = Math.max(distance(points[0], points[1]), distance(points[3], points[2]));
    const height = Math.max(distance(points[0], points[3]), distance(points[1], points[2]));
    boxes.push({
      id: region.id,
      points,
      text: region.text,
      confidence: region.textScore,
      verticalMode: getVerticalMode(width, height, region.text),
    });
  }

  boxes.sort((a, b) => a.points[0].y - b.points[0].y);
  const rowThreshold = imageSize.height * 0.02;
  for (let start = 0; start < boxes.length;) {
    let end = start + 1;
    const anchor = boxes[start].points[0].y;
    while (end < boxes.length && boxes[end].points[0].y - anchor < rowThreshold) {
      end++;
    }
    if (end - start > 1) {
      const row = boxes.slice(start, end).sort((a, b) => a.points[0].x - b.points[0].x);
      for (let offset = 0; offset < row.length; offset++) {
        boxes[start + offset] = row[offset];
      }
    }
    start = end;
  }
  return boxes;
};
