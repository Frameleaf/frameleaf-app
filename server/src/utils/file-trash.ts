import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { StorageRepository } from 'src/repositories/storage.repository.js';

/**
 * Moves a file into or out of the universal storage file trash. A rename when both paths share a
 * filesystem; otherwise a copy published at the destination through a temporary name, then the source
 * removed. Rejects with ENOENT when the source is gone.
 */
export const moveFileWithin = async (storage: StorageRepository, from: string, to: string): Promise<void> => {
  storage.mkdirSync(dirname(to));
  try {
    await storage.rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EXDEV') {
      throw error;
    }
  }

  const temporary = `${to}.${randomUUID()}.tmp`;
  try {
    await storage.copyFile(from, temporary);
    await storage.rename(temporary, to);
  } catch (error) {
    await storage.unlink(temporary).catch(() => void 0);
    throw error;
  }
  await storage.unlink(from);
};
