import { Stats, constants } from 'node:fs';
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import type { ScheduledFreshDownload } from 'src/repositories/icloud-scheduled-staging.repository.js';

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
  return copy.identity === null || (validInputIdentity(copy.identity) && copy.identity.size <= copy.reservedCopyBytes);
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

export type ValidationInputKey = { resourceId: string; sequence: string; pathNonce: string };
export type ValidationInputState = 'reserved' | 'preparing' | 'running' | 'settled' | 'disposed';
export const validationInputStages = ['source', 'recovery-destination', 'existing-destination'] as const;
export type ValidationInputStage = (typeof validationInputStages)[number];
export type ValidationInputPayload = ValidationInputKey & {
  version: 1;
  purpose: 'scheduled-weekly-validation-input';
  ownerId: string;
  connectionId: string;
  auditRequestId: string;
  operationId: string;
  operationClaimToken: string;
  resourceLeaseToken: string;
  itemClaimId: string;
  sourceAssetId: string;
  /**
   * `source` decodes the staged download, `recovery-destination` the owned promoted recovery copy
   * (bound to its generation) and `existing-destination` an already-managed reuse candidate.
   */
  stage: ValidationInputStage;
  fresh: ScheduledFreshDownload;
  validationPath: string;
  sourceIdentity: PrivateCopyIdentity;
  copyGeneration: string | null;
  stagingDirectory: string;
  directoryPath: string;
  inputPath: string;
  directoryIdentity: PrivateCopyIdentity | null;
  inputIdentity: PrivateCopyIdentity | null;
  reservedInputBytes: number;
  state: ValidationInputState;
  pending: string[];
};
export type ValidationInputRecord = { payload: ValidationInputPayload; seal: string };
export type ValidationInputEnvelope = {
  payload: {
    version: 1;
    purpose: 'scheduled-weekly-validation-inputs';
    ownerId: string;
    resourceId: string;
    highWater: string;
    current: ValidationInputRecord;
    previousDisposed: ValidationInputRecord | null;
  };
  seal: string;
};
export const validationInputScope = (input: ValidationInputPayload) =>
  `icloud-scheduled-validation-input:v1:${input.ownerId}:${input.resourceId}:${input.sequence}`;
export const validationInputsScope = (inputs: ValidationInputEnvelope['payload']) =>
  `icloud-scheduled-validation-inputs:v1:${inputs.ownerId}:${inputs.resourceId}:${inputs.highWater}`;

const sequence = /^(0|[1-9][0-9]*)$/;
export function nextValidationInputSequence(current: string): string {
  if (typeof current !== 'string' || !sequence.test(current)) {
    throw new Error('validation_input_sequence_invalid');
  }
  return (BigInt(current) + 1n).toString();
}
const canonicalPath = (path: unknown): path is string =>
  typeof path === 'string' && isAbsolute(path) && normalize(path) === path;
const validInputIdentity = (identity: unknown): identity is PrivateCopyIdentity =>
  !!identity &&
  typeof identity === 'object' &&
  ['dev', 'ino', 'size', 'uid'].every((key) => {
    const value = (identity as PrivateCopyIdentity)[key as keyof PrivateCopyIdentity];
    return Number.isSafeInteger(value) && value >= 0;
  });
function validValidationInput(record: unknown): record is ValidationInputRecord {
  if (!record || typeof record !== 'object') return false;
  const { payload: input, seal } = record as ValidationInputRecord;
  if (
    !input ||
    typeof input !== 'object' ||
    input.version !== 1 ||
    input.purpose !== 'scheduled-weekly-validation-input' ||
    typeof seal !== 'string' ||
    !seal ||
    ![
      'ownerId',
      'connectionId',
      'resourceId',
      'auditRequestId',
      'operationId',
      'operationClaimToken',
      'resourceLeaseToken',
      'itemClaimId',
      'pathNonce',
    ].every((key) => {
      const value = input[key as keyof ValidationInputPayload];
      return typeof value === 'string' && uuid.test(value);
    }) ||
    typeof input.sequence !== 'string' ||
    !sequence.test(input.sequence) ||
    input.sequence === '0' ||
    typeof input.sourceAssetId !== 'string' ||
    !input.sourceAssetId ||
    !['reserved', 'preparing', 'running', 'settled', 'disposed'].includes(input.state) ||
    !validationInputStages.includes(input.stage) ||
    !(input.copyGeneration === null || (typeof input.copyGeneration === 'string' && uuid.test(input.copyGeneration))) ||
    (input.stage === 'recovery-destination' ? input.copyGeneration === null : input.copyGeneration !== null) ||
    !Number.isSafeInteger(input.reservedInputBytes) ||
    input.reservedInputBytes <= 0 ||
    !Array.isArray(input.pending) ||
    input.pending.some((token) => typeof token !== 'string' || !uuid.test(token)) ||
    new Set(input.pending).size !== input.pending.length ||
    (['settled', 'disposed'].includes(input.state) && input.pending.length > 0) ||
    !validInputIdentity(input.sourceIdentity) ||
    input.sourceIdentity.size !== input.reservedInputBytes ||
    ![input.stagingDirectory, input.directoryPath, input.inputPath, input.validationPath].every(canonicalPath) ||
    input.directoryPath !== `${input.stagingDirectory}/.validation-${input.pathNonce}` ||
    input.inputPath !== `${input.directoryPath}/input` ||
    input.validationPath === input.inputPath ||
    input.validationPath === input.directoryPath ||
    !(input.directoryIdentity === null || validInputIdentity(input.directoryIdentity)) ||
    !(
      input.inputIdentity === null ||
      (validInputIdentity(input.inputIdentity) && input.inputIdentity.size <= input.reservedInputBytes)
    ) ||
    (input.inputIdentity !== null && input.directoryIdentity === null) ||
    (['running', 'settled', 'disposed'].includes(input.state) &&
      (!input.directoryIdentity || !input.inputIdentity || input.inputIdentity.size !== input.reservedInputBytes))
  ) {
    return false;
  }
  const fresh = input.fresh;
  const payload = fresh?.payload;
  const binding = payload?.binding;
  return (
    !!binding &&
    payload.version === 1 &&
    payload.basis === 'audit-fresh-download' &&
    typeof fresh.seal === 'string' &&
    !!fresh.seal &&
    ['ownerId', 'connectionId', 'resourceId', 'auditRequestId', 'operationId', 'sourceAssetId'].every(
      (key) => binding[key as keyof typeof binding] === input[key as keyof ValidationInputPayload],
    ) &&
    binding.sizeInBytes === input.reservedInputBytes &&
    canonicalPath(payload.path) &&
    payload.path === `${input.stagingDirectory}/complete` &&
    (input.stage !== 'source' || input.validationPath === payload.path) &&
    (input.stage === 'source' || input.validationPath !== payload.path) &&
    validInputIdentity({ ...payload.identity, uid: input.sourceIdentity.uid }) &&
    payload.identity.size === input.reservedInputBytes &&
    typeof payload.sha1 === 'string' &&
    /^[a-f0-9]{40}$/.test(payload.sha1) &&
    typeof payload.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(payload.sha256) &&
    typeof payload.appleFingerprint === 'string' &&
    !!payload.appleFingerprint
  );
}

