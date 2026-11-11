import { DisplayDateFormat, DisplayHourCycle } from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { locale } from '$lib/stores/preferences.store';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import DetailPanelDate from './DetailPanelDate.svelte';

// UI review 2026-11-10, A5: the prototype's two lines, without seconds or a GMT offset.
describe('DetailPanelDate', () => {
  beforeEach(() => {
    locale.set('en-US');
    authManager.setUser(userAdminFactory.build({ id: 'owner' }));
    authManager.setPreferences(preferencesFactory.build());
  });

  it('writes the day, then the time with the zone’s name, for a photo that has a time zone', () => {
    const asset = assetFactory.build({
      ownerId: 'owner',
      localDateTime: '2026-08-22T10:31:00.000Z',
      exifInfo: { dateTimeOriginal: '2026-08-22T16:31:00.000Z', timeZone: 'America/Edmonton' },
    });
    render(DetailPanelDate, { asset });

    expect(screen.getByTestId('detail-panel-date')).toHaveTextContent(/^Sat, Aug 22, 2026$/);
    expect(screen.getByTestId('detail-panel-time')).toHaveTextContent(/^10:31\sAM · America\/Edmonton$/);
    expect(screen.getByTestId('detail-panel-edit-date-button')).not.toHaveTextContent(/GMT|:00\s/);
  });

  it('writes the day and the time alone for a photo without a time zone', () => {
    const asset = assetFactory.build({
      ownerId: 'owner',
      localDateTime: '2026-08-16T07:14:00.000Z',
      exifInfo: { dateTimeOriginal: '2026-08-16T07:14:00.000Z', timeZone: null },
    });
    render(DetailPanelDate, { asset });

    expect(screen.getByTestId('detail-panel-date')).toHaveTextContent(/^Sun, Aug 16, 2026$/);
    expect(screen.getByTestId('detail-panel-time')).toHaveTextContent(/^7:14\sAM$/);
  });

  // FL-783: the lines follow the date and time format chosen in Your preferences.
  it('follows the person’s date and time format', () => {
    authManager.setPreferences(
      preferencesFactory.build({ display: { dateFormat: DisplayDateFormat.Dmy, hourCycle: DisplayHourCycle.H23 } }),
    );
    const asset = assetFactory.build({
      ownerId: 'owner',
      localDateTime: '2026-08-22T19:31:00.000Z',
      exifInfo: { dateTimeOriginal: '2026-08-23T01:31:00.000Z', timeZone: 'America/Edmonton' },
    });
    render(DetailPanelDate, { asset });

    expect(screen.getByTestId('detail-panel-date')).toHaveTextContent(/^Sat, 22 Aug 2026$/);
    expect(screen.getByTestId('detail-panel-time')).toHaveTextContent(/^19:31 · America\/Edmonton$/);
  });
});
