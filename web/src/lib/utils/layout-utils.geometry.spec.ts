import { JustifiedLayout } from '@frameleaf/justified-layout-wasm';
import { filledJustifiedLayout } from '$lib/frameleaf/justified-rows';
import { assetFactory, timelineAssetFactory } from '@test-data/factories/asset-factory';
import { justifiedLayout, type CommonJustifiedLayout, type CommonLayoutOptions } from './layout-utils';

const options: CommonLayoutOptions = { rowHeight: 100, rowWidth: 450, spacing: 10, heightTolerance: 0.5 };
const squares = () => Array.from({ length: 5 }, () => timelineAssetFactory.build({ ratio: 1 }));
const positions = (layout: CommonJustifiedLayout, count: number) =>
  Array.from({ length: count }, (_, index) => layout.getPosition(index));

it.each([
  [0, 4, 105],
  [0.1, 4, 105],
  [0.25, 4, 105],
  [0.5, 3, 430 / 3],
  [1, 1, 200],
])('honors JavaScript row-height tolerance %s', (heightTolerance, firstRowCount, firstRowHeight) => {
  const layout = justifiedLayout(squares(), { ...options, heightTolerance });
  expect(positions(layout, 5).filter((box) => box.top === 0)).toHaveLength(firstRowCount);
  expect(layout.getHeight(0)).toBeCloseTo(firstRowHeight);
});

it('exposes consistent positions, dimensions and row spacing through the adapter', () => {
  const layout = justifiedLayout(squares(), options);
  const boxes = positions(layout, 5);
  expect(layout.containerWidth).toBeCloseTo(450);
  expect(layout.containerHeight).toBeCloseTo(2 * (430 / 3) + 10);
  for (const [index, box] of boxes.entries()) {
    expect(layout.getTop(index)).toBe(box.top);
    expect(layout.getLeft(index)).toBe(box.left);
    expect(layout.getWidth(index)).toBe(box.width);
    expect(layout.getHeight(index)).toBe(box.height);
  }
  expect(boxes[3].top - boxes[0].height).toBeCloseTo(10);
  expect(boxes[1].left - boxes[0].width).toBeCloseTo(10);
});

it('keeps empty layouts empty and does not fabricate an out-of-range position', () => {
  const layout = justifiedLayout([], options);
  expect(layout.containerWidth).toBe(0);
  expect(layout.containerHeight).toBe(0);
  expect(layout.getWidth(0)).toBeUndefined();
  expect(() => layout.getPosition(0)).toThrow();
});

it.each([
  { width: null, height: 100 },
  { width: 100, height: null },
  { width: 0, height: 100 },
])('uses a square for DTOs without usable dimensions: %o', (dimensions) => {
  const layout = justifiedLayout([assetFactory.build(dimensions)], options);
  expect(layout.getWidth(0)).toBe(layout.getHeight(0));
});

it('reads timeline ratios and DTO dimensions without changing input order or values', () => {
  const assets = Object.freeze([
    Object.freeze(timelineAssetFactory.build({ ratio: 2 })),
    Object.freeze(assetFactory.build({ width: 100, height: 200 })),
  ]);
  const before = structuredClone(assets);
  const layout = justifiedLayout([...assets], options);
  expect(layout.getWidth(0) / layout.getHeight(0)).toBeCloseTo(2);
  expect(layout.getWidth(1) / layout.getHeight(1)).toBeCloseTo(0.5);
  expect(assets).toEqual(before);
});

it('retains the layout library error for an invalid ratio', () => {
  expect(() => justifiedLayout([timelineAssetFactory.build({ ratio: NaN })], options)).toThrow('invalid aspect ratio');
});

describe.each([false, true])('layout dispatch with WASM=%s', (wasm) => {
  const previous = localStorage.getItem('LAYOUT.WASM');
  let dispatch: typeof import('./layout-utils').getJustifiedLayoutFromAssets;

  beforeAll(async () => {
    localStorage.setItem('LAYOUT.WASM', String(wasm));
    vi.resetModules();
    dispatch = (await import('./layout-utils')).getJustifiedLayoutFromAssets;
  });

  afterAll(() => {
    if (previous === null) {
      localStorage.removeItem('LAYOUT.WASM');
    } else {
      localStorage.setItem('LAYOUT.WASM', previous);
    }
    vi.resetModules();
  });

  it('passes timeline ratios and options to the selected backend', () => {
    const assets = squares();
    const layout = dispatch(assets, options);
    const expected = wasm
      ? new JustifiedLayout(new Float32Array(5).fill(1), options)
      : justifiedLayout(assets, options);
    expect(positions(layout, 5)).toEqual(positions(expected, 5));
    expect(layout.containerHeight).toBe(expected.containerHeight);
  });

  it('uses DTO dimensions and square fallback in the selected backend', () => {
    const assets = [assetFactory.build({ width: 200, height: 100 }), assetFactory.build({ width: null, height: null })];
    const layout = dispatch(assets, options);
    const expected = wasm ? new JustifiedLayout(new Float32Array([2, 1]), options) : justifiedLayout(assets, options);
    expect(positions(layout, 2)).toEqual(positions(expected, 2));
  });

  it('handles an empty asset list', () => {
    const layout = dispatch([], options);
    expect(layout.containerWidth).toBe(0);
    expect(layout.containerHeight).toBe(0);
  });

  it('prioritizes filling rows and captions over the backend setting', () => {
    const assets = squares();
    const filledOptions = { ...options, fillRowWidth: true, captionHeight: 20 };
    const layout = dispatch(assets, filledOptions);
    const expected = filledJustifiedLayout([1, 1, 1, 1, 1], filledOptions);
    expect(positions(layout, 5)).toEqual(positions(expected, 5));
    expect(layout.containerHeight).toBe(expected.containerHeight);
  });
});
