import {
  getPartners,
  PartnerDirection,
  removePartner,
  updatePartner,
  UserAvatarColor,
  type PartnerResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { eventManager } from '$lib/managers/event-manager.svelte';
import en from '../../../../../i18n/en.json';
import PartnerLibraryHeader from './PartnerLibraryHeader.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'me', name: 'Me', email: 'me@example.com' }, params: {} },
}));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getPartners: vi.fn(),
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

/** the same user seen from my side: I share my library with them */
const sharedBack: PartnerResponseDto = { ...partner, inTimeline: true, shareLocation: true };

const locationSwitchName = en.frameleaf_sharing.share_location_title;

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  vi.mocked(getPartners).mockResolvedValue([]);
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
    vi.mocked(removePartner).mockResolvedValue(undefined as never);
    const onStopped = vi.fn();
    render(PartnerLibraryHeader, { partner: { ...partner }, onStopped });

    await fireEvent.click(screen.getByRole('button', { name: en.stop_sharing_photos_with_user }));
    await fireEvent.click(screen.getAllByRole('button', { name: en.stop_sharing_photos_with_user })[1]);

    expect(removePartner).toHaveBeenCalledWith({ id: 'partner-1' });
    await waitFor(() => expect(onStopped).toHaveBeenCalledOnce());
  });

  it('tells this tab’s open pages that sharing stopped (FL-54)', async () => {
    vi.mocked(removePartner).mockResolvedValue(undefined as never);
    const emit = vi.spyOn(eventManager, 'emit');
    render(PartnerLibraryHeader, { partner: { ...partner }, onStopped: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: en.stop_sharing_photos_with_user }));
    await fireEvent.click(screen.getAllByRole('button', { name: en.stop_sharing_photos_with_user })[1]);

    await waitFor(() =>
      expect(emit).toHaveBeenCalledWith('PartnerRevoke', { sharedById: 'me', sharedWithId: 'partner-1' }),
    );
  });

  describe('location sharing', () => {
    it('offers the switch, on by default, only when I share my library back with this partner', async () => {
      vi.mocked(getPartners).mockResolvedValue([sharedBack]);
      render(PartnerLibraryHeader, { partner: { ...partner }, onStopped: vi.fn() });

      const toggle = (await screen.findByRole('switch', { name: locationSwitchName })) as HTMLInputElement;

      expect(getPartners).toHaveBeenCalledWith({ direction: PartnerDirection.SharedBy });
      expect(toggle.checked).toBe(true);
      expect(screen.queryByText(en.frameleaf_sharing.location_already_seen.replace('{name}', 'Riley'))).toBeNull();
    });

    it('explains why there is no switch when I do not share my library with this partner', async () => {
      vi.mocked(getPartners).mockResolvedValue([{ ...sharedBack, id: 'someone-else' }]);
      render(PartnerLibraryHeader, { partner: { ...partner }, onStopped: vi.fn() });

      await screen.findByText(en.frameleaf_sharing.location_not_sharing_back.replace('{name}', 'Riley'));
      expect(screen.queryByRole('switch', { name: locationSwitchName })).toBeNull();
    });

    it('turns location sharing off on my own sharing relation and warns that locations were already visible', async () => {
      vi.mocked(getPartners).mockResolvedValue([sharedBack]);
      vi.mocked(updatePartner).mockResolvedValue({ ...sharedBack, shareLocation: false });
      render(PartnerLibraryHeader, { partner: { ...partner }, onStopped: vi.fn() });

      const toggle = (await screen.findByRole('switch', { name: locationSwitchName })) as HTMLInputElement;
      await fireEvent.click(toggle);

      // the sharer's setting goes through the same endpoint with only shareLocation set
      expect(updatePartner).toHaveBeenCalledWith({ id: 'partner-1', partnerUpdateDto: { shareLocation: false } });
      await waitFor(() => expect(toggle.checked).toBe(false));
      await screen.findByText(en.frameleaf_sharing.location_already_seen.replace('{name}', 'Riley'));
      // the browsed relation itself is untouched
      expect(updatePartner).not.toHaveBeenCalledWith(
        expect.objectContaining({ partnerUpdateDto: expect.objectContaining({ inTimeline: expect.anything() }) }),
      );
    });

    it('reverts the location switch when the update fails', async () => {
      vi.mocked(getPartners).mockResolvedValue([sharedBack]);
      vi.mocked(updatePartner).mockRejectedValue(new Error('network'));
      render(PartnerLibraryHeader, { partner: { ...partner }, onStopped: vi.fn() });

      const toggle = (await screen.findByRole('switch', { name: locationSwitchName })) as HTMLInputElement;
      await fireEvent.click(toggle);

      await waitFor(() => expect(toggle.checked).toBe(true));
    });
  });
});
