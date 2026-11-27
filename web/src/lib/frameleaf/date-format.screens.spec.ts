import { DisplayDateFormat, DisplayHourCycle, type HouseholdLinkDto } from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { get } from 'svelte/store';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LinkedHouseholds from '$lib/components/frameleaf/households/LinkedHouseholds.svelte';
import { formatHistoryDate } from '$lib/frameleaf/account-history';
import { formatDateTime as cloudDateTime } from '$lib/frameleaf/cloud-ml';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getAltText } from '$lib/utils/thumbnail-util';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../i18n/en.json';

vi.mock('$lib/managers/cloud-manager.svelte', () => ({
  cloudManager: { status: null, license: null, listen: () => () => {} },
}));

/**
 * FL-1805: screens that used to format dates themselves now follow the account's "Date format" and
 * "Time format". Each of these showed the browser's own order before, whatever the account chose.
 */
describe('screens follow day-month-year and the 24-hour clock (FL-1805)', () => {
  const choose = (dateFormat: DisplayDateFormat, hourCycle: DisplayHourCycle) => {
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build({ display: { dateFormat, hourCycle } }));
  };

  beforeAll(() => addMessages('dev', en));
  beforeEach(() => choose(DisplayDateFormat.Dmy, DisplayHourCycle.H23));
  afterEach(() => authManager.reset());

  it('Linked households: the day a household was linked', async () => {
    sdkMock.getHouseholdLinks.mockResolvedValue([
      {
        id: 'link-1',
        active: true,
        paused: false,
        ended: false,
        state: 'active',
        reason: null,
        connectionPath: 'local',
        createdAt: '2026-10-12T12:00:00.000Z',
        endedAt: null,
        householdName: 'Rivera',
        peerName: 'Rivera Home',
        lastSeenAt: new Date().toISOString(),
      } as HouseholdLinkDto,
    ]);
    render(LinkedHouseholds);
    expect(await screen.findByText('Rivera Home · Linked 12 October 2026')).toBeInTheDocument();
  });

  it('People with an account: when someone joined', () => {
    expect(formatHistoryDate('2026-09-23T12:00:00.000Z', 'en-US')).toBe('23 Sep 2026');
  });

  it('Cloud processing: when a job ran, on the 24-hour clock', () => {
    const at = new Date(2026, 10, 1, 14, 30).toISOString();
    expect(cloudDateTime(at, 'en-US')).toBe('1 Nov 2026, 14:30');
  });

  it('a photo’s description for screen readers', () => {
    const alt = get(getAltText)({
      localDateTime: { year: 2026, month: 11, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      people: [],
      isImage: true,
    } as never);
    expect(alt).toContain('1 November 2026');
  });

  it('shows what it always showed to an account that never chose a format', () => {
    choose(DisplayDateFormat.Auto, DisplayHourCycle.Auto);
    expect(formatHistoryDate('2026-09-23T12:00:00.000Z', 'en-US')).toBe('Sep 23, 2026');
    const at = new Date(2026, 10, 1, 14, 30);
    expect(cloudDateTime(at.toISOString(), 'en-US')).toBe(
      new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(at),
    );
  });
});
