import { Injectable, Optional } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudVerifyDto } from 'src/dtos/icloud-identity.dto.js';
import { AssetType, JobName, MediaOperationStatus } from 'src/enum.js';
import {
  AuditAuthority,
  ICloudAuditRepository,
  manualAuditClaimHolder,
} from 'src/repositories/icloud-audit.repository.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { ICloudResource, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { ICloudScheduledWorkerService } from 'src/services/icloud-scheduled-worker.service.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaRecoveryService } from 'src/services/media-recovery.service.js';
import { hasWeeklyAuthorityInput } from 'src/utils/icloud-weekly.js';

class AuditInterrupted extends Error {}

/** One durable audit lane, dispatched by the existing iCloud worker. */
@Injectable()
export class ICloudAuditService {
  constructor(
    private repository: ICloudAuditRepository,
    private sync: ICloudSyncRepository,
    private identities: ICloudIdentityRepository,
    private transport: ICloudTransportRepository,
    private staging: ICloudStagingService,
    private integrity: MediaIntegrityService,
    private recovery: MediaRecoveryService,
    private operations: MediaOperationRepository,
    private jobs: JobRepository,
    @Optional() private scheduled?: ICloudScheduledWorkerService,
  ) {}

  submit(auth: AuthDto, dto: ICloudVerifyDto) {
    return this.repository.submit(auth, dto, this.operations);
  }

