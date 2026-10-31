import { DURATION } from '$lib/frameleaf/tokens';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import type { TimelineMonth } from '$lib/managers/timeline-manager/timeline-month.svelte';

const environment = vi.hoisted(() => ({ browser: true }));
vi.mock('$app/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$app/env')>()),
  get browser() {
    return environment.browser;
  },
}));

beforeEach(() => {
  environment.browser = true;
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  environment.browser = true;
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
});

const numericKeys = [
  'TIMELINE_INTERSECTION_EXPAND_TOP',
  'TIMELINE_INTERSECTION_EXPAND_BOTTOM',
  'THUMBHASH_FADE_DURATION',
  'IMAGE_RASTER.MAX_PIXELS',
];

it('uses the existing defaults when browser overrides are absent', async () => {
  const { TUNABLES } = await import('./tunables');
  expect(TUNABLES).toEqual({
    LAYOUT: { WASM: true },
    TIMELINE: { INTERSECTION_EXPAND_TOP: 500, INTERSECTION_EXPAND_BOTTOM: 500 },
    ASSET_GRID: { NAVIGATE_ON_ASSET_IN_VIEW: false },
    IMAGE_THUMBNAIL: { THUMBHASH_FADE_DURATION: DURATION.base },
    IMAGE_RASTER: { MAX_PIXELS: 0 },
  });
});

it.each(['', '  ', 'not-a-number', 'NaN', 'Infinity', '9'.repeat(400)])(
  'falls back for invalid numeric storage %s',
  async (value) => {
    for (const key of numericKeys) {
      localStorage.setItem(key, value);
    }
    const { TUNABLES } = await import('./tunables');
    expect(TUNABLES.TIMELINE).toEqual({ INTERSECTION_EXPAND_TOP: 500, INTERSECTION_EXPAND_BOTTOM: 500 });
    expect(TUNABLES.IMAGE_THUMBNAIL.THUMBHASH_FADE_DURATION).toBe(DURATION.base);
    expect(TUNABLES.IMAGE_RASTER.MAX_PIXELS).toBe(0);
  },
);

it.each([
  { value: '42', expected: 42 },
  { value: '0', expected: 0 },
  { value: '-15', expected: -15 },
  { value: ' 32ms', expected: 32 },
  { value: '0x10', expected: 16 },
  { value: '+17', expected: 17 },
  { value: '7.9', expected: 7 },
  { value: '-0', expected: -0 },
])('retains integer parsing for $value', async ({ value, expected }) => {
  for (const key of numericKeys) {
    localStorage.setItem(key, value);
  }
  const { TUNABLES } = await import('./tunables');
  expect(TUNABLES.TIMELINE.INTERSECTION_EXPAND_TOP).toBe(expected);
  expect(TUNABLES.TIMELINE.INTERSECTION_EXPAND_BOTTOM).toBe(expected);
  expect(TUNABLES.IMAGE_THUMBNAIL.THUMBHASH_FADE_DURATION).toBe(expected);
  expect(TUNABLES.IMAGE_RASTER.MAX_PIXELS).toBe(expected);
});

it.each(['true', 'false', 'TRUE', ' true ', ''])('retains exact boolean override parsing for %s', async (value) => {
  localStorage.setItem('LAYOUT.WASM', value);
  localStorage.setItem('ASSET_GRID.NAVIGATE_ON_ASSET_IN_VIEW', value);
  const { TUNABLES } = await import('./tunables');
  expect(TUNABLES.LAYOUT.WASM).toBe(value === 'true');
  expect(TUNABLES.ASSET_GRID.NAVIGATE_ON_ASSET_IN_VIEW).toBe(value === 'true');
});

it('uses server-rendering defaults without reading browser storage', async () => {
  environment.browser = false;
  const read = vi.fn(() => {
    throw new Error('browser storage accessed');
  });
  vi.stubGlobal('localStorage', { getItem: read });
  const { TUNABLES } = await import('./tunables');
  expect(read).not.toHaveBeenCalled();
  expect(TUNABLES.LAYOUT.WASM).toBe(true);
  expect(TUNABLES.TIMELINE).toEqual({ INTERSECTION_EXPAND_TOP: 500, INTERSECTION_EXPAND_BOTTOM: 500 });
  expect(TUNABLES.IMAGE_THUMBNAIL.THUMBHASH_FADE_DURATION).toBe(DURATION.base);
  expect(TUNABLES.IMAGE_RASTER.MAX_PIXELS).toBe(0);
});

it('does not load far-away months when invalid margins were stored', async () => {
  localStorage.setItem('TIMELINE_INTERSECTION_EXPAND_TOP', 'invalid');
  localStorage.setItem('TIMELINE_INTERSECTION_EXPAND_BOTTOM', 'invalid');
  const { updateTimelineMonthViewportProximity, ViewportProximity } =
    await import('$lib/managers/timeline-manager/internal/intersection-support.svelte');
  const clearDeferredLayout = vi.fn();
  const manager = { visibleWindow: { top: 1000, bottom: 1200 }, clearDeferredLayout } as unknown as TimelineManager;
  const month = { top: 10_000, height: 100, viewportProximity: ViewportProximity.FarFromViewport } as TimelineMonth;
  updateTimelineMonthViewportProximity(manager, month);
  expect(month.viewportProximity).toBe(ViewportProximity.FarFromViewport);
  expect(clearDeferredLayout).not.toHaveBeenCalled();
});

it('retains the existing far-first classification for negative custom margins', async () => {
  localStorage.setItem('TIMELINE_INTERSECTION_EXPAND_TOP', '-200');
  localStorage.setItem('TIMELINE_INTERSECTION_EXPAND_BOTTOM', '-100');
  const { updateTimelineMonthViewportProximity, ViewportProximity } =
    await import('$lib/managers/timeline-manager/internal/intersection-support.svelte');
  const clearDeferredLayout = vi.fn();
  const manager = { visibleWindow: { top: 1000, bottom: 1200 }, clearDeferredLayout } as unknown as TimelineManager;
  const month = { top: 1050, height: 50, viewportProximity: ViewportProximity.InViewport } as TimelineMonth;
  updateTimelineMonthViewportProximity(manager, month);
  expect(month.viewportProximity).toBe(ViewportProximity.FarFromViewport);
  expect(clearDeferredLayout).not.toHaveBeenCalled();
});
