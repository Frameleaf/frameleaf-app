import { currentUrlReplaceAssetId, navigate } from './navigation';

const state = vi.hoisted(() => ({
  url: new URL('http://localhost/user-settings'),
  route: { id: '/(user)/user-settings' },
  goto: vi.fn(),
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
    get route() {
      return state.route;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: state.goto }));
vi.mock('$lib/managers/AssetCacheManager.svelte', () => ({ assetCacheManager: {} }));

describe('utility photo links', () => {
  beforeEach(() => state.goto.mockReset().mockResolvedValue(undefined));
  it.each(['/user-settings'])('preserves the tool and filters in %s', async (path) => {
    state.url = new URL(`http://localhost${path}?area=utilities&section=duplicates&status=open&at=old`);
    expect(currentUrlReplaceAssetId('photo')).toBe(
      `${path}?area=utilities&section=duplicates&status=open&assetId=photo`,
    );
    state.url = new URL(currentUrlReplaceAssetId('photo'), state.url);
    await navigate({ targetRoute: 'current', assetId: null });
    expect(state.goto).toHaveBeenCalledWith(`${path}?area=utilities&section=duplicates&status=open`, undefined);
  });
  it('retains the regular photo route contract', () => {
    state.route.id = '/(user)/photos/[[assetId=id]]';
    state.url = new URL('http://localhost/photos?at=old');
    expect(currentUrlReplaceAssetId('photo')).toBe('/photos/photo');
  });
});