  async housekeeping() {
    await this.scheduled?.housekeeping?.();
    await this.repository.housekeeping(async (resource, db) => {
      if (resource.assetId) {
        const asset = await db
          .selectFrom('asset')
          .select('id')
          .where('id', '=', resource.assetId)
          .where('ownerId', '=', resource.ownerId)
          .where('deletedAt', 'is', null)
          .forShare()
          .executeTakeFirst();
        for (const job of resource.pendingJobs) {
          if (
            job.data.id !== resource.assetId ||
            ![JobName.AssetExtractMetadata, JobName.AssetGenerateThumbnails].includes(job.name as JobName)
          ) {
            throw new Error('audit_outbox_binding_invalid');
          }
          if (asset) {
            if (job.name === JobName.AssetExtractMetadata) {
              await this.jobs.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });
            } else {
              await this.jobs.queue({ name: JobName.AssetGenerateThumbnails, data: { id: asset.id } });
            }
          }
        }
      } else if (resource.pendingJobs.length > 0) {
        throw new Error('audit_outbox_binding_invalid');
      }
      await this.staging.cleanup(resource);
    });
  }

  isAuditOperation(operation: MediaOperation) {
    return this.repository.operationPurpose(operation.id, operation.ownerId);
  }

  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    const purpose = await this.repository.operationPurpose(operation.id, operation.ownerId);
    if (purpose === 'scheduled-weekly' && this.scheduled) {
      await this.scheduled.run(operation, claimToken);
      return;
    }
    if (purpose && purpose !== 'manual-session') {
      await this.operations.fail(
        operation.id,
        claimToken,
        { error: 'Invalid iCloud task', errorCode: 'icloud_snapshot_invalid' },
        { retry: false },
      );
      return;
    }
    const ids = operation.snapshot.auditIds;
    if (
      operation.snapshot.task !== 'identity-audit' ||
      hasWeeklyAuthorityInput(operation.snapshot) ||
      (operation.snapshot.purpose !== undefined && operation.snapshot.purpose !== 'manual-session') ||
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id))
    ) {
      await this.operations.fail(
        operation.id,
        claimToken,
        { error: 'Invalid audit request', errorCode: 'icloud_audit_snapshot_invalid' },
        { retry: false },
      );
      return;
    }
    if (!this.transport.enabled()) {
      await this.operations.fail(
        operation.id,
        claimToken,
        { error: 'iCloud is unavailable', errorCode: 'icloud_disabled' },
        { retry: false },
      );
      return;
    }
    const started = await this.operations.reportProgress(operation.id, claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: 0,
      totalUnits: ids.length,
      progress: 0,
    });
    if (!started) {
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true, requireActiveClaim: true });
      return;
    }
    const heartbeat = setInterval(() => {
      void this.operations.heartbeat(operation.id, claimToken, 30 * 60_000).catch(() => {});
    }, 15_000);
    let interrupted = false;
    let cleanupComplete = true;
    const waitForCapacity = async () => {
      if (
        !(await this.operations.requeue(operation.id, claimToken, {
          delayMs: 60_000,
          returnAttempt: true,
          requireActiveClaim: true,
        }))
      ) {
        await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true, requireActiveClaim: true });
      }
    };
    const stopIfInterrupted = async () => {
      const state = await this.repository.stopState(operation.id, operation.ownerId, claimToken);
      if (!state?.live || state.cancelRequestedAt || state.pauseRequestedAt) {
        interrupted = true;
        throw new AuditInterrupted();
      }
    };
    try {
      for (const id of ids as string[]) {
        const authority: AuditAuthority = {
          auditRequestId: id,
          operationId: operation.id,
          operationClaimToken: claimToken,
        };
        const request = await this.repository.get(id, operation.ownerId);
        if (!request || request.operationId !== operation.id) {
          throw new Error('audit_authority_changed');
        }
        if (['match', 'mismatch'].includes(request.result)) {
          continue;
        }
        const initial = await this.repository.check(authority, operation.ownerId, false);
        if (!initial) {
          await stopIfInterrupted();
          throw new Error('audit_authority_changed');
        }
        const holder = manualAuditClaimHolder(operation.ownerId, authority);
        const [claim] = await this.identities.claim(
          operation.ownerId,
          [initial.source.sourceAssetId.toUpperCase()],
          holder,
          1800,
        );
        if (!claim || claim.holder !== holder) {
          await waitForCapacity();
          return;
        }
        cleanupComplete = false;
        let resource: ICloudResource | undefined;
        try {
          await this.repository.setItemClaim(id, operation.ownerId, claim.id);
          resource = await this.repository.allocate(authority, operation.ownerId);
        } catch (error) {
          // Allocation may have an ambiguous failure. Attempt claim release, preserve the first
          // failure, and never report all resources released without an authoritative outcome.
          try {
            await this.identities.release(operation.ownerId, [claim.id], holder);
          } catch {
            cleanupComplete = false;
          }
          throw error;
        }
        if (!resource) {
          await this.identities.release(operation.ownerId, [claim.id], holder);
          cleanupComplete = true;
          await waitForCapacity();
          return;
        }
        let workFailed = false;
        let workFailure: unknown;
        let cleanupFailed = false;
        let cleanupFailure: unknown;
        try {
          const check = async () => {
            const renewed = await this.identities.renew(operation.ownerId, [claim.id], holder, 1800);
            const allowed = renewed.length === 1 && !!(await this.repository.check(authority, operation.ownerId));
            if (!allowed) await stopIfInterrupted();
            return allowed;
          };
          const path = await this.staging.download(initial.connection, resource, check);
          resource.stagingPath = path;
          const type = resource.source.type;
          if (type !== AssetType.Image && type !== AssetType.Video) {
            throw new Error('audit_media_unsupported');
          }
          const originalFileName =
            typeof resource.source.originalFileName === 'string' ? resource.source.originalFileName : resource.id;
          const validate = () =>
            this.integrity.validate({
              path,
              originalFileName,
              type,
              expected: { sizeInBytes: resource.expectedSize },
              deep: true,
            });
          const verified = await validate();
          if (verified.status !== 'healthy') {
            throw new Error('audit_validation_failed');
          }
          const current = await this.repository.check(authority, operation.ownerId);
          if (!current) {
            await stopIfInterrupted();
            throw new Error('audit_authority_changed');
          }
          if (verified.sha256.equals(current.request.expectedSha256)) {
            if (!(await this.repository.publishMatch(authority, resource, verified, validate))) {
              await stopIfInterrupted();
              throw new Error('audit_authority_changed');
            }
          } else {
            const result = await this.recovery.reconcile({
              resourceId: resource.id,
              ownerId: operation.ownerId,
              leaseToken: resource.leaseToken!,
              includeHidden: current.private,
              audit: authority,
              stagedPath: path,
              originalFileName,
              type,
              sourceHidden: current.private,
              sourceCreatedAt:
                typeof resource.source.fileCreatedAt === 'string' ? new Date(resource.source.fileCreatedAt) : undefined,
            });
            if (!['imported', 'reused'].includes(result.outcome)) {
              if (
                result.outcome === 'retry' &&
                typeof result.reason === 'string' &&
                ['lease_unavailable', 'reservation_changed', 'manual_audit_authority_changed'].includes(result.reason)
              )
                await stopIfInterrupted();
              throw new Error('audit_mismatch_not_committed');
            }
          }
        } catch (error) {
          workFailed = true;
          workFailure = error;
        } finally {
          try {
            // A committed receipt owns its bytes independently of this request's credentials.
            const durable = await this.sync.resource(resource.id);
            if (durable && !['committed', 'finalized'].includes(durable.status)) {
              await this.sync.finish(resource, 'retry', 'audit_retry');
            }
          } catch (error) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
          // Independent of resource cleanup: its rejection must never strand this item claim.
          try {
            await this.identities.release(operation.ownerId, [claim.id], holder);
          } catch (error) {
            if (!cleanupFailed) cleanupFailure = error;
            cleanupFailed = true;
          }
          cleanupComplete = !cleanupFailed;
        }
        // Retain a prior work/control failure; the outer handler also checks cleanupComplete.
        if (workFailed) throw workFailure;
        if (cleanupFailed) throw cleanupFailure;
      }
      await this.housekeeping();
      if (
        (await this.operations.beginValidation(operation.id, claimToken, true)) &&
        (await this.operations.complete(operation.id, claimToken, { resultAssetId: null }, undefined, true))
      ) {
        return;
      }
      await stopIfInterrupted();
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true, requireActiveClaim: true });
    } catch (error) {
      if (
        cleanupComplete &&
        (error instanceof AuditInterrupted || (interrupted && error instanceof Error && error.name === 'AbortError'))
      ) {
        // The inner finally has released staging reservations and item claims. A withdrawn pause
        // queues a fresh verification immediately; a current pause holds it without consuming a retry.
        await this.operations.requeue(operation.id, claimToken, {
          delayMs: 0,
          returnAttempt: true,
          requireActiveClaim: true,
        });
        await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true, requireActiveClaim: true });
        return;
      }
      // Failure is generic: no source path, filename, descriptor or credential enters Activity.
      await this.operations.fail(
        operation.id,
        claimToken,
        {
          error: 'iCloud audit did not complete',
          errorCode: 'icloud_audit_failed',
        },
        { requireActiveClaim: true },
      );
      if (cleanupComplete)
        await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true, requireActiveClaim: true });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
