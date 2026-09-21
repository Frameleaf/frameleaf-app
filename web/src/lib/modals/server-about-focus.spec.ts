import { render, screen, waitFor } from '@testing-library/svelte';
import ServerAboutModal from './ServerAboutModal.svelte';

it('initially focuses the About dialog instead of activating a close-button tooltip', async () => {
  render(ServerAboutModal, {
    onClose: vi.fn(),
    info: { version: 'v3.2.0', versionUrl: '', licensed: false },
    versions: [],
  });
  await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
});
