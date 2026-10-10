import { getAssetDevelop, saveAssetDevelop, cancelAssetDevelopRender } from '@frameleaf/sdk';
import { vi, it, expect, beforeEach } from 'vitest';
import { initialNativeRecipe, newNativeMask } from './native-develop';
import { proposeNativeMask } from './native-develop';
import { syncNativeRecipes, cancelNativeSync } from './native-sync';

vi.mock('@frameleaf/sdk', () => ({
  defaults: {},
  getBaseUrl: () => '/api',
  getAssetDevelop: vi.fn(),
  saveAssetDevelop: vi.fn(),
  cancelAssetDevelopRender: vi.fn(),
}));
vi.mock('./native-develop', async (original) => ({ ...(await original<object>()), proposeNativeMask: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAssetDevelop).mockResolvedValue({ revisions: [] } as never);
  vi.mocked(saveAssetDevelop).mockImplementation(async ({ id }) => ({ id: `revision-${id}` }) as never);
  vi.mocked(proposeNativeMask).mockImplementation(async (id) => ({ id: `mask-${id}`, width: 20, height: 10 }));
});
it('recomputes semantic masks per destination and retains unselected native settings', async () => {
  vi.mocked(getAssetDevelop).mockResolvedValue({
    revisions: [
      { isCurrent: true, recipe: { ...initialNativeRecipe(), exposureEV: -1, crop: { x: 0, y: 0, w: 0.5, h: 1 } } },
    ],
  } as never);
  const source = { ...initialNativeRecipe(), exposureEV: 2, masks: [newNativeMask('subject', 'original-mask')] };
  const result = await syncNativeRecipes(['a', 'b', 'a'], source, ['exposureEV', 'masks']);
  expect(result.map((item) => item.revisionId)).toEqual(['revision-a', 'revision-b']);
  expect(vi.mocked(proposeNativeMask).mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
  const first = vi.mocked(saveAssetDevelop).mock.calls[0][0].assetDevelopSaveDto.recipe;
  expect(first).toMatchObject({ version: 2, exposureEV: 2, crop: { w: 0.5 }, masks: [{ artifact: 'mask-a' }] });
  expect(first).not.toHaveProperty('sensorCanvas');
});
it('isolates per-photo failures, retries only failed admissions and cancels exact revision jobs', async () => {
  vi.mocked(getAssetDevelop).mockRejectedValueOnce(new Error('Photo unavailable'));
  const failed = await syncNativeRecipes(['a', 'b'], initialNativeRecipe(), ['exposureEV']);
  expect(failed.map((result) => result.status)).toEqual(['failed', 'queued']);
  vi.mocked(saveAssetDevelop).mockClear();
  const retried = await syncNativeRecipes(['a', 'b'], initialNativeRecipe(), ['exposureEV'], { completed: failed });
  expect(saveAssetDevelop).toHaveBeenCalledTimes(1);
  await cancelNativeSync(retried);
  expect(cancelAssetDevelopRender).toHaveBeenCalledWith({ id: 'b', revisionId: 'revision-b' });
});
it('stops new admissions on cancellation and refuses source brush transfer', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(
    (await syncNativeRecipes(['a'], initialNativeRecipe(), ['exposureEV'], { signal: controller.signal }))[0].status,
  ).toBe('cancelled');
  expect(saveAssetDevelop).not.toHaveBeenCalled();
  const result = await syncNativeRecipes(['a'], { ...initialNativeRecipe(), masks: [newNativeMask('brush')] }, [
    'masks',
  ]);
  expect(result[0]).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('Brush masks are photo-specific'),
  });
});
it('detaches nested source settings and each destination recipe before admission', async () => {
  const current = { ...initialNativeRecipe(), crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 }, sensorCanvas: true };
  vi.mocked(getAssetDevelop).mockResolvedValue({ revisions: [{ isCurrent: true, recipe: current }] } as never);
  const source = {
    ...initialNativeRecipe(),
    curve: [
      { x: 0, y: 0 },
      { x: 1, y: 0.9 },
    ],
    masks: [newNativeMask('radial')],
  };
  const before = structuredClone(source);
  await syncNativeRecipes(['a', 'b'], source, ['curve', 'masks']);
  const recipes = vi.mocked(saveAssetDevelop).mock.calls.map(([request]) => request.assetDevelopSaveDto.recipe);
  expect(recipes[0]).not.toBe(recipes[1]);
  expect(recipes[0].curve).not.toBe(recipes[1].curve);
  expect(recipes[0].masks?.[0].id).not.toBe(recipes[1].masks?.[0].id);
  recipes[0].curve![1].y = 0.5;
  recipes[0].masks![0].adjustments.exposureEV = 3;
  recipes[0].crop!.x = 0.4;
  expect(recipes[1].curve![1].y).toBe(0.9);
  expect(recipes[1].masks![0].adjustments.exposureEV).toBe(0);
  expect(recipes[1].crop!.x).toBe(0.1);
  expect(source).toEqual(before);
  expect(current.crop.x).toBe(0.1);
  expect(current.sensorCanvas).toBe(true);
});
