import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrBoundingBox } from '$lib/stores/ocr.svelte';
import type { Point } from '$lib/utils/container-utils';

let ocr: typeof import('$lib/utils/ocr-utils');

const box = (id: string, x: number, y: number, text = id): OcrBoundingBox => ({
  id,
  assetId: 'photo',
  x1: x,
  y1: y,
  x2: x + 0.1,
  y2: y,
  x3: x + 0.1,
  y3: y + 0.4,
  x4: x,
  y4: y + 0.4,
  boxScore: 0.8,
  textScore: 0.9,
  text,
});

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  ocr = await import('$lib/utils/ocr-utils');
});

afterEach(() => vi.restoreAllMocks());

describe('OCR reading order', () => {
  const a = box('a', 0.03, 0);
  const b = box('b', 0.02, 0.01);
  const c = box('c', 0.01, 0.02);

  it.each([
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ])('orders a nearby row consistently for input %#', (...input) => {
    expect(ocr.getOcrBoundingBoxes(input, { width: 100, height: 100 }).map((entry) => entry.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('keeps tied regions in source order without changing source coordinates or text', () => {
    const first = Object.freeze(box('first', 0.1, 0.2, '  original text  '));
    const second = Object.freeze(box('second', 0.1, 0.2, 'second'));
    const input = [first, second];
    const result = ocr.getOcrBoundingBoxes(input, { width: 1000, height: 500 });
    expect(result.map((entry) => entry.id)).toEqual(['first', 'second']);
    expect(result[0]).toMatchObject({ text: '  original text  ', confidence: 0.9, verticalMode: 'rotated' });
    expect(result[0].points[0]).toEqual({ x: 100, y: 100 });
    result[0].points[0].x = 0;
    expect(first.x1).toBe(0.1);
    expect(input).toEqual([first, second]);
  });
});

describe('OCR text sizing', () => {
  it.each(['字', 'あ', 'カ', '한', '𠮷', 'ー', '（'])('recognizes vertical CJK text %s', (text) => {
    const [result] = ocr.getOcrBoundingBoxes([box('vertical', 0, 0, text)], { width: 100, height: 100 });
    expect(result.verticalMode).toBe('cjk');
  });

  it('rotates tall Latin text and leaves wide text horizontal', () => {
    const [tall] = ocr.getOcrBoundingBoxes([box('vertical', 0, 0, 'hello')], { width: 100, height: 100 });
    const [wide] = ocr.getOcrBoundingBoxes([box('horizontal', 0, 0, '字')], { width: 1000, height: 100 });
    expect(tall.verticalMode).toBe('rotated');
    expect(wide.verticalMode).toBe('none');
  });

  it('counts supplementary CJK characters once when a canvas is unavailable', () => {
    expect(ocr.calculateFittedFontSize('𠮷𠮷', 100, 156, 'cjk')).toBe(68);
  });

  it('keeps horizontal and rotated fallback sizing within the existing font limits', () => {
    expect(ocr.calculateFittedFontSize('hello', 120, 40, 'none')).toBe(28);
    expect(ocr.calculateFittedFontSize('hello', 40, 120, 'rotated')).toBe(28);
    expect(ocr.calculateFittedFontSize('hello', 5, 5, 'none')).toBe(8);
    expect(ocr.calculateFittedFontSize('', 120, 40, 'none')).toBe(96);
  });

  it('uses measured glyph advances for CJK and measured bounds for horizontal text', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      font: '',
      measureText: (text: string) => ({
        width: text === 'hello' ? 200 : 100,
        actualBoundingBoxAscent: 80,
        actualBoundingBoxDescent: 20,
      }),
    } as unknown as CanvasRenderingContext2D);
    expect(ocr.calculateFittedFontSize('𠮷𠮷', 100, 156, 'cjk')).toBe(68);
    expect(ocr.calculateFittedFontSize('hello', 200, 100, 'none')).toBe(88);
  });
});

describe('OCR quadrilateral transforms', () => {
  it.each([
    {
      points: [
        { x: 10, y: 20 },
        { x: 40, y: 20 },
        { x: 40, y: 60 },
        { x: 10, y: 60 },
      ],
      width: 30,
      height: 40,
    },
    {
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: -20, y: 10 },
        { x: -20, y: 0 },
      ],
      width: 10,
      height: 20,
    },
    {
      points: [
        { x: 10, y: 20 },
        { x: 110, y: 25 },
        { x: 120, y: 100 },
        { x: 5, y: 90 },
      ],
      width: 115.43396380615195,
      height: 75.66372975210778,
    },
  ])('maps each source corner onto its image corner for fixture %#', ({ points, width, height }) => {
    const source = points.map((point) => Object.freeze(point));
    const transformed = ocr.calculateBoundingBoxMatrix(source);
    expect(transformed.width).toBeCloseTo(width, 9);
    expect(transformed.height).toBeCloseTo(height, 9);
    const corners: Point[] = [
      { x: 0, y: 0 },
      { x: transformed.width, y: 0 },
      { x: transformed.width, y: transformed.height },
      { x: 0, y: transformed.height },
    ];
    const m = transformed.matrix;
    for (const [index, point] of corners.entries()) {
      const w = m[3] * point.x + m[7] * point.y + m[15];
      expect((m[0] * point.x + m[4] * point.y + m[12]) / w).toBeCloseTo(points[index].x, 9);
      expect((m[1] * point.x + m[5] * point.y + m[13]) / w).toBeCloseTo(points[index].y, 9);
    }
  });

  it('collapses a zero-area region without emitting NaN or Infinity to CSS', () => {
    const result = ocr.calculateBoundingBoxMatrix(Array.from({ length: 4 }, () => ({ x: 5, y: 5 })));
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    expect(result.matrix.every((value) => Number.isFinite(value))).toBe(true);
    expect(result.matrix[0]).toBe(0);
    expect(result.matrix[5]).toBe(0);
  });
});
