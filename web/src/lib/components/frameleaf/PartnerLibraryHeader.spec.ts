import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { removePartner, updatePartner, UserAvatarColor, type PartnerResponseDto } from '@immich/sdk';
import en from '../../../../../i18n/en.json';
import PartnerLibraryHeader from './PartnerLibraryHeader.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  updatePartner: vi.fn(),
  removePartner: vi.fn(),
}));

const partner: PartnerResponseDto = {
  id: 'partner-1',
  name: 'Riley',
  email: 'riley@example.com',
  avatarColor: UserAvatarColor.Primary,
  profileImagePath: '',
  profileChangedAt: '2026-09-01T00:00:00.000Z',
  inTimeline: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('PartnerLibraryHeader', () => {
  it('turns on timeline inclusion through the real partner endpoint', async () => {
    vi.mocked(updatePartner).mockResolvedValue({ ...partner, inTimeline: true });
    render(PartnerLibraryHeader, { partner: { ...partner }, count: 3, onStopped: vi.fn() });

    const toggle = screen.getByRole('switch', { name: en.show_in_timeline });
    await fireEvent.click(toggle);

    expect(updatePartner).toHaveBeenCalledWith({ id: 'partner-1', partnerUpdateDto: { inTimeline: true } });
  });

  it('reverts optimistic state when the update fails', async () => {
    vi.mocked(updatePartner).mockRejectedValue(new Error('network'));
    render(PartnerLibraryHeader, { partner: { ...partner }, onStopped: vi.fn() });

    const toggle = screen.getByRole('switch', { name: en.show_in_timeline }) as HTMLInputElement;
    await fireEvent.click(toggle);

    await waitFor(() => expect(toggle.checked).toBe(false));
  });

  it('stops sharing through removePartner after confirmation and notifies the caller', async () => {
    vi.mocked(removePartner).mockResolvedValue();
    const onStopped = vi.fn();
    render(PartnerLibraryHeader, { partner: { ...partner }, onStopped });

    await fireEvent.click(screen.getByRole('button', { name: en.stop_sharing_photos_with_user }));
    await fireEvent.click(screen.getAllByRole('button', { name: en.stop_sharing_photos_with_user })[1]);

    expect(removePartner).toHaveBeenCalledWith({ id: 'partner-1' });
    await waitFor(() => expect(onStopped).toHaveBeenCalledOnce());
  });

  it('never renders a location-sharing control that has no backing endpoint', () => {
    render(PartnerLibraryHeader, { partner: { ...partner }, onStopped: vi.fn() });
    expect(screen.queryByText(/location/i)).toBeNull();
  });
});
