import { Injectable } from '@nestjs/common';
import { AssetType, MediaOperationStatus } from 'src/enum.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { ScheduledAuditAuthority } from 'src/repositories/icloud-scheduled-authority.js';
import { ScheduledPublicationFiles } from 'src/repositories/icloud-scheduled-publication.js';
import { ICloudScheduledWorkerRepository } from 'src/repositories/icloud-scheduled-worker.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { ICloudScheduledStagingService } from 'src/services/icloud-scheduled-staging.service.js';
import { MediaRecoveryService } from 'src/services/media-recovery.service.js';

/** Source seam only. Qualification and actual scheduler registration are separate deployment gates. */
export const scheduledAuditExecutionEnabled = () => process.env.FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION === 'true';

@Injectable()
export class ICloudScheduledWorkerService {
  constructor(
    private repository: ICloudScheduledWorkerRepository,
    private identities: ICloudIdentityRepository,
    private staging: ICloudScheduledStagingService,
    private recovery: MediaRecoveryService,
    private operations: MediaOperationRepository,
    private transport: ICloudTransportRepository,
  ) {}

  housekeeping() {
    return this.staging.housekeeping();
  }

  async run(operation: MediaOperation, claimToken: string) {
    const requests = await this.repository.dispatch(operation, claimToken);
    if (!requests) {
      await this.operations.fail(
        operation.id,
        claimToken,
        { error: 'Invalid iCloud task', errorCode: 'icloud_snapshot_invalid' },
        { retry: false },
      );
      return;
    }
    const initialState = await this.repository.stopState(operation.id, operation.ownerId, claimToken);
    if (!initialState?.live) {
      return;
    }
    if (initialState.cancelRequestedAt) {
      await this.repository.cancelRemaining(
        {
          purpose: 'scheduled-weekly',
          auditRequestId: requests[0].id,
          operationId: operation.id,
          operationClaimToken: claimToken,
        },
        operation.ownerId,
      );
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
      return;
    }
    if (initialState.pauseRequestedAt) {
      await this.operations.settlePause(operation.id, claimToken);
      return;
    }
    if (!scheduledAuditExecutionEnabled() || !this.transport.enabled()) {
      // Keep exact frozen generation and queued work. A default-disabled worker does not report success.
      await this.operations.requeue(operation.id, claimToken, { delayMs: 30 * 60_000, returnAttempt: true });
      return;
    }
    if (
      !(await this.operations.reportProgress(operation.id, claimToken, {
        status: MediaOperationStatus.Rendering,
        processedUnits: 0,
        totalUnits: requests.length,
        progress: 0,
      }))
    ) {
      return;
    }
    let processed = 0;
    let unavailable = requests.some(({ result }) => ['failed', 'stale', 'cancelled'].includes(result));
    for (const request of requests) {
      if (['match', 'mismatch', 'failed', 'stale', 'cancelled'].includes(request.result)) {
        processed++;
        continue;
      }
      const authority: ScheduledAuditAuthority = {
        purpose: 'scheduled-weekly',
        auditRequestId: request.id,
        operationId: operation.id,
        operationClaimToken: claimToken,
      };
      const holder = `icloud-sync:audit:${operation.id}`;
      let itemClaimId: string | undefined;
      const controller = new AbortController();
      let checking: Promise<void> | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      let allocated:
        | { authority: ScheduledAuditAuthority; ownerId: string; resource: { id: string; leaseToken: string } }
        | undefined;
      try {
        const initial = await this.repository.check(authority, operation.ownerId, false);
        if (!initial) {
          throw new Error('scheduled_audit_unavailable');
        }
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
        itemClaimId = claim.id;
        if (!(await this.repository.bindClaim(authority, operation.ownerId, claim.id))) {
          throw new Error('scheduled_audit_unavailable');
        }
        const resource = await this.repository.allocate(authority, operation.ownerId);
        if (!resource) {
          await this.operations.requeue(operation.id, claimToken, { delayMs: 60_000, returnAttempt: true });
          return;
        }
        const input = {
          authority,
          ownerId: operation.ownerId,
          resource: { id: resource.id, leaseToken: resource.leaseToken! },
        };
        allocated = input;
        timer = setInterval(() => {
          if (!checking) {
            checking = (async () => {
              const renewed = await this.identities.renew(operation.ownerId, [claim.id], holder, 1800);
              const live = await this.repository.renewOperation(operation.id, operation.ownerId, claimToken);
              if (renewed.length !== 1 || !live || !(await this.repository.check(authority, operation.ownerId))) {
                controller.abort();
              }
            })()
              .catch(() => controller.abort())
              .finally(() => {
                checking = undefined;
              });
          }
        }, 15_000);
        const receipt = await this.staging.download(input, controller.signal);
        const validation = await this.staging.validate(input, controller.signal);
        const result = await validation.result;
        if (result.status !== 'validated' || controller.signal.aborted) {
          throw new Error('scheduled_audit_unavailable');
        }
        await validation.settled;
        const current = await this.repository.check(authority, operation.ownerId);
        if (!current || controller.signal.aborted) {
          throw new Error('scheduled_audit_unavailable');
        }
        if (result.verified.sha256.equals(current.request.expectedSha256)) {
          const files = await this.staging.holdPublicationFiles(input, controller.signal);
          try {
            if (!(await this.repository.publishMatch(input, files, result.verified))) {
              throw new Error('scheduled_audit_unavailable');
            }
          } finally {
            await files.release();
          }
        } else {
          const type = resource.source.type;
          if (type !== AssetType.Image && type !== AssetType.Video) {
            throw new Error('scheduled_audit_unavailable');
          }
          const publication: ScheduledPublicationFiles = {
            receipt,
            validation: result.validation,
            current: () => Promise.resolve(false),
            paths: [],
          };
          const heldFiles: Array<Awaited<ReturnType<ICloudScheduledStagingService['holdPublicationFiles']>>> = [];
          try {
            const recovered = await this.recovery.reconcile({
              resourceId: resource.id,
              leaseToken: resource.leaseToken!,
              ownerId: operation.ownerId,
              includeHidden: current.private,
              audit: authority,
              scheduled: publication,
              stagedPath: receipt.payload.path,
              type,
              sourceHidden: current.private,
              originalFileName:
                typeof resource.source.originalFileName === 'string' ? resource.source.originalFileName : resource.id,
              scheduledVerified: result.verified,
              scheduledValidate: async (path) => {
                const destination = await this.staging.validate(input, controller.signal, path);
                const outcome = await destination.result;
                if (outcome.status !== 'validated') {
                  throw new Error('scheduled_audit_unavailable');
                }
                await destination.settled;
                const files = await this.staging.holdPublicationFiles(input, controller.signal, path);
                heldFiles.push(files);
                publication.paths = files.paths;
                publication.current = files.current;
                publication.validation = files.validation;
                return outcome.verified;
              },
            });
            if (!['imported', 'reused'].includes(recovered.outcome)) {
              throw new Error('scheduled_audit_unavailable');
            }
          } finally {
            await Promise.allSettled(heldFiles.map((files) => Promise.try(() => files.release()))).then((releases) => {
              const failures = releases
                .filter((release) => release.status === 'rejected')
                .map((release) => release.reason);
              if (failures.length > 0) throw new AggregateError(failures, 'scheduled_audit_release_failed');
            });
          }
        }
      } catch {
        const state = await this.repository.stopState(operation.id, operation.ownerId, claimToken);
        if (!state?.live) {
          return;
        }
        if (state.pauseRequestedAt && !state.cancelRequestedAt) {
          await this.operations.settlePause(operation.id, claimToken);
          return;
        }
        unavailable = true;
        await this.repository.settleUnavailable(
          authority,
          operation.ownerId,
          state.cancelRequestedAt ? 'cancelled' : 'unavailable',
        );
        if (allocated) {
          void this.staging.cleanupRetired(allocated);
        }
        if (state.cancelRequestedAt) {
          await this.repository.cancelRemaining(authority, operation.ownerId);
          await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
          return;
        }
      } finally {
        clearInterval(timer);
        controller.abort();
        await checking;
        if (itemClaimId) {
          await this.identities.release(operation.ownerId, [itemClaimId], holder);
        }
      }
      processed++;
      if (
        !(await this.operations.reportProgress(operation.id, claimToken, {
          status: MediaOperationStatus.Rendering,
          processedUnits: processed,
          totalUnits: requests.length,
          progress: Math.floor((processed * 100) / requests.length),
        }))
      ) {
        return;
      }
    }
    if (unavailable) {
      await this.operations.fail(
        operation.id,
        claimToken,
        { error: 'iCloud audit did not complete', errorCode: 'icloud_audit_unavailable' },
        { retry: false },
      );
      return;
    }
    if (
      (await this.operations.beginValidation(operation.id, claimToken, true)) &&
      (await this.operations.complete(operation.id, claimToken, { resultAssetId: null }, undefined, true))
    ) {
      return;
    }
    await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
  }
}
