import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaintenanceModeState } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { BUDDY_UUID } from 'src/utils/buddy-backup-crypto.js';

export const buddyMaintenancePath = (config: ConfigRepository) => {
  const env = config.getEnv();
  return join(
    env.frameleafCloud.identityDir ??
      join(env.storage.mediaLocation ?? StorageCore.getMediaLocation(), 'frameleaf', 'identity'),
    'buddy',
    'recovery-active.json',
  );
};

export const buddyMaintenanceState = async (
  config: ConfigRepository,
): Promise<(MaintenanceModeState & { isMaintenanceMode: true }) | null> => {
  const env = config.getEnv();
  // The supervisor calls this before StorageCore exists. Match the existing mount discovery paths.
  const paths = env.frameleafCloud.identityDir
    ? [join(env.frameleafCloud.identityDir, 'buddy', 'recovery-active.json')]
    : (env.storage.mediaLocation ? [env.storage.mediaLocation] : ['/data', '/usr/src/app/upload']).map((root) =>
        join(root, 'frameleaf', 'identity', 'buddy', 'recovery-active.json'),
      );
  let marker: (MaintenanceModeState & { isMaintenanceMode: true }) | null = null;
  for (const path of paths)
    try {
      const text = await readFile(path, 'utf8');
      if (text.length > 8192) throw new Error('Invalid Buddy maintenance marker');
      const value = JSON.parse(text);
      if (
        value.isMaintenanceMode !== true ||
        typeof value.secret !== 'string' ||
        !BUDDY_UUID.test(value.action?.buddyRecoveryId)
      )
        throw new Error('Invalid Buddy maintenance marker');
      if (marker) throw new Error('More than one Buddy recovery mount is active');
      marker = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  return marker;
};
