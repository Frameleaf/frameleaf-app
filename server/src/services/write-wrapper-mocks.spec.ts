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
