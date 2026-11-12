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
});
