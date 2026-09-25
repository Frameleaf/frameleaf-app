import { isInaccessibleAssetError, libraryUrlWithoutAsset } from '$lib/utils/navigation';
import { load } from './+layout';

const state = vi.hoisted(() => ({ getAsset: vi.fn() }));

/** Stands in for the SDK's HTTP error (`@oazapfts/runtime` is not a web dependency). */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  isHttpError: (error: unknown) => error instanceof HttpError,
}));

vi.mock('$app/state', () => ({ page: {} }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn().mockResolvedValue(undefined) }));
vi.mock('$lib/managers/AssetCacheManager.svelte', () => ({
  assetCacheManager: { getAsset: (...args: unknown[]) => state.getAsset(...args) },
}));

const httpError = (status: number) => new HttpError(status);

/** FL-33: a deep link to an item that is gone or unreadable opens its page without it. */
describe('(user) layout load', () => {
  const run = (path: string, params: Record<string, string>, routeId: string) =>
    (load as unknown as (event: unknown) => Promise<unknown>)({
      url: new URL(`http://localhost${path}`),
      params,
      route: { id: routeId },
    });

  beforeEach(() => {
    state.getAsset.mockReset();
  });

  it('opens the library without an asset that was deleted or revoked', async () => {
    state.getAsset.mockRejectedValue(httpError(404));
    await expect(run('/photos/gone?fl=x', { assetId: 'gone' }, '/(user)/photos/[[assetId=id]]')).rejects.toMatchObject({
      status: 307,
      location: '/photos?fl=x',
    });
  });

  it('opens the album without an item the account can no longer read', async () => {
    state.getAsset.mockRejectedValue(httpError(400));
    await expect(
      run(
        '/albums/album-1/photos/gone',
        { albumId: 'album-1', assetId: 'gone' },
        '/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]',
      ),
    ).rejects.toMatchObject({ status: 307, location: '/albums/album-1' });
  });

  it('leaves Locked items to the PIN flow and other failures to the error page', async () => {
    state.getAsset.mockRejectedValue(httpError(403));
    await expect(
      run('/locked/photos/secret', { assetId: 'secret' }, '/(user)/locked/[[photos=photos]]/[[assetId=id]]'),
    ).rejects.toBeInstanceOf(HttpError);

    state.getAsset.mockRejectedValue(httpError(500));
    await expect(run('/photos/broken', { assetId: 'broken' }, '/(user)/photos/[[assetId=id]]')).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it('returns a readable asset as before', async () => {
    state.getAsset.mockResolvedValue({ id: 'here' });
    await expect(run('/photos/here', { assetId: 'here' }, '/(user)/photos/[[assetId=id]]')).resolves.toEqual({
      asset: { id: 'here' },
    });
  });
});

describe('libraryUrlWithoutAsset', () => {
  it.each([
    ['/photos/a1', '/photos'],
    ['/recently-added/a1?at=x', '/recently-added?at=x'],
    ['/favorites/photos/a1', '/favorites'],
    ['/people/p1/photos/a1', '/people/p1'],
    ['/map/photos/a1', '/map'],
  ])('%s → %s', (path, expected) => {
    expect(libraryUrlWithoutAsset(new URL(`http://localhost${path}`), 'a1')).toBe(expected);
  });

  it('treats only not found, forbidden and refused as an unreadable item', () => {
    expect(isInaccessibleAssetError(httpError(404))).toBe(true);
    expect(isInaccessibleAssetError(httpError(403))).toBe(true);
    expect(isInaccessibleAssetError(httpError(400))).toBe(true);
    expect(isInaccessibleAssetError(httpError(500))).toBe(false);
    expect(isInaccessibleAssetError(new Error('network'))).toBe(false);
  });
});
