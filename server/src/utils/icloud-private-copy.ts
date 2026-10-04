import { Stats, constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';

export type PrivateCopyIdentity = { dev: number; ino: number; size: number; uid: number };
export type ScheduledPrivateCopy = {
  version: 1;
  purpose: 'scheduled-weekly-private-copy';
  generation: string;
  ownerId: string;
  connectionId: string;
  resourceId: string;
  auditRequestId: string;
  operationId: string;
  operationClaimToken: string;
  resourceLeaseToken: string;
  itemClaimId: string;
  sourceAssetId: string;
  stagingPath: string;
  temporaryPath: string;
  promotedPath: string;
  reservedCopyBytes: number;
  identity: PrivateCopyIdentity | null;
  promoted: boolean;
  settled: boolean;
  disposed: boolean;
};
export type ScheduledPrivateCopyRecord = { payload: ScheduledPrivateCopy; seal: string | null; pending: string[] };
export type ScheduledPrivateWorkRecord = {
  payload: {
    version: 1;
    purpose: 'scheduled-weekly-private-work';
    generation: string;
    ownerId: string;
    resourceId: string;
    auditRequestId: string;
    operationId: string;
    operationClaimToken: string;
    resourceLeaseToken: string;
    itemClaimId: string;
    copyGeneration: string | null;
    pending: string[];
    settled: boolean;
  };
  seal: string | null;
};
export const privateWorkScope = (work: ScheduledPrivateWorkRecord['payload']) =>
  `icloud-scheduled-private-work:v1:${work.ownerId}:${work.resourceId}:${work.generation}`;
export const privateCopyScope = (copy: ScheduledPrivateCopy) =>
  `icloud-scheduled-private-copy:v1:${copy.ownerId}:${copy.resourceId}:${copy.generation}`;
export const privateCopyIdentity = (stat: Stats): PrivateCopyIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  uid: stat.uid,
});
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function validPrivateWork(record: unknown): record is ScheduledPrivateWorkRecord {
  const work = (record as ScheduledPrivateWorkRecord | undefined)?.payload;
  return (
    !!work &&
    work.version === 1 &&
    work.purpose === 'scheduled-weekly-private-work' &&
    [
      'generation',
      'ownerId',
      'resourceId',
      'auditRequestId',
      'operationId',
      'operationClaimToken',
      'resourceLeaseToken',
      'itemClaimId',
    ].every(
      (key) =>
        typeof work[key as keyof typeof work] === 'string' && uuid.test(work[key as keyof typeof work] as string),
    ) &&
    Array.isArray(work.pending) &&
    work.pending.every((token) => uuid.test(token)) &&
    new Set(work.pending).size === work.pending.length &&
    (work.copyGeneration === null || (typeof work.copyGeneration === 'string' && uuid.test(work.copyGeneration))) &&
    typeof work.settled === 'boolean' &&
    (work.settled ? work.pending.length === 0 : true)
  );
}

/** This validates shape only. Cleanup additionally authenticates the server-produced seal. */
export function validPrivateCopy(record: unknown): record is ScheduledPrivateCopyRecord {
  if (!record || typeof record !== 'object') {
    return false;
  }
  const { payload: copy, pending, seal } = record as ScheduledPrivateCopyRecord;
  if (
    !copy ||
    copy.version !== 1 ||
    copy.purpose !== 'scheduled-weekly-private-copy' ||
    [
      'generation',
      'ownerId',
      'connectionId',
      'resourceId',
      'auditRequestId',
      'operationId',
      'operationClaimToken',
      'resourceLeaseToken',
      'itemClaimId',
    ].some(
      (key) =>
        !(
          typeof copy[key as keyof ScheduledPrivateCopy] === 'string' &&
          uuid.test(copy[key as keyof ScheduledPrivateCopy] as string)
        ),
    ) ||
    typeof copy.sourceAssetId !== 'string' ||
    !copy.sourceAssetId ||
    typeof copy.settled !== 'boolean' ||
    typeof copy.promoted !== 'boolean' ||
    typeof copy.disposed !== 'boolean' ||
    !Number.isSafeInteger(copy.reservedCopyBytes) ||
    copy.reservedCopyBytes <= 0 ||
    !Array.isArray(pending) ||
    pending.some((token) => !uuid.test(token)) ||
    new Set(pending).size !== pending.length ||
    !(seal === null || typeof seal === 'string')
  ) {
    return false;
  }
  if (
    [copy.stagingPath, copy.temporaryPath, copy.promotedPath].some(
      (path) => !(typeof path === 'string' && isAbsolute(path) && normalize(path) === path),
    ) ||
    copy.temporaryPath !== `${copy.promotedPath}.${copy.generation}.partial` ||
    dirname(copy.promotedPath).split('/').at(-1) !== '.icloud-recovery' ||
    copy.stagingPath === copy.promotedPath
  ) {
    return false;
  }
  return (
    copy.identity === null ||
    (['dev', 'ino', 'size', 'uid'].every(
      (key) =>
        Number.isSafeInteger(copy.identity![key as keyof PrivateCopyIdentity]) &&
        copy.identity![key as keyof PrivateCopyIdentity] >= 0,
    ) &&
      copy.identity.size <= copy.reservedCopyBytes)
  );
}

/** Only these producer-owned inode names, under managed DB path locks; no global FS atomicity claim. */
export async function unlinkOwnedPrivateCopy(path: string, identity: PrivateCopyIdentity) {
  const parent = dirname(path);
  if ((await realpath(parent)) !== parent) {
    throw new Error('private_copy_parent_changed');
  }
  const directory = await lstat(parent);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== identity.uid) {
    throw new Error('private_copy_parent_unowned');
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    const named = await lstat(path);
    for (const stat of [opened, named]) {
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.dev !== identity.dev ||
        stat.ino !== identity.ino ||
        stat.uid !== identity.uid ||
        stat.size !== identity.size ||
        (process.getuid && stat.uid !== process.getuid())
      ) {
        throw new Error('private_copy_inode_changed');
      }
    }
    await unlink(path);
  } finally {
    await handle.close();
  }
}
