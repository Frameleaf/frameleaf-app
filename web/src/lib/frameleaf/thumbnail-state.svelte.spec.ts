import { ProcessingFailureStep } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { cantShowPhoto, isGettingReady, thumbnailFailures } from '$lib/frameleaf/thumbnail-state.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';

/** FL-1409 (M5): "Getting this photo ready" is only for a photo still waiting for its thumbnail. */
describe('a photo with no thumbnail yet (FL-1409)', () => {
  const photo = { id: 'photo-1', thumbhash: null };

  beforeEach(() => {
    vi.resetAllMocks();
    thumbnailFailures.ids.clear();
    vi.spyOn(authManager, 'authenticated', 'get').mockReturnValue(true);
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(false);
  });

  it('is getting ready when nothing says its thumbnail can’t be made', () => {
    expect(isGettingReady(photo)).toBe(true);
    expect(cantShowPhoto(photo)).toBe(false);
  });

  it('is ready once it has a thumbhash', () => {
    expect(isGettingReady({ ...photo, thumbhash: 'abc' })).toBe(false);
  });

  it('can’t be shown when its file is missing from its external library', () => {
    expect(cantShowPhoto({ ...photo, isOffline: true })).toBe(true);
    expect(isGettingReady({ ...photo, isOffline: true })).toBe(false);
  });

  it('can’t be shown when its thumbnail failed, was set aside or was stopped', async () => {
    sdkMock.getProcessingFailures.mockResolvedValue([{ assetId: 'photo-1' }] as never);
    thumbnailFailures.check(Date.now() + 120_000);
    await vi.waitFor(() => expect(cantShowPhoto(photo)).toBe(true));
    expect(isGettingReady(photo)).toBe(false);
    // The thumbnail step only, and the photos somebody chose to keep as they are or to stop trying.
    expect(sdkMock.getProcessingFailures).toHaveBeenCalledWith(
      expect.objectContaining({ step: ProcessingFailureStep.AssetGenerateThumbnails, includeDismissed: true }),
    );
  });

  it('is getting ready again once the server no longer lists it', async () => {
    thumbnailFailures.ids.add('photo-1');
    sdkMock.getProcessingFailures.mockResolvedValue([]);
    thumbnailFailures.check(Date.now() + 240_000);
    await vi.waitFor(() => expect(isGettingReady(photo)).toBe(true));
  });

  it('asks again soon after a read that failed, not a minute later', async () => {
    const now = Date.now() + 600_000;
    sdkMock.getProcessingFailures.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
    thumbnailFailures.check(now);
    await vi.waitFor(() => expect(sdkMock.getProcessingFailures).toHaveBeenCalledTimes(1));
    // The answer has been handled once a later tile can ask.
    await vi.waitFor(() => {
      thumbnailFailures.check(Date.now() + 15_000);
      expect(sdkMock.getProcessingFailures).toHaveBeenCalledTimes(2);
    });
  });

  it('never asks for the list on a shared link', () => {
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    thumbnailFailures.check(Date.now() + 360_000);
    expect(sdkMock.getProcessingFailures).not.toHaveBeenCalled();
  });
});
