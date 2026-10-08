import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Stats, constants } from 'node:fs';
import { FileHandle, link, lstat, mkdir, mkdtemp, open, realpath, rm, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { OnEvent } from 'src/decorators.js';
import { AssetType } from 'src/enum.js';
import {
  ICloudScheduledStagingRepository,
  ScheduledDeepValidation,
  ScheduledFreshDownload,
  ScheduledFreshPayload,
  ScheduledStagingInput,
  scheduledDeepReceiptScope,
  scheduledFreshBinding,
  scheduledFreshReceiptScope,
} from 'src/repositories/icloud-scheduled-staging.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import {
  MediaIntegrityIdentity,
  MediaIntegrityResult,
  MediaIntegrityService,
} from 'src/services/media-integrity.service.js';
import { readAliasedEnv } from 'src/utils/env-aliases.js';
import { appleFingerprintHash, isAppleFingerprint } from 'src/utils/icloud-identity.js';
import { privateCopyIdentity, privateCopyScope, validPrivateCopy } from 'src/utils/icloud-private-copy.js';
import { canonicalJson } from 'src/utils/studio-project.js';

export type ScheduledValidationOutcome =
  | {
      status: 'validated';
      receipt: ScheduledFreshDownload;
      validation: ScheduledDeepValidation;
      verified: Extract<MediaIntegrityResult, { status: 'healthy' }>;
    }
  | { status: 'unavailable' };
export type ScheduledFreshValidation = {
  result: Promise<ScheduledValidationOutcome>;
  /** Actual decoder settlement AND cleanup of its exact owned copy, independent of current credentials. */
  settled: Promise<void>;
  cancel: () => void;
};
const fileIdentity = (stat: MediaIntegrityIdentity): MediaIntegrityIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});
const sameFile = (a: MediaIntegrityIdentity, b: MediaIntegrityIdentity) =>
  canonicalJson(fileIdentity(a)) === canonicalJson(fileIdentity(b));
const ownedFile = (stat: Stats) =>
  stat.isFile() && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid());
const boundHashes = (maximum: number) => {
  let sizeInBytes = 0;
  const sha1 = createHash('sha1');
  const sha256 = createHash('sha256');
  const apple = appleFingerprintHash();
  return {
    stream: new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeInBytes += chunk.length;
        if (sizeInBytes > maximum) {
          callback(new Error('scheduled_audit_size_mismatch'));
          return;
        }
        sha1.update(chunk);
        sha256.update(chunk);
        apple.update(chunk);
        callback(null, chunk);
      },
    }),
    finish: () => ({
      sizeInBytes,
      sha1: sha1.digest('hex'),
      sha256: sha256.digest('hex'),
      appleFingerprint: apple.digest(),
    }),
  };
};

