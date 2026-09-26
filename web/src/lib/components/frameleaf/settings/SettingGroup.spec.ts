import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { SvelteURL } from 'svelte/reactivity';
import SettingGroup from './SettingGroup.svelte';

const state = vi.hoisted(() => ({
  url: new URL('http://localhost/admin/system-settings?area=libraries'),
  goto: vi.fn(),
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: state.goto }));

describe('settings group navigation', () => {
  beforeEach(() => {
    state.url = new SvelteURL('http://localhost/admin/system-settings?area=libraries&isOpen=library-watch');
    state.goto.mockReset().mockResolvedValue(undefined);
  });
  it('does not start another navigation while an area transition destroys its groups', () => {
    const { unmount } = render(SettingGroup, { key: 'library-watch', title: 'Watch library' });
    // A delayed router still exposes the source URL when the old area is destroyed.
    unmount();
    expect(state.goto).not.toHaveBeenCalled();
    expect(state.url.searchParams.get('isOpen')).toBe('library-watch');
  });
  it('retains explicit collapse navigation and unrelated query state', async () => {
    render(SettingGroup, { key: 'library-watch', title: 'Watch library' });
    await userEvent.click(screen.getByRole('button', { name: 'Watch library' }));
    expect(state.goto).toHaveBeenCalledWith('?area=libraries', { replaceState: true, noScroll: true, keepFocus: true });
  });
});
