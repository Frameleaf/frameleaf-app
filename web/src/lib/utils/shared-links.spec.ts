import { getMySharedLink, type SharedLinkResponseDto } from '@frameleaf/sdk';
import { getSharedLink, setSharedLink } from '$lib/utils';
import { getAssetInfoFromParam } from '$lib/utils/navigation';
import { loadSharedLink } from '$lib/utils/shared-links';
import { deferredPromise } from '@test-data/deferred';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getMySharedLink: vi.fn(),
  isHttpError: (error: unknown) => error instanceof Error && 'data' in error,
}));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/utils/navigation', () => ({ getAssetInfoFromParam: vi.fn() }));

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status, data: { message } });

const url = new URL('http://localhost/share/key-1/photos/asset-outside');
const params = { key: 'key-1', assetId: 'asset-outside' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMySharedLink).mockReset();
  setSharedLink(undefined);
  vi.mocked(getAssetInfoFromParam).mockReset().mockResolvedValue(undefined);
});

describe('loadSharedLink (FL-56)', () => {
  it('asks for the password before any item behind the link is requested', async () => {
    vi.mocked(getMySharedLink).mockRejectedValue(httpError(401, 'Password required'));

    const data = await loadSharedLink({ url, params });

    expect(data).toMatchObject({ key: 'key-1', passwordRequired: true });
    expect(getAssetInfoFromParam).not.toHaveBeenCalled();
  });

  it('refuses an item the link does not share, so the share error page shows', async () => {
    vi.mocked(getMySharedLink).mockResolvedValue({ assets: [], key: 'key-1' } as unknown as SharedLinkResponseDto);
    const refused = httpError(400, 'Not found or no asset.read access');
    vi.mocked(getAssetInfoFromParam).mockRejectedValue(refused);

    await expect(loadSharedLink({ url, params })).rejects.toBe(refused);
  });

  it('keeps an HTTP error with no body instead of throwing a TypeError', async () => {
    const empty = Object.assign(new Error('Bad gateway'), { status: 502, data: null });
    vi.mocked(getMySharedLink).mockRejectedValue(empty);

    await expect(loadSharedLink({ url, params })).rejects.toBe(empty);
  });
});

it('does not reuse a legacy cached link whose missing slug only matches an absent route parameter', async () => {
  vi.clearAllMocks();
  const cached = {
    ...sharedLinkFactory.build({ key: 'previous' }),
    slug: undefined,
  } as unknown as SharedLinkResponseDto;
  const current = sharedLinkFactory.build({ key: 'key-1' });
  setSharedLink(cached);
  vi.mocked(getMySharedLink).mockResolvedValueOnce(current);
  vi.mocked(getAssetInfoFromParam).mockResolvedValue(undefined);
  const data = await loadSharedLink({ url, params });
  expect('sharedLink' in data && data.sharedLink).toEqual(current);
  expect(getMySharedLink).toHaveBeenCalledWith({ key: 'key-1', slug: undefined });
});

it('still reuses a cache entry with a matching supplied key', async () => {
  vi.clearAllMocks();
  const cached = sharedLinkFactory.build({ key: 'key-1' });
  setSharedLink(cached);
  vi.mocked(getAssetInfoFromParam).mockResolvedValue(undefined);
  const data = await loadSharedLink({ url, params });
  expect('sharedLink' in data && data.sharedLink).toEqual(cached);
  expect(getMySharedLink).not.toHaveBeenCalled();
});

it('does not replace the current shared-link cache when an older load finishes last', async () => {
  vi.clearAllMocks();
  setSharedLink(undefined);
  vi.mocked(getAssetInfoFromParam).mockResolvedValue(undefined);
  const first = deferredPromise<SharedLinkResponseDto>();
  const old = sharedLinkFactory.build({ key: 'old' });
  const current = sharedLinkFactory.build({ key: 'current' });
  vi.mocked(getMySharedLink).mockReturnValueOnce(first.promise).mockResolvedValueOnce(current);
  const previous = loadSharedLink({ url, params: { key: 'old' } });
  await vi.waitFor(() => expect(getMySharedLink).toHaveBeenCalledOnce());
  await loadSharedLink({ url, params: { key: 'current' } });
  first.resolve(old);
  await previous;
  expect(getSharedLink()).toEqual(current);
});

it('does not refill the shared-link cache after its page clears it during loading', async () => {
  const response = deferredPromise<SharedLinkResponseDto>();
  vi.mocked(getMySharedLink).mockReturnValueOnce(response.promise);
  const pending = loadSharedLink({ url, params });
  await vi.waitFor(() => expect(getMySharedLink).toHaveBeenCalledOnce());
  setSharedLink(undefined);
  response.resolve(sharedLinkFactory.build({ key: 'key-1' }));
  await pending;
  expect(getSharedLink()).toBeUndefined();
});
