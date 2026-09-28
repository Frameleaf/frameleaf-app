import { vitest } from 'vitest';
import { defaults } from 'src/config.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobName } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { replaceLockedProfileImages } from 'src/utils/profile-image.js';

/**
 * Owner decision 2, September 22, 2026 (FL-53): a profile picture copied from a photo that becomes
 * Locked is replaced by a copy of another photo, or reset to the default avatar when there is none.
 */
describe(replaceLockedProfileImages.name, () => {
  const lockedAssetId = 'locked-asset-id';
  const source = { id: 'user-id', profileImagePath: '/profile/user-id/old.webp', profileImageAssetId: lockedAssetId };
  const replacement = { id: 'best-photo-id', path: '/thumbs/preview.jpeg' };

  const setup = () => {
    // profile pictures are written under the media location, as the server sets it at startup
    StorageCore.setMediaLocation('/data');
    const repos = {
      media: { generateThumbnail: vitest.fn().mockResolvedValue(undefined) } as unknown as MediaRepository,
      crypto: { randomUUID: vitest.fn().mockReturnValue('new-picture') } as unknown as CryptoRepository,
      storageCore: { ensureFolders: vitest.fn() } as unknown as StorageCore,
      user: {
        getLockedProfileImageSources: vitest.fn().mockResolvedValue([source]),
        getProfileImageReplacement: vitest.fn().mockResolvedValue(replacement),
        replaceLockedProfileImage: vitest.fn().mockResolvedValue(true),
      },
      job: { queue: vitest.fn().mockResolvedValue(undefined) },
      logger: { warn: vitest.fn() },
    };
    return repos;
  };

  it('copies the replacement photo and removes the picture copied from the Locked photo', async () => {
    const repos = setup();

    await replaceLockedProfileImages(repos, () => Promise.resolve(defaults));

    expect(repos.user.getProfileImageReplacement).toHaveBeenCalledWith('user-id');
    expect(repos.media.generateThumbnail).toHaveBeenCalledWith(
      '/thumbs/preview.jpeg',
      expect.objectContaining({ processInvalidImages: false }),
      expect.stringContaining('new-picture'),
    );
    expect(repos.user.replaceLockedProfileImage).toHaveBeenCalledWith('user-id', lockedAssetId, {
      profileImagePath: expect.stringContaining('new-picture'),
      profileImageAssetId: 'best-photo-id',
    });
    expect(repos.job.queue).toHaveBeenCalledWith({
      name: JobName.FileDelete,
      data: { files: ['/profile/user-id/old.webp'] },
    });
  });

  it('resets to the default avatar when no photo may replace it', async () => {
    const repos = setup();
    repos.user.getProfileImageReplacement.mockResolvedValue(undefined);

    await replaceLockedProfileImages(repos, () => Promise.resolve(defaults));

    expect(repos.media.generateThumbnail).not.toHaveBeenCalled();
    expect(repos.user.replaceLockedProfileImage).toHaveBeenCalledWith('user-id', lockedAssetId, {
      profileImagePath: '',
      profileImageAssetId: null,
    });
    expect(repos.job.queue).toHaveBeenCalledWith({
      name: JobName.FileDelete,
      data: { files: ['/profile/user-id/old.webp'] },
    });
  });

  it('resets to the default avatar when the replacement photo cannot be read', async () => {
    const repos = setup();
    (repos.media.generateThumbnail as ReturnType<typeof vitest.fn>).mockRejectedValue(new Error('unreadable'));

    await replaceLockedProfileImages(repos, () => Promise.resolve(defaults));

    expect(repos.logger.warn).toHaveBeenCalled();
    expect(repos.user.replaceLockedProfileImage).toHaveBeenCalledWith('user-id', lockedAssetId, {
      profileImagePath: '',
      profileImageAssetId: null,
    });
  });

  it('keeps a picture the user set in the meantime and removes the unused copy', async () => {
    const repos = setup();
    repos.user.replaceLockedProfileImage.mockResolvedValue(false);

    await replaceLockedProfileImages(repos, () => Promise.resolve(defaults));

    expect(repos.job.queue).toHaveBeenCalledWith({
      name: JobName.FileDelete,
      data: { files: [expect.stringContaining('new-picture')] },
    });
    expect(repos.job.queue).not.toHaveBeenCalledWith({
      name: JobName.FileDelete,
      data: { files: ['/profile/user-id/old.webp'] },
    });
  });

  it('does nothing when no picture was copied from a Locked photo', async () => {
    const repos = setup();
    repos.user.getLockedProfileImageSources.mockResolvedValue([]);

    await replaceLockedProfileImages(repos, () => Promise.resolve(defaults));

    expect(repos.user.getProfileImageReplacement).not.toHaveBeenCalled();
    expect(repos.user.replaceLockedProfileImage).not.toHaveBeenCalled();
    expect(repos.job.queue).not.toHaveBeenCalled();
  });
});
