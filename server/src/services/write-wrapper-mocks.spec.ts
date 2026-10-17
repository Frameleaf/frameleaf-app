import { describe, expect, it, vi } from 'vitest';
import { getMocks } from 'test/utils.js';

describe('service write-wrapper mocks', () => {
  it('executes asset-origin writes and preserves their result and rejection', async () => {
    const { partnerOrigin } = getMocks();
    const result = { changed: true };
    const write = vi.fn(() => Promise.resolve(result));
    await expect(partnerOrigin.withOriginEdit('asset', ['asset'], [], write)).resolves.toBe(result);
    expect(write).toHaveBeenCalledExactlyOnceWith();
    const error = new Error('write failed');
    await expect(partnerOrigin.withOriginEdit('asset', ['asset'], [], () => Promise.reject(error))).rejects.toBe(error);
  });

  it('executes person-origin writes without an origin and preserves their result and rejection', async () => {
    const { partnerOrigin } = getMocks();
    const result = { changed: true };
    const write = vi.fn(() => Promise.resolve(result));
    await expect(partnerOrigin.withPersonOrigin('owner', 'person', write)).resolves.toBe(result);
    expect(write).toHaveBeenCalledExactlyOnceWith(undefined);
    const error = new Error('write failed');
    await expect(partnerOrigin.withPersonOrigin('owner', 'person', () => Promise.reject(error))).rejects.toBe(error);
  });

  it.each(['withOriginEdit', 'withPersonOrigin'] as const)(
    'retains deliberate %s rejection overrides',
    async (method) => {
      const { partnerOrigin } = getMocks();
      const error = new Error('origin busy');
      partnerOrigin[method].mockRejectedValue(error);
      const write = vi.fn(() => Promise.resolve(true));
      const pending =
        method === 'withOriginEdit'
          ? partnerOrigin.withOriginEdit('asset', ['asset'], [], write)
          : partnerOrigin.withPersonOrigin('owner', 'person', write);
      await expect(pending).rejects.toBe(error);
      expect(write).not.toHaveBeenCalled();
    },
  );
});

describe('repository write-wrapper mock defaults', () => {
  it('executes asset metadata and Live Photo writes with the mocked repositories', async () => {
    const mocks = getMocks();
    const metadata = vi.fn(() => Promise.resolve('metadata'));
    await expect(mocks.asset.withMetadataUpdate('asset', metadata)).resolves.toBe('metadata');
    expect(metadata).toHaveBeenCalledExactlyOnceWith(mocks.asset, mocks.access, undefined);
    const livePhoto = vi.fn(() => Promise.resolve('live'));
    await expect(mocks.asset.withLivePhotoUpdate('asset', null, livePhoto)).resolves.toBe('live');
    expect(livePhoto).toHaveBeenCalledExactlyOnceWith(mocks.asset, mocks.access);
  });

  it('executes album membership, person merge, owner tag and item-share writes', async () => {
    const mocks = getMocks();
    const membership = vi.fn(() => Promise.resolve('album'));
    await expect(mocks.album.withMembershipWrite(['album'], membership)).resolves.toBe('album');
    expect(membership).toHaveBeenCalledExactlyOnceWith(undefined, mocks.album);
    const merge = vi.fn(() => Promise.resolve('merge'));
    await expect(mocks.person.withMergeWrite(merge, 'owner')).resolves.toBe('merge');
    expect(merge).toHaveBeenCalledExactlyOnceWith();
    const tag = vi.fn(() => Promise.resolve('tag'));
    await expect(mocks.partnerOrigin.withOwnerTagEdit('owner', tag)).resolves.toBe('tag');
    expect(tag).toHaveBeenCalledExactlyOnceWith();
    const share = vi.fn(() => Promise.resolve('share'));
    await expect(mocks.itemShare.withTransaction(share)).resolves.toBe('share');
    expect(share).toHaveBeenCalledExactlyOnceWith(mocks.itemShare, mocks.user, mocks.asset, mocks.access);
    const error = new Error('write failed');
    await expect(mocks.person.withMergeWrite(() => Promise.reject(error), 'owner')).rejects.toBe(error);
  });
});
