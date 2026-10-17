import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { ocrManager as ocr, type OcrBoundingBox } from '$lib/stores/ocr.svelte';

const box = (id: string, assetId = 'photo', text = id): OcrBoundingBox => ({
  id,
  assetId,
  text,
  x1: 0,
  y1: 0,
  x2: 1,
  y2: 0,
  x3: 1,
  y3: 1,
  x4: 0,
  y4: 1,
  boxScore: 0.9,
  textScore: 0.8,
});
const deferred = () => {
  let resolve!: (value: OcrBoundingBox[]) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<OcrBoundingBox[]>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.resetAllMocks();
  assetCacheManager.revoke();
  ocr.clear();
  ocr.setDocumentText(null);
});
afterEach(() => {
  ocr.clear();
  ocr.setDocumentText(null);
  assetCacheManager.revoke();
});

describe('OCR document contracts', () => {
  it('preserves order and box references except for matching string corrections', async () => {
    sdkMock.getAssetOcr.mockResolvedValue([
      box('corrected'),
      box('dismissed'),
      box('same', 'photo', 'Same'),
      box('empty'),
      box('untouched'),
      box('dismissed', 'other'),
    ]);
    await ocr.getAssetOcr('photo');
    const original = ocr.data;
    expect(ocr.data).toBe(original);
    ocr.setDocumentText({
      assetId: 'photo',
      overrides: new Map([
        ['corrected', 'Correction'],
        ['dismissed', null],
        ['same', 'Same'],
        ['empty', ''],
      ]),
    });
    expect(ocr.data.map(({ id, text }) => [id, text])).toEqual([
      ['corrected', 'Correction'],
      ['same', 'Same'],
      ['empty', ''],
      ['untouched', 'untouched'],
      ['dismissed', 'dismissed'],
    ]);
    expect(ocr.data[0]).toEqual({ ...original[0], text: 'Correction' });
    expect(ocr.data[0]).not.toBe(original[0]);
    expect(ocr.data[1]).not.toBe(original[2]);
    expect(ocr.data[3]).toBe(original[4]);
    expect(ocr.data[4]).toBe(original[5]);
    expect(original[0].text).toBe('corrected');
    expect(ocr.data).toBe(ocr.data);
    ocr.setDocumentText(null);
    expect(ocr.data).toBe(original);
  });

  it('looks up each matching override once and never reads decisions for another asset', async () => {
    sdkMock.getAssetOcr.mockResolvedValue([box('a'), box('b'), box('c'), box('a', 'other')]);
    await ocr.getAssetOcr('photo');
    const overrides = new Map<string, string | null>([
      ['a', 'A'],
      ['b', null],
    ]);
    const get = vi.spyOn(overrides, 'get');
    ocr.setDocumentText({ assetId: 'photo', overrides });
    expect(ocr.data.map(({ id, text }) => [id, text])).toEqual([
      ['a', 'A'],
      ['c', 'c'],
      ['a', 'a'],
    ]);
    expect(get.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps raw OCR availability when the owner dismisses every displayed line', async () => {
    sdkMock.getAssetOcr.mockResolvedValue([box('a')]);
    await ocr.getAssetOcr('photo');
    ocr.setDocumentText({ assetId: 'photo', overrides: new Map([['a', null]]) });
    expect(ocr.data).toEqual([]);
    expect(ocr.hasOcrData).toBe(true);
  });

  it('keeps sparse-array filtering after a consumer removes a raw box', async () => {
    sdkMock.getAssetOcr.mockResolvedValue([box('a'), box('b'), box('c')]);
    await ocr.getAssetOcr('photo');
    Reflect.deleteProperty(ocr.data, '1');
    ocr.setDocumentText({ assetId: 'photo', overrides: new Map([['a', 'A']]) });
    expect(ocr.data.map(({ id, text }) => [id, text])).toEqual([
      ['a', 'A'],
      ['c', 'c'],
    ]);
  });
});

describe('OCR request ownership', () => {
  it('does not publish a response received after clear', async () => {
    const request = deferred();
    sdkMock.getAssetOcr.mockReturnValue(request.promise);
    const loading = ocr.getAssetOcr('photo');
    await vi.waitFor(() => expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(1));
    ocr.clear();
    request.resolve([box('old')]);
    await loading;
    expect(ocr.data).toEqual([]);
    expect(ocr.hasOcrData).toBe(false);
  });

  it('starts a cleared photo without waiting for an obsolete read', async () => {
    const old = deferred();
    sdkMock.getAssetOcr.mockReturnValueOnce(old.promise).mockResolvedValueOnce([box('fresh', 'fresh')]);
    const oldLoad = ocr.getAssetOcr('old');
    await vi.waitFor(() => expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(1));
    ocr.clear();
    const fresh = ocr.getAssetOcr('fresh');
    try {
      await vi.waitFor(() => expect(ocr.data.map(({ id }) => id)).toEqual(['fresh']), { timeout: 100 });
      expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(2);
    } finally {
      old.resolve([box('old', 'old')]);
      await Promise.all([oldLoad, fresh]);
    }
    expect(ocr.data.map(({ id }) => id)).toEqual(['fresh']);
  });

  it('shares a read submitted synchronously during SDK setup', async () => {
    const request = deferred();
    let joined: Promise<void> | undefined;
    sdkMock.getAssetOcr.mockImplementationOnce(() => {
      joined = ocr.getAssetOcr('photo');
      return request.promise;
    });
    const loading = ocr.getAssetOcr('photo');
    try {
      await vi.waitFor(() => expect(joined).toBeDefined());
      expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(1);
    } finally {
      request.resolve([box('shared')]);
      await Promise.all([loading, joined]);
    }
    expect(ocr.data.map(({ id }) => id)).toEqual(['shared']);
  });

  it('preserves a clear-and-reload submitted synchronously during SDK setup', async () => {
    const old = deferred();
    let replacement: Promise<void> | undefined;
    sdkMock.getAssetOcr
      .mockImplementationOnce(() => {
        ocr.clear();
        replacement = ocr.getAssetOcr('fresh');
        return old.promise;
      })
      .mockResolvedValueOnce([box('fresh', 'fresh')]);
    const loading = ocr.getAssetOcr('old');
    try {
      await vi.waitFor(() => expect(ocr.data.map(({ id }) => id)).toEqual(['fresh']), { timeout: 100 });
      await replacement;
      let settled = false;
      const joined = ocr.getAssetOcr('fresh').then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
      await joined;
    } finally {
      old.resolve([box('old', 'old')]);
      await Promise.all([loading, replacement]);
    }
    expect(ocr.data.map(({ id }) => id)).toEqual(['fresh']);
  });

  it('retries a failed read and retains ordinary once-per-clear loading', async () => {
    sdkMock.getAssetOcr.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([box('ready')]);
    await ocr.getAssetOcr('photo');
    await Promise.all([ocr.getAssetOcr('photo'), ocr.getAssetOcr('photo')]);
    await ocr.getAssetOcr('another');
    expect(ocr.data.map(({ id }) => id)).toEqual(['ready']);
    expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(2);
  });
});

describe('OCR explicit refresh', () => {
  it('retires old boxes immediately while a replacement reading is pending or fails', async () => {
    const replacement = deferred();
    sdkMock.getAssetOcr.mockResolvedValueOnce([box('old')]).mockReturnValueOnce(replacement.promise);
    await ocr.getAssetOcr('photo');
    ocr.showOverlay = true;
    assetCacheManager.invalidateAsset('photo');
    const refresh = ocr.getAssetOcr('photo', true);
    try {
      expect(ocr.data).toEqual([]);
      expect(ocr.hasOcrData).toBe(false);
      expect(ocr.showOverlay).toBe(true);
      replacement.reject(new Error('offline'));
      await refresh;
      expect(ocr.data).toEqual([]);
    } finally {
      replacement.resolve([]);
      await refresh;
    }
  });

  it('refreshes an invalidated completed reading without resetting overlay, document or highlight choices', async () => {
    sdkMock.getAssetOcr.mockResolvedValueOnce([box('old')]).mockResolvedValueOnce([box('fresh')]);
    await ocr.getAssetOcr('photo');
    ocr.showOverlay = true;
    ocr.setDocumentText({ assetId: 'photo', overrides: new Map([['fresh', 'Corrected fresh']]) });
    ocr.setHighlight('photo', { x1: 0, y1: 0, x2: 1, y2: 0, x3: 1, y3: 1, x4: 0, y4: 1 });
    const highlight = ocr.highlight;
    assetCacheManager.invalidateAsset('photo');
    await ocr.getAssetOcr('photo', true);
    expect(ocr.data.map(({ id, text }) => [id, text])).toEqual([['fresh', 'Corrected fresh']]);
    expect(ocr.showOverlay).toBe(true);
    expect(ocr.highlight).toBe(highlight);
    expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'error'])('starts an invalidated refresh before an obsolete %s settles', async (outcome) => {
    const old = deferred();
    const fresh = deferred();
    sdkMock.getAssetOcr.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const oldLoad = ocr.getAssetOcr('photo');
    await vi.waitFor(() => expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(1));
    assetCacheManager.invalidateAsset('photo');
    const refresh = ocr.getAssetOcr('photo', true);
    try {
      await vi.waitFor(() => expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(2), { timeout: 100 });
      if (outcome === 'success') {
        old.resolve([box('old')]);
      } else {
        old.reject(new Error('offline'));
      }
      await oldLoad;
      const joined = ocr.getAssetOcr('photo');
      fresh.resolve([box('fresh')]);
      await Promise.all([refresh, joined]);
      expect(ocr.data.map(({ id }) => id)).toEqual(['fresh']);
      expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(2);
    } finally {
      old.resolve([]);
      fresh.resolve([box('fresh')]);
      await Promise.all([oldLoad, refresh]);
    }
  });
});
