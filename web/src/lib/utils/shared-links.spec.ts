import { getMySharedLink, type SharedLinkResponseDto } from '@immich/sdk';
import { getAssetInfoFromParam } from '$lib/utils/navigation';
import { loadSharedLink } from '$lib/utils/shared-links';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getMySharedLink: vi.fn(),
  isHttpError: (error: unknown) => error instanceof Error && 'data' in error,
}));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/utils/navigation', () => ({ getAssetInfoFromParam: vi.fn() }));
vi.mock('$lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils')>()),
  getSharedLink: vi.fn(() => undefined),
  setSharedLink: vi.fn(),
}));

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status, data: { message } });

const url = new URL('http://localhost/share/key-1/photos/asset-outside');
const params = { key: 'key-1', assetId: 'asset-outside' };

describe('loadSharedLink (FL-56)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
});
