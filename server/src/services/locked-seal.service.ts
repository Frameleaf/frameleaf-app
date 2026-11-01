import {
  LockedFileCorruptError,
  type LockedFileInfo,
  type LockedKeyFile,
  type Recipient,
  WrongSecretError,
  decryptFile,
  encryptFile,
  isLockedFile,
  keyId,
  readHeader,
  rewrapFile,
  verifyFile,
} from '@frameleaf/locked-crypto';
import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { type Stats, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { FrameleafWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LockedEncryptionRepository } from 'src/repositories/locked-encryption.repository.js';
import {
  LOCKED_PATH_BUSY,
  type LockedFileRef,
  LockedFileRepository,
  type LockedSealState,
  syncDirectory,
} from 'src/repositories/locked-file.repository.js';
import { LockedKeyRepository } from 'src/repositories/locked-key.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { LOCKED_TEMP_NAME, matchLockedEncryptionRow } from 'src/utils/locked-backup.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import {
  assertLockedTmpIsTmpfs,
  isLockedKeyUnavailable,
  lockedTmpConfig,
  removeStalePlainCopies,
  takeLockedDeferrals,
} from 'src/utils/locked-read.js';
import { queueLockedPartnerChecks } from 'src/utils/locked-seal-queue.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { handlePromiseError } from 'src/utils/misc.js';

/** The ending of the temporary file (`<path>.<uuid>.fllk.tmp`) a seal, unseal or rewrap writes beside the file it replaces (spec §7.1). */
export const LOCKED_TEMP_SUFFIX = '.fllk.tmp';
/** `<name>.<uuid>.fllk.tmp` (and the older `<name>.fllk.tmp`): group 1 is the file it was replacing. */
const STALE_TEMP = LOCKED_TEMP_NAME;
/** How long after a seal or unseal the sweep checks whether turning on or off has finished. */
export const FINISH_CHECK_DELAY_MS = 2 * 60 * 1000;
/** After a key load, when the jobs deferred for it are woken again (Task 12: a job still running at the load). */
export const LATE_WAKE_DELAYS_MS = [5000, 30_000, 120_000];
/** The least time between two sweeps a key load queues for one person. */
const WAKE_INTERVAL_MS = 5 * 60 * 1000;
/** How many files the sweep opens at once to read their headers. */
const HEADER_CONCURRENCY = 16;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

const sha256Of = async (path: string) => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest();
};

const sameFile = (before: Stats, after: Stats) =>
  before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;

/** Whether the asset's files are meant to be encrypted now (seal and rewrap act; unseal leaves it). */
const meantToBeSealed = (state: LockedSealState | undefined): state is LockedSealState =>
  !!state &&
  state.locked &&
  !state.pendingUnlockAt &&
  state.encryptable &&
  !state.partnerCopy &&
  (state.status === 'encrypting' || state.status === 'on');

/** Whether the asset's files are meant to be plain again: it is leaving Locked, or encryption is turning off. */
const meantToBeUnsealed = (state: LockedSealState | undefined): state is LockedSealState =>
  !!state &&
  state.encryptable &&
  !state.partnerCopy &&
  (!state.locked || !!state.pendingUnlockAt || state.status === null || state.status === 'decrypting');

/** A file as the sweep reads it: `damaged` starts with `FLLK` but has no readable header (never re-wrapped). */
type FileState =
  | { ref: LockedFileRef; state: 'missing' | 'plain' | 'damaged' }
  | { ref: LockedFileRef; state: 'sealed'; keyIds: Buffer[] };

/** Whether these files stop turning off or an unlock from finishing: one is sealed, damaged or missing. */
const blocksFinish = (files: FileState[]) =>
  files.some(
    (file) => file.state === 'sealed' || file.state === 'damaged' || (file.state === 'missing' && !file.ref.optional),
  );

