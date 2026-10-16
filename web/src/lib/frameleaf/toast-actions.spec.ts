import { toastManager, type ToastButton } from '@frameleaf/ui';
import { clearPrivateBrowserState } from '$lib/frameleaf/private-browser-state';
import { toastAction, toastUndo } from '$lib/frameleaf/toast';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { userAdminFactory } from '@test-data/factories/user-factory';

beforeEach(() => {
  authManager.reset();
  authManager.setUser(userAdminFactory.build({ id: 'original' }));
  vi.spyOn(toastManager, 'show').mockImplementation(() => 'toast');
});
afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState({}, '', '/');
});

it.each(['current', 'navigation', 'reset', 'other-account', 'privacy'])(
  'keeps a toast action with its session: %s',
  (change) => {
    const undo = vi.fn();
    toastUndo('Saved', undo);
    const action = (vi.mocked(toastManager.show).mock.calls[0][0].button as ToastButton).onclick;
    switch (change) {
      case 'navigation': {
        history.pushState({}, '', '/photos');
        break;
      }
      case 'reset': {
        authManager.reset();
        break;
      }
      case 'other-account': {
        authManager.setUser(userAdminFactory.build({ id: 'other' }));
        break;
      }
      // No default
    }
    if (change === 'privacy') {
      clearPrivateBrowserState();
    }
    action?.();
    expect(undo).toHaveBeenCalledTimes(change === 'current' || change === 'navigation' ? 1 : 0);
  },
);

it('preserves a live action label and timeout', () => {
  const open = vi.fn();
  toastAction('Merged', { label: 'Open', onAction: open, timeout: 4000 });
  expect(toastManager.show).toHaveBeenCalledWith(
    expect.objectContaining({ description: 'Merged', button: expect.objectContaining({ label: 'Open' }) }),
    { timeout: 4000 },
  );
  (vi.mocked(toastManager.show).mock.calls[0][0].button as ToastButton).onclick?.();
  expect(open).toHaveBeenCalledOnce();
});
