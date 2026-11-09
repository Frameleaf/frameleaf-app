import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

export type FolderSize = { files: number; bytes: number };

/**
 * FL-1323: how many files a folder holds and their size, for the Storage page. Links are not followed and another
 * drive mounted inside is not counted. Null when the folder can't be read (gone, or not visible to Manager).
 */
export async function folderSize(root: string): Promise<FolderSize | null> {
  const top = await lstat(root).catch(() => null);
  if (!top?.isDirectory()) return null;
  const total = { files: 0, bytes: 0 };
  const pending = [root];
  while (pending.length) {
    const folder = pending.pop()!;
    const entries = await opendir(folder).catch(() => null);
    if (!entries) continue;
    for await (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        const info = await lstat(path).catch(() => null);
        if (info?.dev === top.dev) pending.push(path);
      } else if (entry.isFile()) {
        const info = await lstat(path).catch(() => null);
        if (!info) continue;
        total.files++;
        total.bytes += info.size;
      }
    }
  }
  return total;
}