/** Invoked only by a future reviewed worker. No dispatcher, allocation, recovery or proof publication. */
@Injectable()
export class ICloudScheduledStagingService {
  private readonly cleanups = new Set<Promise<void>>();
  private readonly ownedWork = new Map<string, Set<Promise<void>>>();
  constructor(
    private repository: ICloudScheduledStagingRepository,
    private staging: ICloudStagingService,
    private transport: ICloudTransportRepository,
    private integrity: MediaIntegrityService,
  ) {}

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    await Promise.allSettled(this.cleanups);
  }

  private trackOwnedWork(resourceId: string, work: Promise<void>) {
    const owned = this.ownedWork.get(resourceId) ?? new Set<Promise<void>>();
    owned.add(work);
    this.ownedWork.set(resourceId, owned);
    this.cleanups.add(work);
    const finished = () => {
      owned.delete(work);
      this.cleanups.delete(work);
      if (owned.size === 0) {
        this.ownedWork.delete(resourceId);
      }
    };
    void work.catch(() => {}).then(finished);
  }

  /** Refused private bytes are cleaned only after decoder AND delayed final readonly guards settle. */
  cleanupRetired(input: ScheduledStagingInput) {
    const cleanup = (async () => {
      await Promise.allSettled(this.ownedWork.get(input.resource.id) ?? new Set<Promise<void>>());
      await this.repository.disposePrivateCopy(input);
      await this.repository.disposeRefusedStaging(input);
    })()
      .catch(() => {})
      .finally(() => this.cleanups.delete(cleanup));
    this.cleanups.add(cleanup);
    return cleanup;
  }

  /** Restart can resume sealed settled copies; unknown/pending generations remain charged. */
  async housekeeping() {
    for (const resource of await this.repository.retiredPrivateCopies()) {
      const record = resource.verification?.auditPrivateCopy;
      if (!validPrivateCopy(record) || !record.payload.identity) {
        await this.repository.retainPrivateCopy(resource, 'unproven');
        continue;
      }
      if (!record.payload.settled || record.pending.length > 0) {
        await this.repository.retainPrivateCopy(resource, 'pending-settlement');
        continue;
      }
      if (!record.seal) {
        await this.repository.retainPrivateCopy(resource, 'unproven');
        continue;
      }
      const input: ScheduledStagingInput = {
        ownerId: resource.ownerId,
        resource: { id: resource.id, leaseToken: record.payload.resourceLeaseToken },
        authority: {
          purpose: 'scheduled-weekly',
          auditRequestId: record.payload.auditRequestId,
          operationId: record.payload.operationId,
          operationClaimToken: record.payload.operationClaimToken,
        },
      };
      try {
        await this.cleanupRetired(input);
        await this.repository.retainPrivateCopy(resource, 'fence-or-unlink');
      } catch {
        await this.repository.retainPrivateCopy(resource, 'fence-or-unlink');
      }
    }
  }

  /** Real exclusive private inode, registered and charged before copying/decoding/promotion. */
  async copyRecovery(input: ScheduledStagingInput, promotedPath: string) {
    await this.checkpoint(input);
    const token = await this.repository.beginPrivateWork(input);
    let file: FileHandle | undefined;
    let promoted = false;
    let ownershipPersisted = false;
    let directoryOpen = false;
    let readonlySettled = false;
    const work = (async () => {
      const initial = await this.repository.privateCopy(input);
      if (!initial || initial.payload.promotedPath !== promotedPath || initial.payload.identity || !token) {
        throw new Error('scheduled_private_copy_unavailable');
      }
      const parent = join(promotedPath, '..');
      if ((await realpath(parent)) !== parent) {
        throw new Error('scheduled_private_copy_parent_changed');
      }
      const directory = await lstat(parent);
      if (
        !directory.isDirectory() ||
        (directory.mode & 0o077) !== 0 ||
        (process.getuid && directory.uid !== process.getuid())
      ) {
        throw new Error('scheduled_private_copy_parent_unowned');
      }
      file = await open(
        initial.payload.temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const persist = async () => {
        const record = await this.repository.privateCopy(input);
        if (!record || !file) {
          throw new Error('scheduled_private_copy_changed');
        }
        const immutable = (payload: typeof initial.payload) => ({
          ...payload,
          identity: null,
          promoted: false,
          settled: false,
        });
        if (canonicalJson(immutable(record.payload)) !== canonicalJson(immutable(initial.payload))) {
          throw new Error('scheduled_private_copy_changed');
        }
        const stat = await file.stat();
        if (!ownedFile(stat)) {
          throw new Error('scheduled_private_copy_unowned');
        }
        const payload = { ...record.payload, identity: privateCopyIdentity(stat), promoted, settled: false };
        const next = {
          ...record,
          payload,
          seal: await this.transport.encodeSession(privateCopyScope(payload), payload),
        };
        if (!validPrivateCopy(next) || !(await this.repository.storePrivateCopy(input, record, next))) {
          throw new Error('scheduled_private_copy_changed');
        }
      };
      try {
        await persist(); // Includes actual dev/ino/uid/size before any bytes or decoder work.
        const observed = await this.readOwned(input, initial.payload.stagingPath, undefined, file);
        const receipt = await this.cached(input, initial.payload.stagingPath);
        readonlySettled = true;
        if (observed.sha1 !== receipt.payload.sha1 || observed.sha256 !== receipt.payload.sha256) {
          throw new Error('scheduled_private_copy_source_changed');
        }
        await file.sync();
        await persist();
        // EEXIST never makes the destination ours. No existing original is replaced or borrowed.
        await this.step(input, async () => {
          await link(initial.payload.temporaryPath, promotedPath);
          promoted = true;
        });
        await persist();
        const directory = await open(parent, 'r');
        directoryOpen = true;
        try {
          await directory.sync();
        } finally {
          await directory.close();
          directoryOpen = false;
        }
        await this.repository.unlinkPrivateTemporary(input);
      } finally {
        // On failure preserve actual partial inode evidence and conservative charge, never fake free.
        // A failed final ownership write cannot prove the final inode size or promotion state.
        // Keep its pending generation charged even after the actual handle closes.
        try {
          await persist();
          ownershipPersisted = true;
        } catch {
          ownershipPersisted = false;
        }
        await file.close();
        file = undefined;
      }
    })().finally(() => {
      if (!file && !directoryOpen && readonlySettled && ownershipPersisted) {
        return this.repository.finishPrivateWork(input, token);
      }
    });
    this.trackOwnedWork(input.resource.id, work);
    await work;
  }

  private async checkpoint(input: ScheduledStagingInput, signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new Error('scheduled_audit_unavailable');
    }
    const admission = await this.repository.read(input);
    if (!admission || signal?.aborted) {
      throw new Error('scheduled_audit_unavailable');
    }
    return admission;
  }

  private async step<T>(
    input: ScheduledStagingInput,
    work: () => Promise<T>,
    signal?: AbortSignal,
    dispose?: (value: T) => Promise<void>,
  ) {
    const value = await work();
    try {
      await this.checkpoint(input, signal);
      return value;
    } catch (error) {
      await dispose?.(value).catch(() => {});
      throw error;
    }
  }

  private async directory(input: ScheduledStagingInput, signal?: AbortSignal) {
    const admission = await this.checkpoint(input, signal);
    const root = await this.step(input, () => this.staging.root(), signal);
    const directory = join(root, admission.resource.id);
    await this.step(
      input,
      () =>
        mkdir(directory, { mode: 0o700 }).catch((error) => {
          if (error.code !== 'EEXIST') {
            throw error;
          }
        }),
      signal,
    );
    const canonical = await this.step(input, () => realpath(directory), signal);
    const stat = await this.step(input, () => lstat(directory), signal);
    if (
      canonical !== directory ||
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error('scheduled_audit_staging_invalid');
    }
    const path = join(directory, 'complete');
    if (admission.resource.stagingPath && admission.resource.stagingPath !== path) {
      throw new Error('scheduled_audit_staging_invalid');
    }
    return { directory, path, admission };
  }

  private sink(input: ScheduledStagingInput, signal?: AbortSignal, file?: FileHandle) {
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const writing = file ? this.step(input, () => file.writeFile(chunk), signal) : this.checkpoint(input, signal);
        void writing.then(
          () => callback(),
          (error) => callback(error),
        );
      },
    });
  }

  /** Hash a real NOFOLLOW handle, bound size, and compare the named/open identity before and after. */
  private async readOwned(input: ScheduledStagingInput, path: string, signal?: AbortSignal, copy?: FileHandle) {
    const { resource } = await this.checkpoint(input, signal);
    const handle = await this.step(
      input,
      () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      signal,
      (file) => file.close(),
    );
    try {
      const before = await this.step(input, () => handle.stat(), signal);
      const named = await this.step(input, () => lstat(path), signal);
      if (
        !ownedFile(before) ||
        !ownedFile(named) ||
        !sameFile(before, named) ||
        before.size !== resource.expectedSize
      ) {
        throw new Error('scheduled_audit_staging_invalid');
      }
      const hashes = boundHashes(resource.expectedSize);
      await this.step(
        input,
        () =>
          pipeline(handle.createReadStream({ autoClose: false }), hashes.stream, this.sink(input, signal, copy), {
            signal,
          }),
        signal,
      );
      const after = await this.step(input, () => handle.stat(), signal);
      const final = await this.step(input, () => lstat(path), signal);
      const result = hashes.finish();
      if (
        !ownedFile(after) ||
        !ownedFile(final) ||
        !sameFile(before, after) ||
        !sameFile(before, final) ||
        result.sizeInBytes !== before.size
      ) {
        throw new Error('scheduled_audit_staging_changed');
      }
      return { ...result, identity: fileIdentity(final) };
    } finally {
      await handle.close();
    }
  }

  private async cached(
    input: ScheduledStagingInput,
    path: string,
    signal?: AbortSignal,
  ): Promise<ScheduledFreshDownload> {
    const { guarded, resource } = await this.checkpoint(input, signal);
    const receipt = resource.verification?.auditFreshDownload as ScheduledFreshDownload | undefined;
    if (
      !receipt?.seal ||
      receipt.payload?.version !== 1 ||
      receipt.payload.basis !== 'audit-fresh-download' ||
      receipt.payload.path !== path ||
      canonicalJson(receipt.payload.binding) !== canonicalJson(scheduledFreshBinding(guarded, resource.id))
    ) {
      throw new Error('scheduled_audit_fresh_receipt_invalid');
    }
    const payload = await this.step(
      input,
      () => this.transport.decodeSession(scheduledFreshReceiptScope(receipt.payload), receipt.seal),
      signal,
    );
    if (canonicalJson(payload) !== canonicalJson(receipt.payload)) {
      throw new Error('scheduled_audit_fresh_receipt_invalid');
    }
    const observed = await this.readOwned(input, path, signal);
    if (
      observed.sha1 !== receipt.payload.sha1 ||
      observed.sha256 !== receipt.payload.sha256 ||
      observed.appleFingerprint !== receipt.payload.appleFingerprint ||
      !sameFile(observed.identity, receipt.payload.identity)
    ) {
      throw new Error('scheduled_audit_fresh_receipt_invalid');
    }
    const current = await this.checkpoint(input, signal);
    if (canonicalJson(current.resource.verification?.auditFreshDownload) !== canonicalJson(receipt)) {
      throw new Error('scheduled_audit_fresh_receipt_invalid');
    }
    return receipt;
  }

  async download(input: ScheduledStagingInput, signal?: AbortSignal): Promise<ScheduledFreshDownload> {
    try {
      const { directory, path, admission } = await this.directory(input, signal);
      const existing = await this.step(
        input,
        () =>
          lstat(path).catch((error) => {
            if (error.code !== 'ENOENT') {
              throw error;
            }
            return;
          }),
        signal,
      );
      if (existing) {
        return await this.cached(input, path, signal);
      }
      if (admission.resource.verification?.auditFreshDownload) {
        throw new Error('scheduled_audit_fresh_receipt_invalid');
      }
      const free = await this.step(input, () => statfs(directory, { bigint: true }), signal);
      const watermark = BigInt(readAliasedEnv('FRAMELEAF_ICLOUD_FREE_SPACE_BYTES') ?? 1024 ** 3);
      if (free.bavail * free.bsize < BigInt(admission.resource.expectedSize) + watermark) {
        throw new Error('scheduled_audit_staging_full');
      }
      if (!(await this.repository.heartbeat(input, path))) {
        throw new Error('scheduled_audit_unavailable');
      }
      await this.checkpoint(input, signal);
      const temporary = join(directory, `${input.resource.leaseToken}.partial`);
      const file = await this.step(
        input,
        () => open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600),
        signal,
        async (handle) => {
          await handle.close();
          await unlink(temporary).catch(() => {});
        },
      );
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) {
        cancel();
      }
      let checking: Promise<void> | undefined;
      let completed = false;
      const timer = setInterval(() => {
        if (!checking) {
          checking = this.repository
            .heartbeat(input, path)
            .then((allowed) => {
              if (!allowed) {
                cancel();
              }
            })
            .catch(cancel)
            .finally(() => {
              checking = undefined;
            });
        }
      }, 15_000);
      try {
        const { guarded, resource } = await this.checkpoint(input, controller.signal);
        const connection = guarded.connection;
        const session = await this.step(
          input,
          () => this.transport.decodeSession(connection.id, connection.encryptedSession),
          controller.signal,
        );
        const response = await this.step(
          input,
          () =>
            this.transport.download(
              {
                session,
                library: resource.library,
                recordId: resource.recordId,
                resourceKey: resource.resourceKey,
                expectedFingerprint: resource.fingerprint,
              },
              controller.signal,
            ),
          controller.signal,
          (response) => {
            response.stream.destroy();
            return Promise.resolve();
          },
        );
        try {
          if (response.fingerprint !== resource.fingerprint || response.size !== resource.expectedSize) {
            throw new Error('scheduled_audit_source_changed');
          }
          const refreshed = await this.step(
            input,
            () => this.transport.encodeSession(connection.id, response.session),
            controller.signal,
          );
          if (!(await this.repository.saveSession(input, connection.encryptedSession!, refreshed))) {
            throw new Error('scheduled_audit_unavailable');
          }
          await this.checkpoint(input, controller.signal);
          const hashes = boundHashes(resource.expectedSize);
          await this.step(
            input,
            () =>
              pipeline(response.stream, hashes.stream, this.sink(input, controller.signal, file), {
                signal: controller.signal,
              }),
            controller.signal,
          );
          const downloaded = hashes.finish();
          const fingerprint = (resource.source.resource as Record<string, unknown> | undefined)?.fileChecksum;
          if (
            downloaded.sizeInBytes !== resource.expectedSize ||
            typeof fingerprint !== 'string' ||
            !isAppleFingerprint(fingerprint) ||
            downloaded.appleFingerprint !== fingerprint
          ) {
            throw new Error('scheduled_audit_source_changed');
          }
          await this.step(input, () => file.sync(), controller.signal);
          await this.step(input, () => file.close(), controller.signal);
          await this.step(input, () => link(temporary, path), controller.signal);
          await this.step(input, () => unlink(temporary), controller.signal);
          const dir = await this.step(
            input,
            () => open(directory, 'r'),
            controller.signal,
            (handle) => handle.close(),
          );
          try {
            await this.step(input, () => dir.sync(), controller.signal);
          } finally {
            await dir.close();
          }
          const observed = await this.readOwned(input, path, controller.signal);
          if (
            observed.sha1 !== downloaded.sha1 ||
            observed.sha256 !== downloaded.sha256 ||
            observed.appleFingerprint !== downloaded.appleFingerprint
          ) {
            throw new Error('scheduled_audit_staging_changed');
          }
          const current = await this.checkpoint(input, controller.signal);
          const payload: ScheduledFreshPayload = {
            version: 1,
            basis: 'audit-fresh-download',
            binding: scheduledFreshBinding(current.guarded, resource.id),
            path,
            identity: observed.identity,
            sha1: observed.sha1,
            sha256: observed.sha256,
            appleFingerprint: observed.appleFingerprint,
          };
          const seal = await this.step(
            input,
            () => this.transport.encodeSession(scheduledFreshReceiptScope(payload), payload),
            controller.signal,
          );
          const receipt = { payload, seal };
          if (!(await this.repository.storeFreshDownload(input, receipt))) {
            throw new Error('scheduled_audit_unavailable');
          }
          await this.checkpoint(input, controller.signal);
          completed = true;
          return receipt;
        } finally {
          response.stream.destroy();
        }
      } finally {
        clearInterval(timer);
        signal?.removeEventListener('abort', cancel);
        controller.abort();
        await checking;
        await file.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        if (completed) {
          await this.checkpoint(input, signal);
        }
      }
    } catch {
      throw new Error('scheduled_audit_unavailable');
    }
  }

  /** No hashing/decoder work in the final transaction. Managed path locks must be held by the caller. */
  async holdPublicationFiles(input: ScheduledStagingInput, signal?: AbortSignal, destination?: string) {
    const privateWork = await this.repository.beginPrivateWork(input);
    const { path } = await this.directory(input, signal);
    const receipt = await this.cached(input, path, signal);
    const { guarded, resource } = await this.checkpoint(input, signal);
    const validation = resource.verification?.auditDeepValidation as ScheduledDeepValidation;
    if (
      !(await this.repository.authenticateDeepValidation(input, validation)) ||
      validation.payload.path !== (destination ?? path)
    ) {
      throw new Error('scheduled_audit_unavailable');
    }
    const originalIdentity = guarded.bindings.receipt.snapshot.fileIdentity as MediaIntegrityIdentity;
    if (!originalIdentity) {
      throw new Error('scheduled_audit_unavailable');
    }
    const files: Array<{ path: string; handle: FileHandle; identity: MediaIntegrityIdentity; private: boolean }> = [];
    const pending = new Set<Promise<boolean>>();
    let released = false;
    try {
      for (const binding of [
        { path, identity: receipt.payload.identity, private: true },
        { path: guarded.bindings.original.originalPath, identity: originalIdentity, private: false },
        ...(destination ? [{ path: destination, identity: validation.payload.identity, private: true }] : []),
      ]) {
        const handle = await this.step(
          input,
          () => open(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW),
          signal,
          (handle) => handle.close(),
        );
        files.push({ ...binding, handle });
      }
      const current = async () => {
        if (released || signal?.aborted) {
          return false;
        }
        const work = (async () => {
          for (const file of files) {
            const opened = await file.handle.stat();
            const named = await lstat(file.path);
            if (
              released ||
              signal?.aborted ||
              !opened.isFile() ||
              !named.isFile() ||
              (file.private && (!ownedFile(opened) || !ownedFile(named))) ||
              !sameFile(opened, file.identity) ||
              !sameFile(named, file.identity)
            ) {
              return false;
            }
          }
          return !released && !signal?.aborted;
        })().catch(() => false);
        pending.add(work);
        void work.finally(() => pending.delete(work));
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel: (() => void) | undefined;
        const refused = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
          cancel = () => resolve(false);
          signal?.addEventListener('abort', cancel, { once: true });
          if (signal?.aborted) {
            cancel();
          }
        });
        try {
          return await Promise.race([work, refused]);
        } finally {
          clearTimeout(timer);
          if (cancel) {
            signal?.removeEventListener('abort', cancel);
          }
        }
      };
      const release = () => {
        released = true;
        const cleanup = Promise.allSettled(pending)
          .then(async () => {
            const closed = await Promise.allSettled(files.map(({ handle }) => Promise.try(() => handle.close())));
            const failures = closed.filter((close) => close.status === 'rejected').map((close) => close.reason);
            if (failures.length > 0) throw new AggregateError(failures, 'scheduled_audit_close_failed');
            await this.repository.finishPrivateWork(input, privateWork);
          })
          .finally(() => this.cleanups.delete(cleanup));
        this.cleanups.add(cleanup);
        this.trackOwnedWork(input.resource.id, cleanup);
        return cleanup;
      };
      return { receipt, validation, current, release, paths: files.map(({ path }) => path) };
    } catch {
      const closed = await Promise.allSettled(files.map(({ handle }) => handle.close()));
      if (closed.every(({ status }) => status === 'fulfilled')) {
        await this.repository.finishPrivateWork(input, privateWork);
      }
      throw new Error('scheduled_audit_unavailable');
    }
  }

  /** A unique owned copy is the decoder input; cached bytes alone never qualify a result. */
  async validate(
    input: ScheduledStagingInput,
    signal?: AbortSignal,
    destination?: string,
  ): Promise<ScheduledFreshValidation> {
    // Durable pending ownership precedes preliminary readonly work and the unique input copy too.
    // A preparation failure without a complete settlement record remains conservatively retained.
    const privateWork = await this.repository.beginPrivateWork(input);
    try {
      const { directory, path } = await this.directory(input, signal);
      const receipt = await this.cached(input, path, signal);
      const validationPath = destination ?? path;
      const destinationIdentity = destination
        ? (await this.readOwned(input, destination, signal)).identity
        : receipt.payload.identity;
      const copyDirectory = await this.step(
        input,
        () => mkdtemp(join(directory, '.validation-')),
        signal,
        (path) => rm(path, { recursive: true, force: true }),
      );
      let started = false;
      try {
        const copyPath = join(copyDirectory, 'input');
        const copy = await this.step(
          input,
          () => open(copyPath, 'wx', 0o600),
          signal,
          (handle) => handle.close(),
        );
        try {
          const observed = await this.readOwned(input, validationPath, signal, copy);
          if (
            !sameFile(observed.identity, destinationIdentity) ||
            observed.sha256 !== receipt.payload.sha256 ||
            observed.sha1 !== receipt.payload.sha1
          ) {
            throw new Error('scheduled_audit_staging_changed');
          }
          await this.step(input, () => copy.sync(), signal);
        } finally {
          await copy.close();
        }
        const { resource } = await this.checkpoint(input, signal);
        const type = resource.source.type;
        if (type !== AssetType.Image && type !== AssetType.Video) {
          throw new Error('scheduled_audit_media_unsupported');
        }
        const validation = this.integrity.validateWithSettlement({
          path: copyPath,
          originalFileName:
            typeof resource.source.originalFileName === 'string' ? resource.source.originalFileName : resource.id,
          type,
          expected: {
            sha1: Buffer.from(receipt.payload.sha1, 'hex'),
            sha256: Buffer.from(receipt.payload.sha256, 'hex'),
            sizeInBytes: receipt.payload.binding.sizeInBytes,
          },
          deep: true,
        });
        started = true;
        const decoderCleanup = validation.settled.then(() => rm(copyDirectory, { recursive: true, force: true }));
        let cancelled = false;
        const refusal = Promise.withResolvers<ScheduledValidationOutcome>();
        const cancel = () => {
          cancelled = true;
          validation.cancel();
          refusal.resolve({ status: 'unavailable' });
        };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) {
          cancel();
        }
        let checking: Promise<void> | undefined;
        const timer = setInterval(() => {
          if (!checking) {
            checking = this.checkpoint(input, signal)
              .then(() => {})
              .catch(cancel)
              .finally(() => {
                checking = undefined;
              });
          }
        }, 15_000);
        const work = (async (): Promise<ScheduledValidationOutcome> => {
          try {
            const verified = await validation.result;
            // Refusal is immediate. Cleanup independently waits for real noncooperative work.
            if (cancelled || verified.status !== 'healthy') {
              return { status: 'unavailable' };
            }
            await this.checkpoint(input, signal);
            if (cancelled) {
              return { status: 'unavailable' };
            }
            await validation.settled;
            await this.checkpoint(input, signal);
            clearInterval(timer);
            await checking;
            await this.checkpoint(input, signal);
            if (cancelled) {
              return { status: 'unavailable' };
            }
            const current = await this.cached(input, path, signal);
            const destinationCurrent = destination ? await this.readOwned(input, destination, signal) : undefined;
            if (
              destinationCurrent &&
              (!sameFile(destinationCurrent.identity, destinationIdentity) ||
                destinationCurrent.sha256 !== receipt.payload.sha256 ||
                destinationCurrent.sha1 !== receipt.payload.sha1)
            ) {
              return { status: 'unavailable' };
            }
            if (
              cancelled ||
              canonicalJson(current) !== canonicalJson(receipt) ||
              verified.sha256.toString('hex') !== receipt.payload.sha256 ||
              verified.sha1.toString('hex') !== receipt.payload.sha1
            ) {
              return { status: 'unavailable' };
            }
            const payload: ScheduledDeepValidation['payload'] = {
              version: 1,
              basis: 'audit-settled-decode',
              fresh: receipt,
              path: validationPath,
              identity: destinationIdentity,
              sha1: verified.sha1.toString('hex'),
              sha256: verified.sha256.toString('hex'),
              sizeInBytes: verified.sizeInBytes,
            };
            const seal = await this.step(
              input,
              () => this.transport.encodeSession(scheduledDeepReceiptScope(payload), payload),
              signal,
            );
            const proof = { payload, seal };
            if (cancelled || !(await this.repository.storeDeepValidation(input, proof))) {
              return { status: 'unavailable' };
            }
            await this.checkpoint(input, signal);
            if (cancelled) {
              return { status: 'unavailable' };
            }
            return { status: 'validated', receipt, validation: proof, verified };
          } catch {
            return { status: 'unavailable' };
          } finally {
            clearInterval(timer);
            signal?.removeEventListener('abort', cancel);
          }
        })();
        // Result refusal/timeout is not settlement. Include late hashing/readonly/receipt work,
        // actual decoder termination and removal of its unique input before issuing the seal.
        const settled = Promise.all([decoderCleanup, work])
          .then(async () => {
            await this.repository.finishPrivateWork(input, privateWork);
          })
          .catch(() => {})
          .finally(() => this.cleanups.delete(settled));
        this.cleanups.add(settled);
        this.trackOwnedWork(input.resource.id, settled);
        const result = Promise.race([work, refusal.promise]).finally(() => {
          clearInterval(timer);
          signal?.removeEventListener('abort', cancel);
        });
        return { result, settled, cancel };
      } finally {
        if (!started) {
          await rm(copyDirectory, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {
      throw new Error('scheduled_audit_unavailable');
    }
  }
}
