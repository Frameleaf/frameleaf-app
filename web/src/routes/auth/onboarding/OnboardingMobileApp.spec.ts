import { getAppReleases, type ServerAppReleasesResponseDto } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import OnboardingMobileApp from './OnboardingMobileApp.svelte';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  getAppReleases: vi.fn(),
}));

const releases = (overrides: Partial<ServerAppReleasesResponseDto> = {}): ServerAppReleasesResponseDto => ({
  android: { available: false },
  ios: { available: false },
  ...overrides,
});

describe('OnboardingMobileApp store links (FL-135)', () => {
  beforeEach(() => {
    vi.mocked(getAppReleases).mockReset();
  });

  it('links the configured App Store and Android store listings', async () => {
    vi.mocked(getAppReleases).mockResolvedValue(
      releases({
        android: { available: false, storeUrl: 'https://play.google.com/store/apps/details?id=app.frameleaf' },
        ios: { available: true, url: 'https://apps.example.com/frameleaf' },
      }),
    );
    render(OnboardingMobileApp);

    const appStore = await screen.findByRole('link', { name: /frameleaf_onboarding_mobile_app_store\b/ });
    expect(appStore).toHaveAttribute('href', 'https://apps.example.com/frameleaf');
    expect(appStore).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByRole('link', { name: /frameleaf_onboarding_mobile_google_play\b/ })).toHaveAttribute(
      'href',
      'https://play.google.com/store/apps/details?id=app.frameleaf',
    );
  });

  it('names another Android store listing neutrally', async () => {
    vi.mocked(getAppReleases).mockResolvedValue(
      releases({ android: { available: false, storeUrl: 'https://f-droid.org/packages/app.frameleaf' } }),
    );
    render(OnboardingMobileApp);

    expect(await screen.findByRole('link', { name: /frameleaf_onboarding_mobile_android_store/ })).toHaveAttribute(
      'href',
      'https://f-droid.org/packages/app.frameleaf',
    );
  });

  it('hides store tiles that are not configured, or not https, and keeps the signed-release choices', async () => {
    vi.mocked(getAppReleases).mockResolvedValue(
      // eslint-disable-next-line unicorn/prefer-https -- an insecure destination must be refused
      releases({ ios: { available: true, url: 'http://apps.example.com/frameleaf' } }),
    );
    render(OnboardingMobileApp);

    await vi.waitFor(() => expect(getAppReleases).toHaveBeenCalled());
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /library_care_tool_downloads/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /library_care_tool_obtainium/ })).toBeInTheDocument();
  });

  it('offers no store when the release information cannot be read', async () => {
    vi.mocked(getAppReleases).mockRejectedValue(new Error('offline'));
    render(OnboardingMobileApp);

    await vi.waitFor(() => expect(getAppReleases).toHaveBeenCalled());
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
