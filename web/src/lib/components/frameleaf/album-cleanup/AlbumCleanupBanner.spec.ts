import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AlbumCleanupBanner from '$lib/components/frameleaf/album-cleanup/AlbumCleanupBanner.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import type { AlbumCleanupFactsDto, UserPreferencesResponseDto } from '@frameleaf/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const facts = (count: number): AlbumCleanupFactsDto => ({
  albums: Array.from({ length: count }, (_, index) => ({
    id: `album-${index}`,
    name: `Friends - Person ${index}`,
    count: 3,
    createdAt: '2020-01-01T00:00:00.000Z',
    locked: false,
    shared: false,
    gps: null,
    span: null,
    coverAssetId: null,
  })),
  collections: [],
  sameName: [],
  samePhotos: [],
  sameTrip: [],
  homeAreas: [],
  lostDates: [],
  healSkipped: 0,
});

const preferences = (cleanupBannerDismissed: boolean) =>
  ({ albums: { cleanupBannerDismissed } }) as unknown as UserPreferencesResponseDto;

describe(AlbumCleanupBanner.name, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authManager, 'authenticated', 'get').mockReturnValue(true);
    vi.spyOn(authManager, 'preferences', 'get').mockReturnValue(preferences(false));
    sdkMock.getAlbumCleanupStatus.mockResolvedValue({
      ready: true,
      computedAt: '2026-11-08T00:00:00.000Z',
      suggestionCount: 40,
      apply: null,
    });
    sdkMock.getAlbumCleanupSnapshot.mockResolvedValue({
      ready: true,
      computedAt: '2026-11-08T00:00:00.000Z',
      suggestionCount: 40,
      facts: facts(40),
    });
  });

  it('shows live numbers when the scan found enough to mention', async () => {
    render(AlbumCleanupBanner);
    expect(await screen.findByRole('complementary', { name: 'frameleaf_album_cleanup_magic_albums' })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_album_cleanup_review_suggestions')).toBeInTheDocument();
    expect(sdkMock.getAlbumCleanupSnapshot).toHaveBeenCalledOnce();
  });

  it('says nothing for a clean or small library', async () => {
    sdkMock.getAlbumCleanupStatus.mockResolvedValue({
      ready: true,
      computedAt: '2026-11-08T00:00:00.000Z',
      suggestionCount: 19,
      apply: null,
    });
    render(AlbumCleanupBanner);
    await waitFor(() => expect(sdkMock.getAlbumCleanupStatus).toHaveBeenCalled());
    flushSync();
    expect(sdkMock.getAlbumCleanupSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByText('frameleaf_album_cleanup_review_suggestions')).not.toBeInTheDocument();
  });

  it('stays quiet after Not now', () => {
    vi.spyOn(authManager, 'preferences', 'get').mockReturnValue(preferences(true));
    render(AlbumCleanupBanner);
    expect(sdkMock.getAlbumCleanupStatus).not.toHaveBeenCalled();
  });

  it('remembers Not now', async () => {
    const setPreferences = vi.spyOn(authManager, 'setPreferences').mockImplementation(() => {});
    sdkMock.updateMyPreferences.mockResolvedValue(preferences(true));
    render(AlbumCleanupBanner);
    const button = await screen.findByText('frameleaf_album_cleanup_not_now');
    button.click();
    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: { albums: { cleanupBannerDismissed: true } },
      }),
    );
    await waitFor(() => expect(setPreferences).toHaveBeenCalled());
  });
});
