import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import DesktopHousehold from '$lib/components/frameleaf/computers/DesktopHousehold.svelte';
import en from '../../../../../../i18n/en.json';

const office = {
  id: 'office',
  name: 'Office PC',
  platform: 'windows' as const,
  ready: true,
  lastSeenAt: null,
  ownerName: 'Taylor',
  household: false,
};

describe('DesktopHousehold (FL-1484)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("lets a computer work on everyone's photos at home", async () => {
    sdkMock.setDesktopHousehold.mockResolvedValue({ enabled: true });
    const onChanged = vi.fn();
    render(DesktopHousehold, { desktops: [office], onChanged });

    const choice = screen.getByRole('group', { name: 'Whose photos Office PC works on' });
    expect(within(choice).getByRole('button', { name: 'Only Taylor’s' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Only the photos of Taylor, the account signed in on it.')).toBeInTheDocument();

    await fireEvent.click(within(choice).getByRole('button', { name: 'Everyone’s' }));
    expect(sdkMock.setDesktopHousehold).toHaveBeenCalledWith({ id: 'office', desktopHouseholdDto: { enabled: true } });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('says so when the change could not be saved', async () => {
    sdkMock.setDesktopHousehold.mockRejectedValue(new Error('offline'));
    render(DesktopHousehold, { desktops: [{ ...office, household: true }], onChanged: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Only Taylor’s' }));
    expect(await screen.findByText('That change couldn’t be saved. Try again.')).toBeInTheDocument();
  });

  describe('playback copies (FL-1761)', () => {
    const copies = 'Playback copies of videos on Office PC';
    const others = 'Include other people’s videos on Office PC';

    it('is off by default and turns on without other people’s videos', async () => {
      sdkMock.setDesktopTranscode.mockResolvedValue({ enabled: true, everyone: false });
      const onChanged = vi.fn();
      render(DesktopHousehold, { desktops: [{ ...office, household: true }], onChanged });

      expect(screen.getByRole('switch', { name: copies })).not.toBeChecked();
      expect(screen.queryByRole('switch', { name: others })).toBeNull();

      await fireEvent.click(screen.getByRole('switch', { name: copies }));
      expect(sdkMock.setDesktopTranscode).toHaveBeenCalledWith({
        id: 'office',
        desktopTranscodeSettingsDto: { enabled: true, everyone: false },
      });
      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('offers other people’s videos only when on and working on everyone’s photos', () => {
      const { unmount } = render(DesktopHousehold, {
        desktops: [{ ...office, transcodeEnabled: true }],
        onChanged: vi.fn(),
      });
      expect(screen.queryByRole('switch', { name: others })).toBeNull();
      unmount();

      render(DesktopHousehold, {
        desktops: [{ ...office, household: true, transcodeEnabled: true }],
        onChanged: vi.fn(),
      });
      expect(screen.getByRole('switch', { name: others })).not.toBeChecked();
      expect(screen.getByText(/Off: only Taylor’s videos\./)).toBeInTheDocument();
    });

    it('clears other people’s videos when turned off', async () => {
      sdkMock.setDesktopTranscode.mockResolvedValue({ enabled: false, everyone: false });
      render(DesktopHousehold, {
        desktops: [{ ...office, household: true, transcodeEnabled: true, transcodeEveryone: true }],
        onChanged: vi.fn(),
      });

      await fireEvent.click(screen.getByRole('switch', { name: copies }));
      expect(sdkMock.setDesktopTranscode).toHaveBeenCalledWith({
        id: 'office',
        desktopTranscodeSettingsDto: { enabled: false, everyone: false },
      });
    });

    it('shows the video it is working on', () => {
      render(DesktopHousehold, {
        desktops: [{ ...office, transcodeEnabled: true, transcoding: { fileName: 'Beach day.mov', progress: 42 } }],
        onChanged: vi.fn(),
      });
      expect(screen.getByText('Working on')).toBeInTheDocument();
      expect(screen.getByText('Beach day.mov')).toBeInTheDocument();
      expect(screen.getByText('Making a playback copy, 42% done')).toBeInTheDocument();
    });

    it('does not name a private video', () => {
      render(DesktopHousehold, {
        desktops: [{ ...office, transcodeEnabled: true, transcoding: { fileName: null, progress: 7 } }],
        onChanged: vi.fn(),
      });
      expect(screen.getByText('A private video')).toBeInTheDocument();
    });
  });
});
