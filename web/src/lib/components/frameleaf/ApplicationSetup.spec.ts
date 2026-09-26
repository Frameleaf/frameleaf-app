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
    const { container } = render(ApplicationSetup, { tool: 'downloads' });

    expect(await screen.findByText(t.unavailable)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.download_android })).toBeDisabled();
    expect(container.querySelector('a[href*="immich"], a[href*="play.google"], a[href*="f-droid"]')).toBeNull();
  });

  it('downloads the configured signed build and shows its signing certificate', async () => {
    sdkMock.getAppReleases.mockResolvedValue(configured);
    render(ApplicationSetup, { tool: 'downloads' });

    const link = await screen.findByRole('link', { name: t.download_android });
    expect(link).toHaveAttribute('href', configured.android.links.universal);
    expect(screen.getByText(/AB:CD:EF/)).toBeInTheDocument();

    await fireEvent.change(screen.getByLabelText(t.platform), { target: { value: 'iOS' } });
    expect(screen.getByRole('link', { name: t.open_app_store })).toHaveAttribute('href', configured.ios.url);
  });

  it('generates an Obtainium configuration with new download-only access', async () => {
    sdkMock.getAppReleases.mockResolvedValue(configured);
    sdkMock.createApiKey.mockResolvedValue({
      secret: 'AbCdEfGhIjKlMnOpQrStUv0123456789',
      apiKey: { id: 'k', name: 'Obtainium updates', permissions: [], createdAt: '', updatedAt: '' },
    } as never);
    render(ApplicationSetup, { tool: 'obtainium' });

    expect(await screen.findByRole('button', { name: t.open_obtainium })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: t.create_access }));

    const link = await screen.findByRole('link', { name: t.open_obtainium });
    expect(sdkMock.createApiKey).toHaveBeenCalledWith({
      apiKeyCreateDto: { name: t.access_key_name, permissions: ['server.apkLinks'] },
    });
    const href = link.getAttribute('href')!;
    expect(href.startsWith('obtainium://app/')).toBe(true);
    const app = JSON.parse(decodeURIComponent(href.slice('obtainium://app/'.length)));
    expect(app).toMatchObject({ id: 'app.frameleaf.android', name: 'Frameleaf' });
    expect(app.url).toMatch(/\/api\/server\/apk-links$/);
    expect(screen.getByText(t.obtainium_attribution)).toBeInTheDocument();
  });

  it('keeps Obtainium unavailable without a signed Android release', async () => {
    sdkMock.getAppReleases.mockResolvedValue({ android: { available: false }, ios: { available: false } });
    render(ApplicationSetup, { tool: 'obtainium' });

    expect(await screen.findByText(t.unavailable)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.open_obtainium })).toBeDisabled();
    expect(screen.queryByRole('button', { name: t.create_access })).toBeNull();
  });
});