/** Shape/state only: production custody and release also authenticate every seal under row fences. */
export function validValidationInputs(value: unknown): value is ValidationInputEnvelope {
  if (!value || typeof value !== 'object') return false;
  const { payload: inputs, seal } = value as ValidationInputEnvelope;
  if (
    !inputs ||
    inputs.version !== 1 ||
    inputs.purpose !== 'scheduled-weekly-validation-inputs' ||
    typeof seal !== 'string' ||
    !seal ||
    typeof inputs.ownerId !== 'string' ||
    !uuid.test(inputs.ownerId) ||
    typeof inputs.resourceId !== 'string' ||
    !uuid.test(inputs.resourceId) ||
    typeof inputs.highWater !== 'string' ||
    !sequence.test(inputs.highWater) ||
    !validValidationInput(inputs.current) ||
    inputs.current.payload.sequence !== inputs.highWater
  )
    return false;
  const records = [inputs.current];
  if (inputs.previousDisposed !== null) {
    if (
      !validValidationInput(inputs.previousDisposed) ||
      inputs.previousDisposed.payload.state !== 'disposed' ||
      BigInt(inputs.previousDisposed.payload.sequence) >= BigInt(inputs.highWater)
    )
      return false;
    records.push(inputs.previousDisposed);
  }
  return records.every(({ payload }) => payload.ownerId === inputs.ownerId && payload.resourceId === inputs.resourceId);
}

/** Not refund authority; authentication remains the repository caller's responsibility. */
export function validationInputsDisposed(envelope: ValidationInputEnvelope): boolean {
  return validValidationInputs(envelope) && envelope.payload.current.payload.state === 'disposed';
}

/** Retain the authenticated parent until the disposal transaction commits; never recurse. */
export async function unlinkOwnedValidationInput(input: ValidationInputPayload): Promise<void> {
  const parent = input.directoryIdentity;
  const identity = input.inputIdentity;
  if (
    input.state !== 'settled' ||
    input.pending.length > 0 ||
    !parent ||
    !identity ||
    !validInputIdentity(parent) ||
    !validInputIdentity(identity) ||
    identity.size !== input.reservedInputBytes ||
    parent.uid !== identity.uid ||
    !canonicalPath(input.stagingDirectory) ||
    input.directoryPath !== `${input.stagingDirectory}/.validation-${input.pathNonce}` ||
    !uuid.test(input.pathNonce) ||
    input.inputPath !== `${input.directoryPath}/input`
  )
    throw new Error('validation_input_custody_invalid');
  const checkParent = async () => {
    const directory = await lstat(input.directoryPath);
    if (
      (await realpath(input.directoryPath)) !== input.directoryPath ||
      !directory.isDirectory() ||
      (directory.mode & 0o077) !== 0 ||
      directory.dev !== parent.dev ||
      directory.ino !== parent.ino ||
      directory.uid !== parent.uid ||
      (process.getuid && directory.uid !== process.getuid()) ||
      (await readdir(input.directoryPath)).some((entry) => entry !== 'input')
    )
      throw new Error('validation_input_parent_changed');
  };
  const checkInput = (stat: Stats) => {
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino ||
      stat.uid !== identity.uid ||
      stat.size !== identity.size ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('validation_input_inode_changed');
  };
  await checkParent();
  let handle;
  try {
    checkInput(await lstat(input.inputPath));
    handle = await open(input.inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await checkParent();
    if ((await readdir(input.directoryPath)).length > 0)
      throw new Error('validation_input_reappeared', { cause: error });
    return;
  }
  try {
    checkInput(await handle.stat());
    checkInput(await lstat(input.inputPath));
  } finally {
    await handle.close();
  }
  await checkParent();
  checkInput(await lstat(input.inputPath));
  await unlink(input.inputPath);
  await checkParent();
  if ((await readdir(input.directoryPath)).length > 0) throw new Error('validation_input_reappeared');
}
