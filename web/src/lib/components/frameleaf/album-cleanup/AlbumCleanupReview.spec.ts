import { AlbumChangeRunStatus, type AlbumCleanupFactsDto, type UserPreferencesResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AlbumCleanupReview from '$lib/components/frameleaf/album-cleanup/AlbumCleanupReview.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';

const fact = (id: string, name: string, count = 3) => ({
  id,
  name,
  count,
  createdAt: '2020-01-01T00:00:00.000Z',
  locked: false,
  shared: false,
  parentId: null,
  readOnly: false,
  gps: null,
  span: null,
  coverAssetId: null,
});

const snapshot = (facts: Partial<AlbumCleanupFactsDto> = {}) => ({
  ready: true,
  checking: false,
  computedAt: '2026-11-08T00:00:00.000Z',
  suggestionCount: 3,
  facts: {
    albums: [fact('a', 'Friends - Patrick', 5), fact('b', 'Friends - Patrick', 2), fact('c', 'Friends - Sarah')],
    collections: [],
    sameName: [{ key: 'friends - patrick', albumIds: ['a', 'b'], winnerId: 'a', union: 6 }],
    samePhotos: [],
    sameTrip: [],
    homeAreas: [],
    lostDates: [],
    healSkipped: 0,
    ...facts,
  },
});

const idleStatus = {
  ready: true,
  checking: false,
  computedAt: '2026-11-08T00:00:00.000Z',
  suggestionCount: 3,
  apply: null,
};

const preferences = { albums: { cleanupBannerDismissed: false } } as unknown as UserPreferencesResponseDto;

describe(AlbumCleanupReview.name, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authManager, 'preferences', 'get').mockReturnValue(preferences);
    vi.spyOn(authManager, 'setPreferences').mockImplementation(() => {});
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    sdkMock.getAlbumCleanupSnapshot.mockResolvedValue(snapshot());
    sdkMock.getAlbumCleanupStatus.mockResolvedValue(idleStatus);
    sdkMock.updateMyPreferences.mockResolvedValue(preferences);
  });

  it('opens with the owner’s text and nothing changed', async () => {
    render(AlbumCleanupReview);
    expect(await screen.findByText('frameleaf_album_cleanup_intro')).toBeInTheDocument();
    expect(sdkMock.applyAlbumCleanup).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: /frameleaf_album_cleanup_tab_structure/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('sends explicit operations and follows the job to the finished screen', async () => {
    const runId = '0194d6a5-7a6e-7c2a-9cb4-0a1c2d3e4f50';
    sdkMock.applyAlbumCleanup.mockResolvedValue({ runId });
    sdkMock.getAlbumCleanupStatus
      .mockResolvedValueOnce(idleStatus)
      .mockResolvedValue({ ...idleStatus, apply: { runId, status: AlbumChangeRunStatus.Done, done: 3, total: 3 } });

    render(AlbumCleanupReview);
    await fireEvent.click(await screen.findByText('frameleaf_album_cleanup_apply'));

    await waitFor(() => expect(sdkMock.applyAlbumCleanup).toHaveBeenCalledOnce());
    const [{ albumCleanupApplyDto }] = sdkMock.applyAlbumCleanup.mock.calls[0];
    expect(albumCleanupApplyDto.operations).toContainEqual({ type: 'merge', albumIds: ['a', 'b'], allowShared: false });
    expect(await screen.findByText('frameleaf_album_cleanup_done_title', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('shows Undo on the finished screen', async () => {
    const runId = '0194d6a5-7a6e-7c2a-9cb4-0a1c2d3e4f50';
    sdkMock.applyAlbumCleanup.mockResolvedValue({ runId });
    sdkMock.getAlbumCleanupStatus
      .mockResolvedValueOnce(idleStatus)
      .mockResolvedValue({ ...idleStatus, apply: { runId, status: AlbumChangeRunStatus.Done, done: 3, total: 3 } });
    sdkMock.undoLatestAlbumChangeRun.mockResolvedValue({ reversed: 3, skipped: [] });

    render(AlbumCleanupReview);
    await fireEvent.click(await screen.findByText('frameleaf_album_cleanup_apply'));
    await fireEvent.click(await screen.findByText('frameleaf_album_cleanup_undo', {}, { timeout: 3000 }));

    await waitFor(() => expect(sdkMock.undoLatestAlbumChangeRun).toHaveBeenCalledOnce());
    expect(await screen.findByText('frameleaf_album_cleanup_intro')).toBeInTheDocument();
  });

  it('says it is still reading when the first scan has not finished', async () => {
    sdkMock.getAlbumCleanupSnapshot.mockResolvedValue({
      ready: false,
      checking: true,
      computedAt: null,
      suggestionCount: 0,
      facts: null,
    });
    render(AlbumCleanupReview);
    expect(await screen.findByText('frameleaf_album_cleanup_scanning')).toBeInTheDocument();
  });

  describe('looking again (FL-1404)', () => {
    /** What the server holds from before any album existed, while it looks again. */
    const emptyAndChecking = { ...snapshot({ albums: [], sameName: [] }), suggestionCount: 0, checking: true };
    const fresh = { ...snapshot(), computedAt: '2026-11-10T23:05:00.000Z' };

    it('says when it last looked and offers to check again', async () => {
      render(AlbumCleanupReview);
      expect(await screen.findByText('frameleaf_album_cleanup_checked')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'frameleaf_album_cleanup_check_again' })).toBeEnabled();
    });

    it('says it is looking, not that there is nothing to do, then shows what the new look found', async () => {
      sdkMock.getAlbumCleanupSnapshot.mockResolvedValueOnce(emptyAndChecking).mockResolvedValue(fresh);
      vi.useFakeTimers();
      try {
        render(AlbumCleanupReview);
        await vi.waitFor(() => expect(screen.getByText('frameleaf_album_cleanup_scanning')).toBeInTheDocument());
        expect(screen.queryByText('frameleaf_album_cleanup_intro')).not.toBeInTheDocument();
        expect(screen.queryByText('frameleaf_album_cleanup_no_groups')).not.toBeInTheDocument();

        await vi.advanceTimersByTimeAsync(3000);
        await vi.waitFor(() => expect(screen.getByText('frameleaf_album_cleanup_intro')).toBeInTheDocument());
        expect(screen.queryByText('frameleaf_album_cleanup_scanning')).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows the first newer result even when another look is already waiting', async () => {
      sdkMock.getAlbumCleanupSnapshot
        .mockResolvedValueOnce(emptyAndChecking)
        .mockResolvedValue({ ...fresh, checking: true });
      vi.useFakeTimers();
      try {
        render(AlbumCleanupReview);
        await vi.waitFor(() => expect(screen.getByText('frameleaf_album_cleanup_scanning')).toBeInTheDocument());
        await vi.advanceTimersByTimeAsync(3000);
        await vi.waitFor(() => expect(screen.getByText('frameleaf_album_cleanup_intro')).toBeInTheDocument());
      } finally {
        vi.useRealTimers();
      }
    });

    it('starts a new look on Check again and waits for it', async () => {
      render(AlbumCleanupReview);
      const button = await screen.findByRole('button', { name: 'frameleaf_album_cleanup_check_again' });
      sdkMock.getAlbumCleanupSnapshot.mockResolvedValue({ ...snapshot(), checking: true });
      await fireEvent.click(button);

      expect(await screen.findByText('frameleaf_album_cleanup_scanning')).toBeInTheDocument();
      expect(sdkMock.checkAlbumCleanup).toHaveBeenCalledOnce();
      expect(screen.queryByText('frameleaf_album_cleanup_intro')).not.toBeInTheDocument();
    });

    it('keeps the suggestions on screen when a new look cannot be started', async () => {
      sdkMock.checkAlbumCleanup.mockRejectedValueOnce(new Error('offline'));
      render(AlbumCleanupReview);
      await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_album_cleanup_check_again' }));
      await waitFor(() => expect(sdkMock.checkAlbumCleanup).toHaveBeenCalledOnce());
      expect(screen.getByText('frameleaf_album_cleanup_intro')).toBeInTheDocument();
    });
  });

  it('offers to try again when the suggestions cannot be read', async () => {
    sdkMock.getAlbumCleanupSnapshot.mockRejectedValueOnce(new Error('offline'));
    render(AlbumCleanupReview);
    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_album_cleanup_try_again' }));
    await waitFor(() => expect(sdkMock.getAlbumCleanupSnapshot).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'frameleaf_album_cleanup_try_again' })).not.toBeInTheDocument(),
    );
  });

  it('stops asking once the page has closed, even with a request still out', async () => {
    let answer: (value: Awaited<ReturnType<typeof sdkMock.getAlbumCleanupSnapshot>>) => void = () => {};
    sdkMock.getAlbumCleanupSnapshot.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { unmount } = render(AlbumCleanupReview);
    await waitFor(() => expect(sdkMock.getAlbumCleanupSnapshot).toHaveBeenCalledTimes(1));
    unmount();
    vi.useFakeTimers();
    try {
      answer({ ready: false, checking: true, computedAt: null, suggestionCount: 0, facts: null });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sdkMock.getAlbumCleanupSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders for a person with no located photos', async () => {
    render(AlbumCleanupReview);
    await screen.findByText('frameleaf_album_cleanup_intro');
    await fireEvent.click(screen.getByRole('tab', { name: /frameleaf_album_cleanup_tab_days/ }));
    expect(screen.getByText('frameleaf_album_cleanup_no_trips')).toBeInTheDocument();
  });
});
