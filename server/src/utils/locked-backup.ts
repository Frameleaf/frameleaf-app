import { isLockedFile, keyId, readHeader } from '@frameleaf/locked-crypto';
import fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * FL-721 (spec §9): what Cloud Backup and Buddy Backup do for Locked encryption. Both copy encrypted
 * files as they are and never decrypt; they also copy each person's key file
 * (`<media root>/locked-keys/<userId>.json`), which every secret needs to open anything. The key file
 * is wrapped, but it is still treated as a secret: its path and content are never logged.
 */

/** The manifest role (and the backup entry role) of a Locked key file. */
export const LOCKED_KEY_BACKUP_ROLE = 'locked-key';

const KEY_FOLDER = 'locked-keys';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
/** `<name>.<uuid>.fllk.tmp` (and the older `<name>.fllk.tmp`), as a seal, unseal or rewrap writes it (spec §7.1). */
const REPLACEMENT = /^(.+?)(?:\.[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})?\.fllk\.tmp$/;

const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');

export const isLockedKeyUserId = (userId: string) => UUID.test(userId);

/** Where a person's key file lives under a media root; null for anything that is not a user id. */
export const lockedKeyFilePath = (mediaLocation: string, userId: string) =>
  isLockedKeyUserId(userId) ? join(mediaLocation, KEY_FOLDER, `${userId}.json`) : null;

/** Every person's key file under the media root: `<userId>.json` only, never a temporary file. */
export async function lockedKeyBackupFiles(mediaLocation: string): Promise<Array<{ userId: string; path: string }>> {
  let names: string[];
  try {
    names = await fs.readdir(join(mediaLocation, KEY_FOLDER));
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((userId) => isLockedKeyUserId(userId))
    .toSorted()
    .map((userId) => ({ userId, path: lockedKeyFilePath(mediaLocation, userId)! }));
}

/** The people who have a key file, so may have a file being sealed or unsealed now. */
export const lockedKeyOwners = async (mediaLocation: string) =>
  new Set((await lockedKeyBackupFiles(mediaLocation)).map(({ userId }) => userId));

/**
 * The paths that have a `.fllk.tmp` sibling: a seal, unseal or rewrap is writing their replacement
 * now, and renames it over them when done. A backup leaves them for its next run. Each folder is read
 * once, however many of the paths it holds.
 */
export async function pathsBeingReplaced(paths: Iterable<string>): Promise<Set<string>> {
  const folders = new Map<string, Map<string, string>>();
  for (const path of paths) {
    const folder = dirname(path);
    const names = folders.get(folder) ?? new Map<string, string>();
    names.set(basename(path), path);
    folders.set(folder, names);
  }
  const busy = new Set<string>();
  for (const [folder, names] of folders) {
    let entries: string[];
    try {
      entries = await fs.readdir(folder);
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      const path = names.get(REPLACEMENT.exec(entry)?.[1] ?? '');
      if (path) {
        busy.add(path);
      }
    }
  }
  return busy;
}

/**
 * Whether `path` is an encrypted file that this person's key file on this server does not open: no
 * key file, or one whose key is not among the file's recipients (they turned encryption off and on
 * again since the backup). The key id comes from the public key, so no secret is needed to tell.
 */
export async function isEncryptedWithOlderKey(
  path: string,
  ownerId: string | null,
  mediaLocation: string,
): Promise<boolean> {
  if (!(await isLockedFile(path).catch(() => false))) {
    return false;
  }
  const { keyIds } = await readHeader(path);
  const keyPath = ownerId ? lockedKeyFilePath(mediaLocation, ownerId) : null;
  if (!keyPath) {
    return true;
  }
  let publicKey: string | undefined;
  try {
    const file = JSON.parse(await fs.readFile(keyPath, 'utf8')) as { userId?: string; publicKey?: unknown } | null;
    publicKey = file?.userId === ownerId && typeof file.publicKey === 'string' ? file.publicKey : undefined;
  } catch {
    // missing or unreadable: it opens nothing
  }
  if (!publicKey) {
    return true;
  }
  const current = keyId(Buffer.from(publicKey, 'base64'));
  return keyIds.every((id) => !id.equals(current));
}
