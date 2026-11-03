import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import MobileApps from '$lib/components/frameleaf/settings/utilities/MobileApps.svelte';
import en from '../../../../../../../i18n/en.json';

vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { externalDomain: 'https://photos.example.test' } },
}));
vi.mock('$lib/components/frameleaf/ApplicationSetup.svelte', () => ({ default: () => {} }));

describe('Mobile apps, first screen (FL-539)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => vi.clearAllMocks());

  it('offers the stores, a code with this server’s address, and the phones of this account', async () => {
    sdkMock.getAppReleases.mockResolvedValue({
      ios: { available: true, url: 'https://apps.apple.com/app/frameleaf' },
      android: { available: false, storeUrl: 'https://play.google.com/store/apps/details?id=app.frameleaf' },
    });
    sdkMock.listBackupDevices.mockResolvedValue({
      devices: [
        {
          id: 'p1',
          displayName: 'Taylor’s iPhone',
          model: 'iPhone 16',
          platform: 'iOS',
          quietForDays: 0,
          lastSuccessfulBackupAt: new Date().toISOString(),
        },
      ],
      nextOffset: null,
    } as never);
    render(MobileApps);

    expect(await screen.findByRole('heading', { name: 'Your phones are backing up' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get it on the App Store' })).toHaveAttribute(
      'href',
      'https://apps.apple.com/app/frameleaf',
    );
    expect(screen.getByRole('link', { name: 'Get it on Google Play' })).toBeInTheDocument();
    expect(screen.getByText('https://photos.example.test')).toBeInTheDocument();
    expect(screen.getByText('Taylor’s iPhone')).toBeInTheDocument();
    expect(screen.getByText('Advanced: install without a store')).toBeInTheDocument();
  });

  it('says no phone is connected yet', async () => {
    sdkMock.getAppReleases.mockResolvedValue({ ios: { available: false }, android: { available: false } });
    sdkMock.listBackupDevices.mockResolvedValue({ devices: [], nextOffset: null });
    render(MobileApps);

    expect(await screen.findByRole('heading', { name: 'No phone is connected yet' })).toBeInTheDocument();
    expect(screen.getByText('No phones yet')).toBeInTheDocument();
  });
});
