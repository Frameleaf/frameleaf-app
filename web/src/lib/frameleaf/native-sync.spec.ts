import { vi, it, expect, beforeEach } from 'vitest';
import { syncNativeRecipes, cancelNativeSync } from './native-sync';
import { initialNativeRecipe, newNativeMask } from './native-develop';
import { getAssetDevelop, saveAssetDevelop, cancelAssetDevelopRender } from '@immich/sdk';
import { proposeNativeMask } from './native-develop';
vi.mock('@immich/sdk', () => ({
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