const syncFile = async (path: string) => {
  const handle = await fs.open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** The outcome of one pass over an asset's files. */
type Pass = 'done' | 'moved' | 'stopped' | 'busy';

/**
 * FL-721: the jobs that encrypt Locked files in place ("seal", spec §7.1–7.2), decrypt them again
 * ("unseal", §7.3–7.4), change their recipients ("rewrap", §6.2) and look for pending work ("sweep").
 *
 * Every file is replaced the same way, so a source is never lost: the new content goes to
 * `<path>.<uuid>.fllk.tmp` beside it (under the path lock), is checked (a seal decrypts what it wrote and compares SHA-256 with
 * the source; an unseal and a rewrap authenticate every segment) and synced, and only then renamed
 * over the path, after which the folder is synced. On any error the source is left as it was and the
 * temporary file is removed. Files are told apart by their first four bytes (`FLLK`), so every step
 * is safe to repeat and to resume.
 *
 * Seal needs only public keys. Unseal and rewrap need the owner's private key; without it they skip,
 * and loading the key (`lockedKeys.onLoad`) queues a sweep of that person, which queues them again.
 */
@Injectable()
export class LockedSealService {
  private unsubscribe?: () => void;
  private wokenAt = new Map<string, number>();
  /** People whose files need a re-wrap their key wasn't loaded for: their next key load sweeps at once. */
  private rewrapWaiting = new Set<string>();

  constructor(
    private logger: LoggingRepository,
    private lockedFileRepository: LockedFileRepository,
    private lockedKeyRepository: LockedKeyRepository,
    private lockedEncryptionRepository: LockedEncryptionRepository,
    private jobRepository: JobRepository,
    private databaseRepository: DatabaseRepository,
    private websocketRepository: WebsocketRepository,
    private cronRepository: CronRepository,
  ) {
    this.logger.setContext(LockedSealService.name);
  }

  /** Jobs run in the microservices worker: wake deferred work on key loads, sweep hourly, clean up. */
  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  async onBootstrap(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = lockedKeys.onLoad((userId) => {
      // jobs this worker deferred for this person's key run now, not at the end of their hour
      const deferred = takeLockedDeferrals(userId);
      if (deferred.length > 0) {
        handlePromiseError(this.jobRepository.wakeLockedDeferrals(deferred), this.logger);
        // a job that hit the missing key just before this load is still running, and is only deferred
        // (for an hour) after this wake; waking the same ids again a little later catches it. A job
        // already woken or finished is left alone (the wake only moves jobs still waiting for a key).
        for (const delay of LATE_WAKE_DELAYS_MS) {
          setTimeout(
            () => handlePromiseError(this.jobRepository.wakeLockedDeferrals(deferred), this.logger),
            delay,
          ).unref();
        }
      }
      // a PIN unlock that is extended loads the key again on every extension; one wake-up every few
      // minutes is enough, and the hourly sweep is the backstop
      const now = Date.now();
      // a re-wrap left waiting for this key (a new partner, a mode switch) is never held back
      const waiting = this.rewrapWaiting.delete(userId);
      if (!waiting && now - (this.wokenAt.get(userId) ?? 0) < WAKE_INTERVAL_MS) {
        return;
      }
      this.wokenAt.set(userId, now);
      handlePromiseError(this.jobRepository.queue({ name: JobName.LockedSweep, data: { userId } }), this.logger);
    });
    this.cronRepository.create({
      name: 'lockedEncryptionSweep',
      expression: '41 * * * *',
      onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.LockedSweep, data: {} }), this.logger),
      start: true,
    });
    await this.removeStaleTemp();
    await this.matchRowsToKeyFiles();
    // spec §8: plain copies are made only in a RAM-backed folder; without one, readers defer
    try {
      await assertLockedTmpIsTmpfs();
      if (lockedTmpConfig().allowDisk) {
        this.logger.warn(
          'FRAMELEAF_LOCKED_TMP_ALLOW_DISK is set: plain copies of encrypted Locked files are written to disk. Use it for development only.',
        );
      }
      await removeStalePlainCopies();
    } catch (error) {
      if (isLockedKeyUnavailable(error)) {
        this.logger.warn(`${error.message}. Jobs that need a plain copy of an encrypted Locked file will wait.`);
      } else {
        throw error;
      }
    }
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Spec §7.1 step 5: deletes the `.fllk.tmp` files a crash left beside the files of every Locked item
   * of everyone with encryption on, turning on or turning off. Every temporary file is written beside
   * a path the registry lists, and an item that crashed mid-step still has work left, so it is still
   * listed here.
   */
  async removeStaleTemp(): Promise<void> {
    let removed = 0;
    const folders = new Map<string, Set<string>>();
    const add = (path: string) => {
      const names = folders.get(dirname(path)) ?? new Set<string>();
      names.add(basename(path));
      folders.set(dirname(path), names);
    };
    for (const userId of await this.lockedEncryptionRepository.getAllUserIds()) {
      for (const asset of await this.lockedEncryptionRepository.getLockedAssets(userId)) {
        // a read-only or external library's folders are not Frameleaf's to clean
        if (!asset.encryptable) {
          continue;
        }
        for (const { path } of await this.lockedFileRepository.filesOf(asset.id)) {
          add(path);
        }
      }
      // FL-721: an item that left Locked after a job stopped mid-write is no longer listed above, and
      // nothing writes beside it any more; a leftover there would hold up its backup for good
      for (const path of await this.lockedEncryptionRepository.getUnlockedFilePaths(userId)) {
        add(path);
      }
    }
    for (const [folder, names] of folders) {
      let entries: string[];
      try {
        entries = await fs.readdir(folder);
      } catch (error) {
        if (!isMissing(error)) {
          this.logger.warn(`Could not look for stale Locked temporary files: ${(error as Error).name}`);
        }
        continue;
      }
      for (const entry of entries) {
        const match = STALE_TEMP.exec(entry);
        if (!match || !names.has(match[1])) {
          continue;
        }
        try {
          await fs.unlink(join(folder, entry));
          removed++;
        } catch (error) {
          if (!isMissing(error)) {
            this.logger.warn(`Could not remove a stale Locked temporary file: ${(error as Error).name}`);
          }
        }
      }
    }
    if (removed > 0) {
      this.logger.log(`Removed ${removed} temporary Locked file(s) left by an interrupted job`);
    }
  }

  /**
   * FL-721 (spec §9): a database restored from a backup can name a mode that the live key file (kept by
   * a library restore, or rewritten since) no longer has. The key file is the source of truth; the row
   * follows it. No row is made here: a key file without one can be a kept PIN-only pair (encryption off).
   */
  async matchRowsToKeyFiles(): Promise<void> {
    let files: LockedKeyFile[];
    try {
      files = await this.lockedKeyRepository.list();
    } catch (error) {
      this.logger.warn(`Could not read the Locked key files to match them to their rows: ${(error as Error).name}`);
      return;
    }
    for (const file of files) {
      try {
        if ((await matchLockedEncryptionRow(this.lockedEncryptionRepository, file, { create: false })) === 'updated') {
          this.logger.log(`Matched the Locked encryption mode of user ${file.userId} to their key file`);
        }
      } catch (error) {
        this.logger.warn(`Could not match a Locked encryption row to its key file: ${(error as Error).name}`);
      }
    }
  }

  // ---- Seal ----

  @OnJob({ name: JobName.LockedSeal, queue: QueueName.BackgroundTask })
  async handleSeal({ id }: JobOf<JobName.LockedSeal>): Promise<JobStatus> {
    const state = await this.lockedFileRepository.getSealState(id);
    // nothing for a deleted asset, one that isn't in an encrypted set, or while turning off (which
    // can race seals already running)
    if (!meantToBeSealed(state)) {
      return JobStatus.Skipped;
    }
    const recipients = await this.recipientsOf(state.ownerId);
    if (!recipients) {
      this.logger.error(`Locked item ${id} was not encrypted: its owner's key file is missing or unreadable`);
      return JobStatus.Failed;
    }

    try {
      // spec §6.1: never encrypt a file another asset reads in plain form
      await this.lockedFileRepository.unshareOriginal(id);
      let files = await this.lockedFileRepository.filesOf(id);
      if (await this.unshareGenerated(id, files)) {
        files = await this.lockedFileRepository.filesOf(id);
      }

      let pass = await this.sealFiles(state, files, recipients);
      if (pass === 'moved') {
        // a path moved under us (a storage-template move); read the registry once more
        pass = await this.sealFiles(state, await this.lockedFileRepository.filesOf(id), recipients);
      }
      if (pass !== 'done') {
        if (pass === 'busy') {
          // another job is replacing a file this item shares; a later sweep looks again
          await this.queueFinishCheck(state.ownerId);
        }
        return JobStatus.Skipped;
      }
    } catch (error) {
      this.logger.error(`Could not encrypt Locked item ${id}: ${(error as Error).name}: ${(error as Error).message}`);
      return JobStatus.Failed;
    }

    if (state.status === 'encrypting') {
      // a later sweep turns the status to `on` once nothing is left to seal
      await this.queueFinishCheck(state.ownerId);
    }
    return JobStatus.Success;
  }

  /** Owner first, then (PIN mode only, spec §6.2) every partner who receives Locked items and has a key pair. */
  private async recipientsOf(ownerId: string): Promise<Recipient[] | null> {
    const file = await this.readKeyFile(ownerId);
    if (!file) {
      return null;
    }
    const owner = Buffer.from(file.publicKey, 'base64');
    const recipients: Recipient[] = [{ publicKey: owner }];
    if (file.mode === 'pin') {
      const seen = new Set([owner.toString('base64')]);
      for (const { publicKey } of await this.lockedFileRepository.partnerRecipients(ownerId)) {
        const key = publicKey.toString('base64');
        if (!seen.has(key) && recipients.length < 255) {
          seen.add(key);
          recipients.push({ publicKey });
        }
      }
    }
    return recipients;
  }

  private async unshareGenerated(id: string, files: LockedFileRef[]) {
    let moved = false;
    for (const ref of files) {
      if (ref.table === 'asset_file' && !ref.optional) {
        moved = (await this.lockedFileRepository.unshareFile(id, ref)) || moved;
      }
    }
    return moved;
  }

  private async sealFiles(state: LockedSealState, files: LockedFileRef[], recipients: Recipient[]): Promise<Pass> {
    for (const ref of files) {
      let sealed: boolean;
      try {
        sealed = await isLockedFile(ref.path);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        if (ref.optional) {
          continue;
        }
        return 'moved';
      }
      if (sealed) {
        continue;
      }
      const outcome = await this.sealFile(state, ref, recipients);
      if (outcome !== 'done') {
        return outcome;
      }
    }
    return 'done';
  }

  private sealFile(state: LockedSealState, ref: LockedFileRef, recipients: Recipient[]): Promise<Pass> {
    const { path } = ref;
    const info: LockedFileInfo = {
      assetId: state.id,
      kind: ref.kind,
      originalFileName: ref.table === 'asset' ? state.originalFileName : basename(path),
      mime: mimeTypes.lookup(ref.table === 'asset' ? state.originalFileName : path),
    };
    return this.replaceFile(state, ref, meantToBeSealed, async (temporary) => {
      if (await isLockedFile(path)) {
        // another job (an item sharing this file) sealed it meanwhile
        return false;
      }
      const source = await sha256Of(path);
      const { sha256 } = await encryptFile(path, temporary, recipients, info, { verify: true });
      // what the temporary file decrypts to is the source, byte for byte
      if (!sha256?.equals(source)) {
        throw new Error('The file changed while it was being encrypted');
      }
      return true;
    });
  }

  /**
   * The one way a stored file is replaced (seal, unseal in place, rewrap), under the file's path lock
   * so no two jobs ever work on one path at once (C1):
   *
   * 1. `write` fills a temporary file of this job's own (`<path>.<uuid>.fllk.tmp`, created exclusively)
   *    and checks it; it returns false when the file is already as wanted;
   * 2. the temporary file gets the source's mode and is synced;
   * 3. under the owner's per-user lock in shared mode (never while turning off or an unlock is being
   *    finished): the item's state is read again, the source must be the same file as when `write`
   *    started, then the rename and the folder sync.
   *
   * On any error the temporary file is removed and the source is left as it was. `busy` when another
   * job holds the path; `moved` when the file isn't there.
   */
  private async replaceFile(
    state: LockedSealState,
    ref: LockedFileRef,
    stillMeant: (state: LockedSealState | undefined) => boolean,
    write: (temporary: string) => Promise<boolean>,
  ): Promise<Pass> {
    const { path } = ref;
    const outcome = await this.lockedFileRepository.withFileLock(path, state.ownerId, async (commit) => {
      const temporary = `${path}.${randomUUID()}${LOCKED_TEMP_SUFFIX}`;
      try {
        let before: Stats;
        try {
          before = await fs.stat(path);
        } catch (error) {
          if (isMissing(error)) {
            return 'moved' as const;
          }
          throw error;
        }
        if (!(await write(temporary))) {
          return 'done' as const;
        }
        await fs.chmod(temporary, before.mode & 0o7777);
        await syncFile(temporary);
        return await commit(async (trx) => {
          // on the lock's own connection: a job never holds a second one while it holds the path (N1)
          if (!stillMeant(await this.lockedFileRepository.getSealState(state.id, trx))) {
            // turned off, unlocked or locked again meanwhile: the file stays as it was
            await fs.rm(temporary, { force: true });
            return 'stopped' as const;
          }
          if (!sameFile(before, await fs.stat(path))) {
            throw new Error('The file changed while it was being replaced');
          }
          await fs.rename(temporary, path);
          await syncDirectory(dirname(path));
          return 'done' as const;
        });
      } catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
      }
    });
    return outcome === LOCKED_PATH_BUSY ? 'busy' : outcome;
  }

  // ---- Unseal ----

  @OnJob({ name: JobName.LockedUnseal, queue: QueueName.BackgroundTask })
  async handleUnseal({ id }: JobOf<JobName.LockedUnseal>): Promise<JobStatus> {
    const state = await this.lockedFileRepository.getSealState(id);
    if (!meantToBeUnsealed(state)) {
      return JobStatus.Skipped;
    }

    let outcome: Awaited<ReturnType<LockedSealService['unsealFiles']>>;
    try {
      outcome = await this.unsealFiles(state);
      if (outcome === 'no-key') {
        // the wake-up comes from lockedKeys.onLoad
        return JobStatus.Skipped;
      }
    } catch (error) {
      this.logger.error(`Could not decrypt Locked item ${id}: ${(error as Error).name}: ${(error as Error).message}`);
      return JobStatus.Failed;
    }

    let finished = outcome === 'done';
    if (finished && state.pendingUnlockAt) {
      // spec §7.3: the lock goes only once the last file is plain, checked again under the lock
      finished = await this.finishUnlock(id, state.ownerId);
    }
    if (state.status === 'decrypting' || outcome === 'busy') {
      // a later sweep looks again, and finishes turning off once nothing is left to decrypt
      await this.queueFinishCheck(state.ownerId);
    }
    return finished ? JobStatus.Success : JobStatus.Skipped;
  }

  /**
   * Decrypts every sealed file of the item. `done` only when every listed file is there and plain
   * afterwards: a missing file (storage offline, a move under way) is never taken for a plain one (C2).
   */
  private async unsealFiles(state: LockedSealState): Promise<'done' | 'stopped' | 'busy' | 'no-key'> {
    const files = await this.fileStates(await this.lockedFileRepository.filesOf(state.id));
    const sealed = files.filter((file) => file.state === 'sealed').map(({ ref }) => ref);
    let outcome: 'done' | 'stopped' | 'busy' = files.some(
      (file) => file.state === 'damaged' || (file.state === 'missing' && !file.ref.optional),
    )
      ? 'stopped'
      : 'done';
    if (sealed.length === 0) {
      return outcome;
    }
    const privateKey = this.ownerKey(state.ownerId);
    if (!privateKey) {
      return 'no-key';
    }
    try {
      for (const ref of sealed) {
        const result = await this.unsealFile(state, ref, privateKey);
        if (result === 'stopped' || result === 'moved') {
          outcome = 'stopped';
        } else if (result === 'busy' && outcome === 'done') {
          outcome = 'busy';
        }
      }
    } finally {
      privateKey.fill(0);
    }
    return outcome;
  }

  private async unsealFile(state: LockedSealState, ref: LockedFileRef, privateKey: Buffer): Promise<Pass> {
    // a file the same person's other Locked items still read encrypted stays as it is; this asset
    // gets its own plain copy (the reverse of spec §6.1)
    if (
      state.status !== 'decrypting' &&
      (await this.lockedFileRepository.sealedReaders(state.id, ref.path)).length > 0
    ) {
      if (ref.table !== 'asset' && ref.table !== 'asset_file') {
        // the item stays on its way out of Locked rather than leaving it with a file nobody decrypts
        this.logger.warn(`Locked item ${state.id} stays locked: another Locked item shares one of its files`);
        return 'stopped';
      }
      const moved = await this.lockedFileRepository.copyAndRepoint(
        state.id,
        ref,
        this.lockedFileRepository.siblingPath(ref.path),
        (to) => this.decryptTo(ref.path, to, privateKey),
      );
      return moved ? 'done' : 'stopped';
    }

    try {
      return await this.replaceFile(state, ref, meantToBeUnsealed, async (temporary) => {
        if (!(await isLockedFile(ref.path))) {
          return false;
        }
        await this.decryptTo(ref.path, temporary, privateKey, false);
        return true;
      });
    } catch (error) {
      if (error instanceof WrongSecretError) {
        // not sealed to this person: the item stays on its way out of Locked rather than leaving it
        // with a file nobody decrypts
        this.logger.warn(`Locked item ${state.id} stays locked: one of its files isn't sealed to its owner's key`);
        return 'stopped';
      }
      throw error;
    }
  }

  /**
   * Decrypts `from` into `to` (a new path). Every segment authenticates before it is written, and the
   * result must have the recorded length. With `publish`, `to` is renamed into place from a temporary
   * file of its own and its folder synced.
   */
  private async decryptTo(from: string, to: string, privateKey: Buffer, publish = true) {
    const temporary = publish ? `${to}.${randomUUID()}${LOCKED_TEMP_SUFFIX}` : to;
    try {
      const { plaintextLength } = await readHeader(from);
      await decryptFile(from, temporary, privateKey);
      if ((await fs.stat(temporary)).size !== plaintextLength) {
        throw new Error('A decrypted file has the wrong length');
      }
      if (publish) {
        await fs.rename(temporary, to);
        await syncDirectory(dirname(to));
      }
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  // ---- Rewrap ----

  @OnJob({ name: JobName.LockedRewrap, queue: QueueName.BackgroundTask })
  async handleRewrap({ id }: JobOf<JobName.LockedRewrap>): Promise<JobStatus> {
    const state = await this.lockedFileRepository.getSealState(id);
    if (!meantToBeSealed(state)) {
      return JobStatus.Skipped;
    }
    const recipients = await this.recipientsOf(state.ownerId);
    if (!recipients) {
      this.logger.error(`Locked item ${id} was not re-wrapped: its owner's key file is missing or unreadable`);
      return JobStatus.Failed;
    }
    const wanted = recipients.map(({ publicKey }) => keyId(publicKey));

    const stale: LockedFileRef[] = [];
    for (const ref of await this.lockedFileRepository.filesOf(id)) {
      const file = await this.fileState(ref);
      // the header's key ids only say whether a rewrap is needed; they are never an access list
      if (file.state === 'sealed' && !this.sameRecipients(file.keyIds, wanted)) {
        stale.push(ref);
      }
    }
    if (stale.length === 0) {
      return JobStatus.Success;
    }
    const privateKey = this.ownerKey(state.ownerId);
    if (!privateKey) {
      return JobStatus.Skipped;
    }
    try {
      for (const ref of stale) {
        const pass = await this.rewrapFile(state, ref, privateKey, recipients);
        if (pass === 'busy') {
          await this.queueFinishCheck(state.ownerId);
        }
        if (pass !== 'done') {
          return JobStatus.Skipped;
        }
      }
    } catch (error) {
      this.logger.error(`Could not re-wrap Locked item ${id}: ${(error as Error).name}: ${(error as Error).message}`);
      return JobStatus.Failed;
    } finally {
      privateKey.fill(0);
    }
    return JobStatus.Success;
  }

  private async rewrapFile(
    state: LockedSealState,
    ref: LockedFileRef,
    privateKey: Buffer,
    recipients: Recipient[],
  ): Promise<Pass> {
    const wanted = recipients.map(({ publicKey }) => keyId(publicKey));
    try {
      return await this.replaceFile(state, ref, meantToBeSealed, async (temporary) => {
        if (!(await isLockedFile(ref.path)) || this.sameRecipients((await readHeader(ref.path)).keyIds, wanted)) {
          return false;
        }
        await rewrapFile(ref.path, temporary, privateKey, recipients);
        await verifyFile(temporary, privateKey);
        return true;
      });
    } catch (error) {
      if (error instanceof WrongSecretError) {
        this.logger.warn(`Left a file of Locked item ${state.id} as it is: it isn't sealed to its owner's key`);
        return 'done';
      }
      throw error;
    }
  }

  private sameRecipients(actual: Buffer[], wanted: Buffer[]) {
    const have = new Set(actual.map((id) => id.toString('hex')));
    return have.size === wanted.length && wanted.every((id) => have.has(id.toString('hex')));
  }

  // ---- Sweep ----

  /**
   * Hourly (every person with a `locked_encryption` row; Ruling 13), after turning on or off, and when
   * a key loads (one person): queues the seals, unseals and rewraps each person's items still need,
   * by their files' headers, finishes unlocks whose files are all plain, turns `encrypting` into `on`
   * once nothing is left to seal, and finishes turning off once nothing is left to decrypt. Unseals
   * and rewraps are queued only while the key is loaded, so a person who hasn't typed their
   * passphrase isn't queued work every hour that can only skip.
   */
  @OnJob({ name: JobName.LockedSweep, queue: QueueName.BackgroundTask })
  async handleSweep({ userId }: JobOf<JobName.LockedSweep> = {}): Promise<JobStatus> {
    // `delay` only told the queue when to run it
    const userIds = userId ? [userId] : await this.lockedEncryptionRepository.getAllUserIds();
    for (const id of userIds) {
      try {
        await this.sweepUser(id);
      } catch (error) {
        this.logger.error(`Could not sweep the Locked items of user ${id}: ${(error as Error).name}`);
        if (userId) {
          return JobStatus.Failed;
        }
      }
    }
    return JobStatus.Success;
  }

  private async sweepUser(userId: string) {
    const row = await this.lockedEncryptionRepository.get(userId);
    const assets = (await this.lockedEncryptionRepository.getLockedAssets(userId)).filter(
      ({ encryptable }) => encryptable,
    );
    const keyLoaded = lockedKeys.has(userId);
    const turningOff = !row || row.status === 'decrypting';
    const recipients = turningOff ? null : await this.recipientsOf(userId);
    const wanted = recipients?.map(({ publicKey }) => keyId(publicKey));

    const seal: string[] = [];
    const unseal: string[] = [];
    const rewrap: string[] = [];
    let plainLeft = 0;
    let sealedLeft = 0;
    let rewrapWaits = false;
    for (const asset of assets) {
      const files = await this.fileStates(await this.lockedFileRepository.filesOf(asset.id));
      const sealedFiles = files.filter((file) => file.state === 'sealed' || file.state === 'damaged');
      const anyPlain = files.some((file) => file.state === 'plain');
      if (turningOff || asset.pendingUnlockAt) {
        if (blocksFinish(files)) {
          // sealed, or missing and so perhaps sealed (C2): turning off and the unlock wait
          sealedLeft++;
          if (keyLoaded && sealedFiles.length > 0) {
            unseal.push(asset.id);
          }
        } else if (asset.pendingUnlockAt && !(await this.finishUnlock(asset.id, userId))) {
          sealedLeft++;
        }
        continue;
      }
      if (anyPlain) {
        plainLeft++;
        seal.push(asset.id);
      } else if (
        wanted &&
        sealedFiles.some((file) => file.state === 'sealed' && !this.sameRecipients(file.keyIds, wanted))
      ) {
        if (keyLoaded) {
          rewrap.push(asset.id);
        } else {
          rewrapWaits = true;
        }
      }
    }

    if (rewrapWaits) {
      // spec §6.2: the re-wrap runs on the owner's next unlock, whenever that is
      this.rewrapWaiting.add(userId);
    }
    const jobs = [
      ...seal.map((id) => ({ name: JobName.LockedSeal as const, data: { id } })),
      ...unseal.map((id) => ({ name: JobName.LockedUnseal as const, data: { id } })),
      ...rewrap.map((id) => ({ name: JobName.LockedRewrap as const, data: { id } })),
    ];
    if (jobs.length > 0) {
      await this.jobRepository.queueAll(jobs);
    }

    if (row?.status === 'encrypting' && plainLeft === 0) {
      await this.lockedEncryptionRepository.update(userId, { status: 'on' });
      this.logger.log(`Locked encryption is on for user ${userId}: every Locked item is encrypted`);
    } else if (row?.status === 'decrypting' && sealedLeft === 0) {
      await this.finishTurnOff(userId);
    }
  }

  /**
   * Spec §7.4, the last step of turning off, under the same per-user database lock as the API's
   * key-file changes (Ruling 12). Ruling 11: a key file with a PIN wrap stays, rewritten as a PIN-only
   * key pair that encrypts nothing (spec §4.1: it may still open partners' items); one without (an
   * Advanced key file) is deleted. Either way the row goes and the pinned key is released.
   */
  private async finishTurnOff(userId: string) {
    let keyDeleted = false;
    const finished = await this.databaseRepository.withLockedKeyFileLock(userId, async () => {
      const row = await this.lockedEncryptionRepository.get(userId);
      if (row?.status !== 'decrypting') {
        return false;
      }
      // every file is read again under the exclusive lock, which no rename can pass (C2, I3): a file
      // still sealed, or missing and so perhaps sealed, keeps the key file and the row
      for (const asset of await this.lockedEncryptionRepository.getLockedAssets(userId)) {
        if (!asset.encryptable) {
          continue;
        }
        if (
          asset.pendingUnlockAt ||
          blocksFinish(await this.fileStates(await this.lockedFileRepository.filesOf(asset.id)))
        ) {
          this.logger.log(`Turning off Locked encryption for user ${userId} waits: item ${asset.id} isn't plain yet`);
          return false;
        }
      }
      let file: LockedKeyFile | null | undefined;
      try {
        file = await this.lockedKeyRepository.read(userId);
      } catch {
        file = undefined;
      }
      if (file === undefined || (!file && (await this.lockedKeyRepository.exists(userId)))) {
        // never delete a key file that can't be read
        this.logger.error(`Left the unreadable Locked key file of user ${userId} as it is`);
      } else if (file) {
        const pin = file.wraps.filter(({ kind }) => kind === 'pin');
        if (pin.length > 0) {
          await this.lockedKeyRepository.write({
            ...file,
            mode: 'pin',
            encrypting: false,
            wraps: pin,
            updatedAt: new Date().toISOString(),
          });
        } else {
          await this.lockedKeyRepository.delete(userId);
          keyDeleted = true;
        }
      }
      await this.lockedEncryptionRepository.delete(userId);
      return true;
    });
    if (!finished) {
      return;
    }
    if (keyDeleted) {
      // Ruling 11, spec §6.2: owners who share with this person still name the deleted key in their
      // files; their sweeps queue the re-wraps that remove it (a kept PIN-only key pair is unchanged)
      await queueLockedPartnerChecks(
        { lockedEncryption: this.lockedEncryptionRepository, job: this.jobRepository, logger: this.logger },
        userId,
      );
    }
    lockedKeys.pin(userId, false);
    lockedKeys.drop(userId);
    // the API process holds the pinned key and is the only one that may tell the supervisor (and so
    // every worker) to release it; it does so when it hears this
    this.websocketRepository.serverSend('LockedEncryptionOff', { userId });
    this.logger.log(`Locked encryption is off for user ${userId}: every Locked item is decrypted`);
  }

  // ---- Helpers ----

  /**
   * After a seal (turning on) or an unseal (turning off): a sweep of the person a little later, which
   * finishes the step once nothing is left. Deduplicated to one waiting check, so a turn-on of N items
   * reads the headers a few times rather than N times.
   */
  private queueFinishCheck(userId: string) {
    return this.jobRepository.queue({ name: JobName.LockedSweep, data: { userId, delay: FINISH_CHECK_DELAY_MS } });
  }

  private async readKeyFile(userId: string): Promise<LockedKeyFile | null> {
    try {
      return await this.lockedKeyRepository.read(userId);
    } catch {
      return null;
    }
  }

  /** A copy of the owner's loaded private key, which the caller zero-fills; null when it isn't loaded. */
  private ownerKey(userId: string): Buffer | null {
    const held = lockedKeys.list().find((key) => key.userId === userId);
    return held ? Buffer.from(held.privateKey) : null;
  }

  /**
   * Spec §7.3: removes the lock of an item on its way out of Locked, once every file is there and
   * plain, read again under the owner's per-user lock in exclusive mode so no seal's rename can land in
   * between (I3). False when it has to wait (C2).
   */
  private finishUnlock(assetId: string, ownerId: string): Promise<boolean> {
    return this.databaseRepository.withLockedKeyFileLock(ownerId, async () => {
      if (blocksFinish(await this.fileStates(await this.lockedFileRepository.filesOf(assetId)))) {
        return false;
      }
      return this.lockedFileRepository.finishPendingUnlock(assetId);
    });
  }

  private async fileState(ref: LockedFileRef): Promise<FileState> {
    try {
      if (!(await isLockedFile(ref.path))) {
        return { ref, state: 'plain' };
      }
    } catch (error) {
      if (isMissing(error)) {
        return { ref, state: 'missing' };
      }
      throw error;
    }
    try {
      return { ref, state: 'sealed', keyIds: (await readHeader(ref.path)).keyIds };
    } catch (error) {
      if (error instanceof LockedFileCorruptError) {
        this.logger.warn('A Locked file has a damaged header; it is left as it is');
        return { ref, state: 'damaged' };
      }
      throw error;
    }
  }

  private async fileStates(refs: LockedFileRef[]): Promise<FileState[]> {
    const states: FileState[] = [];
    for (let index = 0; index < refs.length; index += HEADER_CONCURRENCY) {
      states.push(
        ...(await Promise.all(refs.slice(index, index + HEADER_CONCURRENCY).map((ref) => this.fileState(ref)))),
      );
    }
    return states;
  }
}
