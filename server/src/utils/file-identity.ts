import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether `second` is another name (hard link) of the file at `first` (FL-1333: a move that linked its file
 * at the new path and stopped before removing the old name). They are one file (same device and inode, read
 * without following a symbolic link) and two separate entries. Two spellings of one entry, such as a folder
 * reached through a symbolic link or a bind mount, or another letter case on a case-insensitive drive, are not:
 * removing one would remove the file. When it cannot tell, it says no. A missing name rejects with ENOENT and
 * that `path`.
 */
export const isOtherLinkOf = async (first: string, second: string): Promise<boolean> => {
  const [a, b] = await Promise.all([lstat(first, { bigint: true }), lstat(second, { bigint: true })]);
  if (a.dev !== b.dev || a.ino !== b.ino || a.nlink < 2n) {
    return false;
  }
  const [folderA, folderB] = await Promise.all([
    stat(path.dirname(first), { bigint: true }),
    stat(path.dirname(second), { bigint: true }),
  ]);
  if (folderA.dev !== folderB.dev || folderA.ino !== folderB.ino) {
    return true;
  }
  const [nameA, nameB] = [path.basename(first), path.basename(second)];
  if (nameA === nameB) {
    return false;
  }
  // one folder, two spellings: two entries only when the folder lists both as they are
  const names = await readdir(path.dirname(first));
  return names.includes(nameA) && names.includes(nameB);
};
