import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { SourceReadDeliverySchema } from 'src/dtos/source-resource-read.dto.js';
import { FrameleafWorker } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SourceResourceCacheRepository } from 'src/repositories/source-resource-cache.repository.js';
import { SourceResourceReadRepository } from 'src/repositories/source-resource-read.repository.js';
import { SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { SourceResourceAuthService } from 'src/services/source-resource-auth.service.js';
import { buddyFileStopUnconfirmed, createBuddyDirectory } from 'src/utils/buddy-backup-vault.js';
import { beginCloudNativeWork } from 'src/utils/cloud-native-work.js';
import { receiveRenderArtifact } from 'src/utils/render-artifact.js';
import { writeSourceCacheClosed } from 'src/utils/source-cache-closed.js';

const CAPACITY = 2 * 1024 ** 3;
const hash = (value: string) => createHash('sha256').update(value).digest();

@Injectable()
export class SourceResourceDeliveryService {
  private readonly ownerId = randomUUID();
  private cleaning?: Promise<number>;

  constructor(
    private auth: SourceResourceAuthService,
    private grants: SourceResourceRepository,
    private reads: SourceResourceReadRepository,
    private cache: SourceResourceCacheRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(SourceResourceDeliveryService.name);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  async onBootstrap() {
    try {
      await this.cleanup();
    } catch (error) {
      this.logger.warn(`Source original cache recovery deferred: ${String(error)}`);
    }
  }

  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  cleanup() {
    this.cleaning ??= this.removeExpiredEntries().finally(() => {
      this.cleaning = undefined;
    });
    return this.cleaning;
  }

  private async removeExpiredEntries() {
    const root = join(StorageCore.getMediaLocation(), 'source-original-cache');
    const candidates = await this.cache.removalCandidates();
    let removed = 0;
    for (const { id } of candidates) {
      try {
        if (!(await this.cache.claimRemoval(id, { expiredOnly: true, root }))) continue;
        await rm(join(root, id), { recursive: true, force: true });
        if (await this.cache.confirmRemoved(id)) removed++;
      } catch (error) {
        this.logger.warn(`Source original cache cleanup deferred for ${id}: ${String(error)}`);
      }
    }
    return removed;
  }

  async deliver(
    authorization: string | undefined,
    proof: string | undefined,
    header: string | undefined,
    input: Readable,
  ) {
    let payload: string;
    let metadata: ReturnType<typeof SourceReadDeliverySchema.parse>;
    try {
      if (!header || header.length > 4096) throw new Error('invalid');
      const bytes = Buffer.from(header, 'base64');
      if (bytes.toString('base64') !== header) throw new Error('invalid');
      payload = bytes.toString('utf8');
      metadata = SourceReadDeliverySchema.parse(JSON.parse(payload));
    } catch {
      throw new BadRequestException('source_read_payload_invalid');
    }
    const grant = await this.auth.authenticate(authorization, proof, 'deliver', payload);
    const tokenHash = hash(metadata.claimToken);
    const original = await this.reads.beginDelivery(grant, metadata.requestId, metadata.claimFence, tokenHash);
    const matches = (value: typeof original) =>
      value &&
      value.resourceKey === metadata.resourceKey &&
      value.version === metadata.version &&
      value.sha256 === metadata.sha256 &&
      value.bytes === metadata.bytes;
    if (!matches(original)) throw new ConflictException('source_read_lease_invalid');
    const root = join(StorageCore.getMediaLocation(), 'source-original-cache');
    const signal = AbortSignal.timeout(Math.max(1, Math.min(600_000, original!.deadline.getTime() - Date.now())));
    const writer = { id: randomUUID(), ownerId: this.ownerId };
    const reserve = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await this.cache.inspectDisk(root);
        if (!snapshot) return;
        signal.throwIfAborted();
        const entry = await this.grants.withGrant(grant, (tx) =>
          this.cache.reserve(tx, original!, CAPACITY, writer, snapshot),
        );
        if (entry !== 'snapshot-changed') return entry;
      }
    };
    let entry: Awaited<ReturnType<typeof reserve>>;
    let closeAdmission: (() => Promise<void>) | undefined;
    let accepted = false;
    let writerStopped = true;
    try {
      const admission = `${root}-admission`;
      await createBuddyDirectory(admission);
      closeAdmission = await beginCloudNativeWork(admission).catch(() => {
        throw new ServiceUnavailableException('source_cache_capacity_unavailable');
      });
      entry = await reserve();
      if (!entry && (await this.cleanup()) > 0) {
        signal.throwIfAborted();
        if (!matches(await this.reads.heartbeat(grant, metadata.requestId, metadata.claimFence, tokenHash)))
          throw new ConflictException('source_read_lease_invalid');
        entry = await reserve();
      }
      if (!entry) throw new ServiceUnavailableException('source_cache_capacity_unavailable');
      const cacheId = entry.id;
      const folder = join(root, cacheId);
      // Persist the object directory before releasing admission; a SQL rewind cannot hide a late producer.
      await createBuddyDirectory(folder);
      const release = closeAdmission;
      closeAdmission = undefined;
      await release();
      const check = async () => {
        signal.throwIfAborted();
        const live = await this.reads.heartbeat(grant, metadata.requestId, metadata.claimFence, tokenHash);
        if (!matches(live)) throw new ConflictException('source_read_lease_invalid');
        signal.throwIfAborted();
      };
      accepted = await receiveRenderArtifact(
        folder,
        input,
        {
          checksum: metadata.sha256,
          sizeInBytes: String(metadata.bytes),
        },
        check,
        async (artifact) => {
          if (
            !(await writeSourceCacheClosed(root, {
              id: cacheId,
              writerId: writer.id,
              writerOwnerId: writer.ownerId,
              bytes: artifact.sizeInBytes,
              sha256: artifact.outputChecksum,
              fileName: basename(artifact.outputPath),
            }))
          )
            throw new ServiceUnavailableException('source_cache_ownership_unavailable');
          return !!(await this.reads.completeDelivery(
            grant,
            metadata.requestId,
            metadata.claimFence,
            tokenHash,
            metadata,
            (tx) =>
              this.cache.publishVerified(tx, cacheId, writer, {
                fileName: basename(artifact.outputPath),
                bytes: artifact.sizeInBytes,
                sha256: artifact.outputChecksum,
              }),
          ));
        },
        { signal },
      );
      return { accepted };
    } catch (error) {
      if (buddyFileStopUnconfirmed(error) || (error instanceof Error && error.message === 'artifact_close_unconfirmed'))
        writerStopped = false;
      throw error;
    } finally {
      if (writerStopped) await closeAdmission?.();
      // A missing commit acknowledgement may mean the ready row exists. Only an exact writing owner may retire it.
      if (
        entry &&
        !accepted &&
        writerStopped &&
        (await this.cache.finishWriter(entry.id, writer)) &&
        (await this.cache.claimRemoval(entry.id))
      ) {
        await rm(join(root, entry.id), { recursive: true, force: true });
        await this.cache.confirmRemoved(entry.id);
      }
    }
  }
}
