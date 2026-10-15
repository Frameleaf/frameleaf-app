import { getMyApiKey, Permission } from '@frameleaf/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getMyApiKey: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.mocked(getMyApiKey).mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('permission denied');
  });
});
afterEach(() => vi.restoreAllMocks());

const keyWith = (permissions: Permission[]) => ({ permissions }) as Awaited<ReturnType<typeof getMyApiKey>>;

describe('CLI permission admission', () => {
  it('reads current credentials after a previous key allowed the operation', async () => {
    const { requirePermissions } = await import('src/utils.js');
    vi.mocked(getMyApiKey)
      .mockResolvedValueOnce(keyWith([Permission.All]))
      .mockResolvedValueOnce(keyWith([Permission.UserRead]));
    await requirePermissions([Permission.AssetUpload]);
    await expect(requirePermissions([Permission.AssetUpload])).rejects.toThrow('permission denied');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"asset.upload"'));
  });

  it('keeps independent concurrent checks bound to their own responses', async () => {
    const { requirePermissions } = await import('src/utils.js');
    const firstResponse = Promise.withResolvers<Awaited<ReturnType<typeof getMyApiKey>>>();
    vi.mocked(getMyApiKey)
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce(keyWith([Permission.UserRead]));
    const first = requirePermissions([Permission.AssetUpload]);
    await requirePermissions([Permission.UserRead]);
    firstResponse.resolve(keyWith([Permission.AssetUpload]));
    await first;
    expect(getMyApiKey).toHaveBeenCalledTimes(2);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('propagates permission lookup failures without falling back to a previously allowed key', async () => {
    const { requirePermissions } = await import('src/utils.js');
    vi.mocked(getMyApiKey)
      .mockResolvedValueOnce(keyWith([Permission.All]))
      .mockRejectedValueOnce(new Error('credentials expired'));
    await requirePermissions([Permission.UserRead]);
    await expect(requirePermissions([Permission.UserRead])).rejects.toThrow('credentials expired');
  });
});
