import { load as load0 } from '../../routes/(user)/archive/[[photos=photos]]/[[assetId=id]]/+page';
import { load as load7 } from '../../routes/(user)/best-photos/[[photos=photos]]/[[assetId=id]]/+page';
import { load as load1 } from '../../routes/(user)/favorites/[[photos=photos]]/[[assetId=id]]/+page';
import { load as load2 } from '../../routes/(user)/photos/[[assetId=id]]/+page';
import { load as load8 } from '../../routes/(user)/recently-added/[[assetId=id]]/+page';
import { load as load3 } from '../../routes/(user)/recently-added/[[photos=photos]]/[[assetId=id]]/+page';
import { load as load4 } from '../../routes/(user)/search/[[photos=photos]]/[[assetId=id]]/+page';
import { load as load5 } from '../../routes/(user)/shared-links/(list)/+layout';
import { load as load6 } from '../../routes/(user)/shared-links/(list)/+page';
import { authenticate } from './auth';
import { getFormatter } from './i18n';

vi.mock('./auth', () => ({ authenticate: vi.fn() }));
vi.mock('./i18n', () => ({ getFormatter: vi.fn() }));

const routes = [
  ['best-photos/[[photos=photos]]/[[assetId=id]]/+page', load7, 'best_photos_page_title'],
  ['recently-added/[[assetId=id]]/+page', load8, 'recently_added_page_title'],
  ['archive/[[photos=photos]]/[[assetId=id]]/+page', load0, 'archive'],
  ['favorites/[[photos=photos]]/[[assetId=id]]/+page', load1, 'favorites'],
  ['photos/[[assetId=id]]/+page', load2, 'photos'],
  ['recently-added/[[photos=photos]]/[[assetId=id]]/+page', load3, 'recently_added_page_title'],
  ['search/[[photos=photos]]/[[assetId=id]]/+page', load4, 'search'],
  ['shared-links/(list)/+layout', load5, 'shared_links'],
  ['shared-links/(list)/+page', load6, 'shared_links'],
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFormatter).mockResolvedValue(((key: string) => `first:${key}`) as never);
});

describe.each(routes)('%s metadata', (_path, load, title) => {
  const url = new URL('https://example.test/photos?assetId=selected');
  const open = () => load({ url } as never);

  it('waits for authentication before requesting a formatter', async () => {
    let admit!: () => void;
    vi.mocked(authenticate).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        admit = resolve;
      }),
    );
    const pending = open();
    expect(authenticate).toHaveBeenCalledExactlyOnceWith(url);
    expect(getFormatter).not.toHaveBeenCalled();
    admit();
    await expect(pending).resolves.toEqual({ meta: { title: `first:${title}` } });
  });

  it('propagates an authentication redirect without loading translations', async () => {
    const redirect = { status: 307, location: '/auth/login?continue=%2Fphotos' };
    vi.mocked(authenticate).mockRejectedValueOnce(redirect);
    await expect(open()).rejects.toBe(redirect);
    expect(getFormatter).not.toHaveBeenCalled();
  });

  it('reads the current formatter each time and propagates locale failures', async () => {
    await expect(open()).resolves.toEqual({ meta: { title: `first:${title}` } });
    vi.mocked(getFormatter).mockResolvedValueOnce(((key: string) => `second:${key}`) as never);
    await expect(open()).resolves.toEqual({ meta: { title: `second:${title}` } });
    const failure = new Error('locale unavailable');
    vi.mocked(getFormatter).mockRejectedValueOnce(failure);
    await expect(open()).rejects.toBe(failure);
  });
});
