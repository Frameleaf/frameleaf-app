import { readDesktopMemberApproval, setDesktopMemberApproval } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import DesktopMemberApproval from '$lib/components/frameleaf/DesktopMemberApproval.svelte';
import en from '../../../../../i18n/en.json';

vi.mock('@frameleaf/sdk', () => ({ readDesktopMemberApproval: vi.fn(), setDesktopMemberApproval: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  addMessages('dev', en);
});

it('loads the account approval and changes it through the administrator API', async () => {
  vi.mocked(readDesktopMemberApproval).mockResolvedValue({ enabled: false });
  vi.mocked(setDesktopMemberApproval).mockResolvedValue({ enabled: true });
  render(DesktopMemberApproval, { userId: 'member' });
  const button = await screen.findByRole('button', { name: 'Allow desktop AI processing' });
  await fireEvent.click(button);
  await screen.findByRole('button', { name: 'Remove desktop AI approval' });
  expect(setDesktopMemberApproval).toHaveBeenCalledWith({ id: 'member', desktopMemberApprovalDto: { enabled: true } });
});

it('keeps approval unknown when reading fails and does not offer a blind mutation', async () => {
  vi.mocked(readDesktopMemberApproval).mockRejectedValue(new Error('offline'));
  render(DesktopMemberApproval, { userId: 'member' });
  await screen.findByText('Approval could not be loaded. Try again.');
  expect(screen.queryByRole('button', { name: 'Allow desktop AI processing' })).toBeNull();
  expect(setDesktopMemberApproval).not.toHaveBeenCalled();
});

it('keeps the last confirmed approval when an update fails', async () => {
  vi.mocked(readDesktopMemberApproval).mockResolvedValue({ enabled: true });
  vi.mocked(setDesktopMemberApproval).mockRejectedValue(new Error('denied'));
  render(DesktopMemberApproval, { userId: 'member' });
  await fireEvent.click(await screen.findByRole('button', { name: 'Remove desktop AI approval' }));
  await screen.findByText('Approval could not be changed. Try again.');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove desktop AI approval' })).toBeEnabled());
});

it('ignores a mutation response after switching to another account', async () => {
  let finish!: (value: { enabled: boolean }) => void;
  vi.mocked(readDesktopMemberApproval).mockResolvedValue({ enabled: false });
  vi.mocked(setDesktopMemberApproval).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(DesktopMemberApproval, { userId: 'member' });
  await fireEvent.click(await screen.findByRole('button', { name: 'Allow desktop AI processing' }));
  await view.rerender({ userId: 'other' });
  await screen.findByRole('button', { name: 'Allow desktop AI processing' });
  finish({ enabled: true });
  await tick();
  expect(screen.queryByRole('button', { name: 'Remove desktop AI approval' })).toBeNull();
});
