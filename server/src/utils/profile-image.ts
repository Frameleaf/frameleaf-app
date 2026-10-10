import { join } from 'node:path';
import type { JobRepository } from 'src/repositories/job.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { UserRepository } from 'src/repositories/user.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { JobName, StorageFolder } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';

type Repos = {
  media: MediaRepository;
  crypto: CryptoRepository;
  storageCore: StorageCore;
};

export const generateProfileImage = async (
  { media, crypto, storageCore }: Repos,
  { image }: SystemConfig,
  userId: string,
  input: string | Buffer,
): Promise<string> => {
  const outputPath = join(
    StorageCore.getFolderLocation(StorageFolder.Profile, userId),
    `${crypto.randomUUID()}.${image.thumbnail.format}`,
  );
  storageCore.ensureFolders(outputPath);

  await media.generateThumbnail(
    input,
    {
      colorspace: image.colorspace,
      format: image.thumbnail.format,
      quality: image.thumbnail.quality,
      progressive: image.thumbnail.progressive,
      size: image.thumbnail.size,
      processInvalidImages: false,
    },
    outputPath,
  );

  return outputPath;
};

type ReplaceRepos = Repos & {
  user: Pick<
    UserRepository,
    'getLockedProfileImageSources' | 'getProfileImageReplacement' | 'replaceLockedProfileImage'
  >;
  job: Pick<JobRepository, 'queue'>;
  logger: Pick<LoggingRepository, 'warn'>;
};

/**
 * Gives another profile picture to every user whose picture was copied from a photo that became
 * Locked (owner decision 2, September 22, 2026, FL-53). The picture is copied from the photo
 * `UserRepository.getProfileImageReplacement` picks (Best Photos first), or the user is back to the
 * default avatar when there is none or it cannot be read. The old picture file is removed.
 *
 * From the moment the photo is Locked the old picture is no longer served
 * (`UserService.getProfileImage`); this generates the new one. Call it once the move into the Locked
 * folder is committed. The nightly missing-thumbnail sweep calls it too, for changes made where it
 * cannot run (the iCloud reconciler, stack merges). Safe to call at any time: users without such a
 * picture are left alone, and a picture the user changed in the meantime is kept.
 */
export const replaceLockedProfileImages = async (
  repos: ReplaceRepos,
  getConfig: () => Promise<SystemConfig>,
): Promise<void> => {
  const users = await repos.user.getLockedProfileImageSources();
  if (users.length === 0) {
    return;
  }

  const config = await getConfig();
  for (const user of users) {
    if (!user.profileImageAssetId) {
      continue;
    }

    const replacement = await repos.user.getProfileImageReplacement(user.id);
    let profileImagePath = '';
    if (replacement) {
      try {
        profileImagePath = await generateProfileImage(repos, config, user.id, replacement.path);
      } catch (error) {
        repos.logger.warn(`Unable to copy a new profile picture for user ${user.id}: ${error}`);
      }
    }

    const replaced = await repos.user.replaceLockedProfileImage(user.id, user.profileImageAssetId, {
      profileImagePath,
      profileImageAssetId: profileImagePath && replacement ? replacement.id : null,
    });

    // the old picture once it is replaced; the new one when the user set another picture meanwhile
    const unused = replaced ? user.profileImagePath : profileImagePath;
    if (unused) {
      await repos.job.queue({ name: JobName.FileDelete, data: { files: [unused] } });
    }
  }
};
