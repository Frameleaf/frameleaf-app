import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { addAbortSignal } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { queueExecution } from 'src/queue/context.js';
import {
  type SourceCacheReader,
  SourceResourceCacheRepository,
} from 'src/repositories/source-resource-cache.repository.js';
import { SourceResourceReadRepository } from 'src/repositories/source-resource-read.repository.js';
import { openRenderArtifact } from 'src/utils/render-artifact.js';
import { beginSourceCacheReader } from 'src/utils/source-cache-closed.js';

@Injectable()
export class SourceOriginalService {
  private readonly jobReaderOwnerId = randomUUID();
  constructor(
    private reads: SourceResourceReadRepository,
    private cache: SourceResourceCacheRepository,
  ) {}

  /** Ordinary job inputs remain pinned through deferred publication. */
  async openForJob(assetId: string, authorize: () => Promise<void>) {
    const { release: _release, ...input } = await this.openJobInput(assetId, authorize);
    return input;
  }

  /** A consumed archive entry can release its input before publication. */
  openForJobEntry(assetId: string, authorize: () => Promise<void>) {
    return this.openJobInput(assetId, authorize);
  }

  private async openJobInput(assetId: string, authorize: () => Promise<void>) {
    const context = queueExecution.getStore();
    if (!context) throw new Error('source_job_claim_required');
    const { release, ...input } = await this.open(
      assetId,
      {
        kind: 'job',
        jobId: context.claim.id,
        attemptToken: context.claim.token,
        readerId: randomUUID(),
        ownerId: this.jobReaderOwnerId,
      },
      authorize,
      context.signal,
    ).catch((error) => {
      if (
        error instanceof Error &&
        [
          'artifact_close_unconfirmed',
          'source_original_shutdown_unconfirmed',
          'source_reader_stop_unconfirmed',
          'media_process_shutdown_unconfirmed',
        ].includes(error.message)
      )
        context.executorStopUnconfirmed = true;
      throw error;
    });
    let retained = false;
    (context.afterSettled ??= []).push(async () => {
      if (!retained && !context.executorStopUnconfirmed) await release();
    });
    return {
      ...input,
      release,
      retainOnUnconfirmedStop: () => {
        retained = true;
        context.executorStopUnconfirmed = true;
      },
    };
  }

  /** The caller supplies its acting-user/job authorization and must join release on cancellation. */
  async open(
    assetId: string,
    reader: SourceCacheReader,
    authorize: () => Promise<void>,
    signal?: AbortSignal,
    maxBytes?: number,
  ) {
    const job = reader.kind === 'job' ? queueExecution.getStore() : undefined;
    const operation = AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]);
    const unavailable = () => new ServiceUnavailableException('source_original_unavailable');
    const guard = async () => {
      operation.throwIfAborted();
      await authorize();
      operation.throwIfAborted();
    };
    await guard();
    const root = join(StorageCore.getMediaLocation(), 'source-original-cache');
    const removeUnused = async (cacheId: string) => {
      if (await this.cache.claimRemoval(cacheId, { root })) {
        await rm(join(root, cacheId), { recursive: true, force: true });
        await this.cache.confirmRemoved(cacheId);
      }
    };
    // Concurrent consumers share an in-flight delivery, never a previously ready request.
    const request = await this.reads.enqueue(assetId, maxBytes, reader);
    if (!request) throw unavailable();
    let pinned: Awaited<ReturnType<SourceResourceReadRepository['pinReady']>>;
    let renewAt = 0;
    try {
      for (;;) {
        await guard();
        if (Date.now() >= new Date(request.deadline).getTime()) throw unavailable();
        if (Date.now() >= renewAt) {
          if (!(await this.reads.renewConsumer(request.id, reader))) throw unavailable();
          renewAt = Date.now() + 30_000;
        }
        pinned = await this.reads.pinReady(assetId, request.id, reader);
        if (pinned) break;
        await setTimeout(1000, undefined, { signal: operation });
      }
    } catch (error) {
      const cacheId = await this.reads.releaseConsumer(request.id, reader);
      if (cacheId) await removeUnused(cacheId);
      throw error;
    }
    const entry = pinned;
    const folder = join(root, entry.cacheId);
    const localPath = join(folder, entry.fileName);
    let closing = false;
    const check = async () => {
      if (closing) throw unavailable();
      await guard();
      if (!(await this.reads.checkPinned(assetId, request.id, entry.cacheId, entry.leaseId, reader)))
        throw unavailable();
      await guard();
      if (closing) throw unavailable();
    };
    let closeReader: (() => Promise<void>) | undefined;
    const release = async () => {
      if (job?.executorStopUnconfirmed) throw new Error('source_reader_stop_unconfirmed');
      // A lost acknowledgement may already have removed our lease; removal rechecks every remaining owner.
      if (!(await this.cache.release(entry.leaseId, reader, closeReader))) await closeReader?.();
      await removeUnused(entry.cacheId);
    };
    let stream: Awaited<ReturnType<typeof openRenderArtifact>>;
    try {
      closeReader = await beginSourceCacheReader(root, entry.cacheId, entry.leaseId);
      stream = await openRenderArtifact(
        folder,
        {
          outputPath: localPath,
          outputChecksum: Buffer.from(entry.sha256, 'hex'),
          sizeInBytes: entry.bytes,
        },
        check,
        { checkEachChunk: true },
      );
    } catch (error) {
      if (!(error instanceof Error && error.message === 'artifact_close_unconfirmed')) await release();
      throw error;
    }
    const settled = stream.descriptorClosed;
    let releasing: Promise<void> | undefined;
    addAbortSignal(operation, stream);
    return {
      stream,
      byteLength: entry.bytes,
      verifiedSha256: entry.sha256,
      resourceId: entry.resourceId,
      resourceVersion: entry.version,
      // Private borrowed path: never persist as an asset identity; join every tool before release.
      localPath,
      check,
      signal: operation,
      settled,
      release: () => {
        releasing ??= (async () => {
          closing = true;
          stream.destroy();
          await settled;
          await release();
        })().catch((error) => {
          releasing = undefined;
          throw error;
        });
        return releasing;
      },
    };
  }
}
