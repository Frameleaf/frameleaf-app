import { Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudVerifyDto } from 'src/dtos/icloud-identity.dto.js';
import { AssetType, JobName, MediaOperationStatus } from 'src/enum.js';
import { AuditAuthority, ICloudAuditRepository } from 'src/repositories/icloud-audit.repository.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaRecoveryService } from 'src/services/media-recovery.service.js';

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
  ) {}

  submit(auth: AuthDto, dto: ICloudVerifyDto) {
    return this.repository.submit(auth, dto, this.operations);
  }

  async housekeeping() {
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

  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    const ids = operation.snapshot.auditIds;
    if (
      operation.snapshot.task !== 'identity-audit' ||
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
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
      return;
    }
    const heartbeat = setInterval(() => {
      void this.operations.heartbeat(operation.id, claimToken, 30 * 60_000).catch(() => {});
    }, 15_000);
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
          throw new Error('audit_authority_changed');
        }
        const holder = `icloud-sync:audit:${operation.id}`;
        const [claim] = await this.identities.claim(
          operation.ownerId,
          [initial.source.sourceAssetId.toUpperCase()],
          holder,
          1800,
        );
        if (!claim || claim.holder !== holder) {
          await this.operations.requeue(operation.id, claimToken, { delayMs: 60_000, returnAttempt: true });
          return;
        }
        await this.repository.setItemClaim(id, operation.ownerId, claim.id);
        const resource = await this.repository.allocate(authority, operation.ownerId);
        if (!resource) {
          await this.identities.release(operation.ownerId, [claim.id], holder);
          await this.operations.requeue(operation.id, claimToken, { delayMs: 60_000, returnAttempt: true });
          return;
        }
        try {
          const check = async () => {
            const renewed = await this.identities.renew(operation.ownerId, [claim.id], holder, 1800);
            return renewed.length === 1 && !!(await this.repository.check(authority, operation.ownerId));
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
            throw new Error('audit_authority_changed');
          }
          if (verified.sha256.equals(current.request.expectedSha256)) {
            if (!(await this.repository.publishMatch(authority, resource, verified, validate))) {
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
              throw new Error('audit_mismatch_not_committed');
            }
          }
        } finally {
          // A committed receipt owns its bytes independently of this request's credentials.
          const durable = await this.sync.resource(resource.id);
          if (durable && !['committed', 'finalized'].includes(durable.status)) {
            await this.sync.finish(resource, 'retry', 'audit_retry');
          }
          await this.identities.release(operation.ownerId, [claim.id], holder);
        }
      }
      await this.housekeeping();
      if (
        (await this.operations.beginValidation(operation.id, claimToken, true)) &&
        (await this.operations.complete(operation.id, claimToken, { resultAssetId: null }, undefined, true))
      ) {
        return;
      }
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
    } catch {
      // Failure is generic: no source path, filename, descriptor or credential enters Activity.
      await this.operations.fail(operation.id, claimToken, {
        error: 'iCloud audit did not complete',
        errorCode: 'icloud_audit_failed',
      });
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
