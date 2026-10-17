import { currentUrlReplaceAssetId, gotoWithFocusAndScroll, navigate } from './navigation';

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

describe('independent navigation focus and scroll', () => {
  beforeEach(() => {
    state.url = new URL('http://localhost/user-settings?scope=all#heading');
    state.goto.mockReset().mockResolvedValue(undefined);
    document.body.innerHTML = '<input id="input"><h1 id="heading">Title</h1>';
  });
  it('keeps focused controls while resetting the viewport', async () => {
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.focus();
    const scroll = vi.spyOn(globalThis, 'scrollTo').mockImplementation(() => {});
    await gotoWithFocusAndScroll('/folders?path=one', { keepFocus: true, replace: true });
    expect(document.activeElement).toBe(input);
    expect(scroll).toHaveBeenCalledWith(0, 0);
    expect(state.goto).toHaveBeenCalledWith('/folders?path=one', { replace: true, reset: false });
  });
  it('scrolls to an anchor without changing focus or the route query', async () => {
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.focus();
    const scroll = vi
      .spyOn(document.querySelector<HTMLElement>('#heading')!, 'scrollIntoView')
      .mockImplementation(() => {});
    await gotoWithFocusAndScroll('/user-settings?scope=all#heading', { keepFocus: true });
    expect(scroll).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
    expect(state.goto).toHaveBeenCalledWith('/user-settings?scope=all#heading', { reset: false });
  });
  it('blurs outgoing controls before navigation and restores the original body tabindex without scrolling', async () => {
    document.body.setAttribute('tabindex', '3');
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.focus();
    state.goto.mockImplementation(async () => expect(document.activeElement).not.toBe(input));
    const focus = vi.spyOn(document.body, 'focus');
    const scroll = vi.spyOn(globalThis, 'scrollTo').mockImplementation(() => {});
    await gotoWithFocusAndScroll('/memories', { noScroll: true });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
    expect(document.body.getAttribute('tabindex')).toBe('3');
    expect(scroll).not.toHaveBeenCalled();
    document.body.removeAttribute('tabindex');
  });
  it('retains focus selected by the destination and focuses autofocus controls without scrolling', async () => {
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.setAttribute('autofocus', '');
    const focus = vi.spyOn(input, 'focus');
    await gotoWithFocusAndScroll('/memories', { noScroll: true });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockClear();
    state.goto.mockImplementation(async () => input.focus());
    await gotoWithFocusAndScroll('/memories', { noScroll: true });
    expect(focus).toHaveBeenCalledOnce();
  });
  it.each([
    [false, false, true],
    [true, true, false],
  ])('delegates matching focus %s and scroll %s flags to Kit', async (keepFocus, noScroll, reset) => {
    await gotoWithFocusAndScroll('/memories', { keepFocus, noScroll });
    expect(state.goto).toHaveBeenCalledWith('/memories', { reset });
  });
  it('leaves disconnected controls unfocused and restores missing body tabindex', async () => {
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.focus();
    state.goto.mockImplementation(async () => input.remove());
    await gotoWithFocusAndScroll('/memories', { noScroll: true });
    expect(document.body.hasAttribute('tabindex')).toBe(false);
    expect(document.activeElement).not.toBe(input);
  });
});
