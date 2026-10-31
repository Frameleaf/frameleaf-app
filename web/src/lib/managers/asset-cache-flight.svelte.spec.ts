import { beforeEach, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetCacheManager as cache } from '$lib/managers/AssetCacheManager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.resetAllMocks();
  cache.revoke();
});

const families = [
  { name: 'asset', fetch: sdkMock.getAssetInfo, load: () => cache.getAsset({ id: 'a' }) },
  { name: 'faces', fetch: sdkMock.getFaces, load: () => cache.getAssetFaces('a') },
  { name: 'OCR', fetch: sdkMock.getAssetOcr, load: () => cache.getAssetOcr('a') },
] as const;

for (const family of families) {
  it(`${family.name} shares simultaneous misses and caches the original response`, async () => {
    const response = deferred<never>();
    const value = [] as never;
    family.fetch.mockReturnValue(response.promise);
    const readers = Array.from({ length: 6 }, () => family.load());
    expect(family.fetch).toHaveBeenCalledTimes(1);
    response.resolve(value);
    expect(await Promise.all(readers)).toEqual(Array.from({ length: 6 }, () => value));
    expect(await family.load()).toBe(value);
    expect(family.fetch).toHaveBeenCalledTimes(1);
  });

  it(`${family.name} releases a shared failure so another read can retry`, async () => {
    const response = deferred<never>();
    const failure = new Error('offline');
    family.fetch.mockReturnValueOnce(response.promise).mockResolvedValueOnce([] as never);
    const readers = [family.load(), family.load()];
    const outcomes = readers.map((reader) => reader.catch((error: unknown) => error));
    expect(family.fetch).toHaveBeenCalledTimes(1);
    response.reject(failure);
    expect(await Promise.all(outcomes)).toEqual([failure, failure]);
    expect(await family.load()).toEqual([]);
    expect(family.fetch).toHaveBeenCalledTimes(2);
  });

  it(`${family.name} fences all joined reads without retiring a replacement request`, async () => {
    const old = deferred<never>();
    const fresh = deferred<never>();
    family.fetch.mockReturnValue(old.promise);
    const oldReaders = [family.load(), family.load()];
    const outcomes = oldReaders.map((reader) => reader.catch((error: unknown) => error));
    cache.invalidateAsset('a');
    family.fetch.mockReturnValue(fresh.promise);
    const replacement = family.load();
    old.resolve([] as never);
    expect(await Promise.all(outcomes)).toEqual([
      expect.objectContaining({ name: 'AbortError' }),
      expect.objectContaining({ name: 'AbortError' }),
    ]);
    const joined = family.load();
    expect(family.fetch).toHaveBeenCalledTimes(2);
    fresh.resolve([] as never);
    expect(await replacement).toEqual([]);
    expect(await joined).toEqual([]);
  });
}

it('keeps public-share credentials in separate request keys', async () => {
  const value = assetFactory.build({ id: 'a' });
  sdkMock.getAssetInfo.mockResolvedValue(value);
  const first = cache.getAsset({ id: 'a', key: 'share-one', slug: 'one' });
  const second = cache.getAsset({ id: 'a', key: 'share-two', slug: 'two' });
  await Promise.all([first, second]);
  expect(sdkMock.getAssetInfo).toHaveBeenCalledTimes(2);
  expect(sdkMock.getAssetInfo).toHaveBeenNthCalledWith(1, { id: 'a', key: 'share-one', slug: 'one' });
  expect(sdkMock.getAssetInfo).toHaveBeenNthCalledWith(2, { id: 'a', key: 'share-two', slug: 'two' });
});

it('caches a shared response when only one reader requested caching', async () => {
  const response = deferred<ReturnType<typeof assetFactory.build>>();
  const value = assetFactory.build({ id: 'a' });
  sdkMock.getAssetInfo.mockReturnValue(response.promise);
  const uncached = cache.getAsset({ id: 'a' }, false);
  const cached = cache.getAsset({ id: 'a' });
  expect(sdkMock.getAssetInfo).toHaveBeenCalledTimes(1);
  response.resolve(value);
  expect(await uncached).toBe(value);
  expect(await cached).toBe(value);
  expect(await cache.getAsset({ id: 'a' })).toBe(value);
  expect(sdkMock.getAssetInfo).toHaveBeenCalledTimes(1);
});

it('releases a shared uncached response so a later read fetches again', async () => {
  const response = deferred<ReturnType<typeof assetFactory.build>>();
  const value = assetFactory.build({ id: 'a' });
  sdkMock.getAssetInfo.mockReturnValueOnce(response.promise).mockResolvedValueOnce(value);
  const first = cache.getAsset({ id: 'a' }, false);
  const second = cache.getAsset({ id: 'a' }, false);
  expect(sdkMock.getAssetInfo).toHaveBeenCalledTimes(1);
  response.resolve(value);
  await Promise.all([first, second]);
  await cache.getAsset({ id: 'a' });
  expect(sdkMock.getAssetInfo).toHaveBeenCalledTimes(2);
});

it('lets a pre-refresh reader resolve without overwriting a newer cached answer', async () => {
  const old = deferred<ReturnType<typeof assetFactory.build>>();
  const oldValue = assetFactory.build({ id: 'a', originalFileName: 'old.jpg' });
  const freshValue = assetFactory.build({ id: 'a', originalFileName: 'fresh.jpg' });
  sdkMock.getAssetInfo.mockReturnValueOnce(old.promise).mockResolvedValueOnce(freshValue);
  const oldReader = cache.getAsset({ id: 'a' });
  cache.invalidate();
  expect(await cache.getAsset({ id: 'a' })).toBe(freshValue);
  old.resolve(oldValue);
  expect(await oldReader).toBe(oldValue);
  expect(await cache.getAsset({ id: 'a' })).toBe(freshValue);
  expect(sdkMock.getAssetInfo).toHaveBeenCalledTimes(2);
});

it('does not join the old request after a plain refresh', async () => {
  const old = deferred<never>();
  const fresh = deferred<never>();
  sdkMock.getAssetOcr.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const oldReader = cache.getAssetOcr('a');
  cache.invalidate();
  const freshReader = cache.getAssetOcr('a');
  old.resolve([] as never);
  await oldReader;
  const joined = cache.getAssetOcr('a');
  expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(2);
  const value = [] as never;
  fresh.resolve(value);
  expect(await freshReader).toBe(value);
  expect(await joined).toBe(value);
});
