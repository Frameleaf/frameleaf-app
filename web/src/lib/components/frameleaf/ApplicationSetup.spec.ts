import { render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../i18n/en.json';
import ApplicationSetup from './ApplicationSetup.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const t = en.frameleaf_apps;

beforeEach(() => {
  addMessages('dev', en);
  vi.resetAllMocks();
});

const configured = {
  android: {
    available: true,
    appId: 'app.frameleaf.android',
    signingCertificateSha256: 'AB:CD:EF',
    links: {
      arm64v8a: 'https://releases.example.test/3.2.0/app-arm64-v8a-release.apk',
      armeabiv7a: 'https://releases.example.test/3.2.0/app-armeabi-v7a-release.apk',
      universal: 'https://releases.example.test/3.2.0/app-release.apk',
      x86_64: 'https://releases.example.test/3.2.0/app-x86_64-release.apk',
    },
  },
  ios: { available: true, url: 'https://apps.apple.com/app/id000' },
};

describe('ApplicationSetup', () => {
  it('says no signed release is available and offers no download when none is configured', async () => {
    sdkMock.getAppReleases.mockResolvedValue({ android: { available: false }, ios: { available: false } });
    const { container } = render(ApplicationSetup);

    expect(await screen.findByText(t.unavailable)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.download_android })).toBeDisabled();
    expect(container.querySelector('a[href*="immich"], a[href*="play.google"], a[href*="f-droid"]')).toBeNull();
  });

  it('downloads the configured signed build and shows its signing certificate', async () => {
    sdkMock.getAppReleases.mockResolvedValue(configured);
    render(ApplicationSetup);

    const link = await screen.findByRole('link', { name: t.download_android });
    expect(link).toHaveAttribute('href', configured.android.links.universal);
    expect(screen.getByText(/AB:CD:EF/)).toBeInTheDocument();

    await fireEvent.change(screen.getByLabelText(t.platform), { target: { value: 'iOS' } });
    expect(screen.getByRole('link', { name: t.open_app_store })).toHaveAttribute('href', configured.ios.url);
  });
});
