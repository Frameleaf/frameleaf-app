import { Injectable } from '@nestjs/common';
import z from 'zod';
import type { FrameleafInstanceToken } from 'src/utils/frameleaf-dpop.js';
import { FrameleafCloudRepository, type FrameleafCloudRequest } from 'src/repositories/frameleaf-cloud.repository.js';
import {
  BackupRecoveryPackage,
  BackupSnapshotRecord,
  backupRecoveryPackageSchema,
  backupSnapshotRecordSchema,
} from 'src/utils/cloud-backup-recovery.js';
import {
  BACKUP_COVERAGE_MAX_BYTES,
  BackupCoverageRevisionInput,
  backupCoverageEndpoints,
  backupCoveragePageAcceptedSchema,
  backupCoveragePageInputSchema,
  backupCoverageRevisionInputSchema,
  backupCoverageRevisionSchema,
  backupCoverageRowsPageSchema,
  backupRunCoverageStateSchema,
} from 'src/utils/frameleaf-cloud-backup-coverage.js';
import {
  BACKUP_REPOSITORY_FORMAT,
  BackupAgentSettings,
  BackupGrantMetadata,
  BackupGrantResponse,
  BackupLease,
  BackupLeaseOperation,
  BackupOperation,
  BackupRunReport,
  BackupUsage,
  KeyEscrowBlob,
  KeyEscrowRecord,
  backupAgentSettingsSchema,
  backupCapabilityRequestSchema,
  backupEndpoints,
  backupGrantMetadataSchema,
  backupGrantRequestSchema,
  backupGrantResponseSchema,
  backupLeaseRequestSchema,
  backupLeaseSchema,
  backupLocationsSchema,
  backupRunReportSchema,
  backupUsageSchema,
  keyEscrowBlobSchema,
  keyEscrowRecordSchema,
} from 'src/utils/frameleaf-cloud-backup.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';

/** Where to reach Frameleaf Cloud's API and the DPoP-bound instance token for it (FL-178). */
export type ManagedBackupApi = { api: string; token: FrameleafInstanceToken };

/** Records stay unparsed here: the caller verifies each against its own pinned keys. */
const backupSnapshotListSchema = z.object({
  snapshots: z.array(z.unknown()).max(100),
  nextAfterSequence: z.int().positive().nullable(),
});

/**
 * Frameleaf Cloud's managed backup routes (FL-164, CLD-302; FC-33 BAK-001 and FC-38 BAK-002): the bucket
 * grant and its rotation, the run lease (FL-1676, FC-284), usage, run telemetry, the agent's settings and key
 * escrow. Every grant asks for the chunked repository by name. Every body is checked
 * against the contract before it is sent and every answer after it arrives. The grant's secret is handed
 * to the caller and never kept here, logged or written anywhere.
 */
@Injectable()
export class FrameleafCloudBackupRepository {
  constructor(private cloud: FrameleafCloudRepository) {}

  locations(target: ManagedBackupApi) {
    return this.cloud.requestJson(backupLocationsSchema, {
      url: backupEndpoints(target).locations,
      dpop: target.token,
    });
  }

  /** A persisted claim also survives a failed or interrupted first provisioning attempt. */
  async metadata(target: ManagedBackupApi): Promise<BackupGrantMetadata | null> {
    try {
      return await this.cloud.requestJson(backupGrantMetadataSchema, {
        url: backupEndpoints(target).grantMetadata,
        dpop: target.token,
      });
    } catch (error) {
      if (error instanceof FrameleafCloudError && error.status === 404 && error.envelope?.code === 'not-found') {
        return null;
      }
      throw error;
    }
  }

  /** `POST /v4/backup/grant`: provision at the selected location or read the recorded binding. */
  grant(
    target: ManagedBackupApi,
    locationId: string,
    operation: BackupOperation,
    leaseId?: string,
  ): Promise<BackupGrantMetadata | BackupGrantResponse> {
    return this.issue(z.union([backupGrantResponseSchema, backupGrantMetadataSchema]), {
      method: 'POST',
      url: backupEndpoints(target).grant,
      dpop: target.token,
      // First setup also installs the account's isolated roles and storage binding.
      timeoutMs: 120_000,
      body: backupGrantRequestSchema.parse({
        locationId,
        operation,
        objectFormat: BACKUP_REPOSITORY_FORMAT,
        ...(leaseId && { leaseId }),
      }),
    });
  }

  /**
   * `POST /v4/backup/grant/rotate`: an independent temporary session for the same operation.
   * Existing sessions and multipart state survive renewal. Upload and prune name the run lease they hold.
   */
  rotate(target: ManagedBackupApi, operation: BackupOperation, leaseId?: string): Promise<BackupGrantResponse> {
    return this.issue(backupGrantResponseSchema, {
      method: 'POST',
      url: backupEndpoints(target).rotate,
      dpop: target.token,
      body: backupCapabilityRequestSchema.parse({
        operation,
        objectFormat: BACKUP_REPOSITORY_FORMAT,
        ...(leaseId && { leaseId }),
      }),
    });
  }

  /**
   * `POST /v4/backup/lease`: take the run lease. This server picks `leaseId`, so asking again after a lost
   * answer is the same lease. While another run holds it, Frameleaf Cloud answers 409 `lease-held`.
   */
  acquireLease(target: ManagedBackupApi, leaseId: string, operation: BackupLeaseOperation): Promise<BackupLease> {
    return this.cloud.requestJson(backupLeaseSchema, {
      method: 'POST',
      url: backupEndpoints(target).lease,
      dpop: target.token,
      body: backupLeaseRequestSchema.parse({ leaseId, operation }),
    });
  }

  /** `POST /v4/backup/lease/heartbeat`: keep the lease. 409 `lease-lost` once it is gone. */
  heartbeatLease(target: ManagedBackupApi, leaseId: string): Promise<BackupLease> {
    return this.cloud.requestJson(backupLeaseSchema, {
      method: 'POST',
      url: backupEndpoints(target).leaseHeartbeat,
      dpop: target.token,
      body: { leaseId: z.uuid().parse(leaseId) },
    });
  }

  /** `DELETE /v4/backup/lease`: give the lease back, so the next run need not wait for it to run out. */
  async releaseLease(target: ManagedBackupApi, leaseId: string): Promise<void> {
    await this.cloud.requestJson(z.unknown(), {
      method: 'DELETE',
      url: `${backupEndpoints(target).lease}?leaseId=${encodeURIComponent(z.uuid().parse(leaseId))}`,
      dpop: target.token,
    });
  }

  private async issue<T extends z.ZodType>(schema: T, request: FrameleafCloudRequest): Promise<z.infer<T>> {
    const { data, serverTime, elapsedMs } = await this.cloud.requestJsonTimed(schema, request);
    if (data && typeof data === 'object' && 'capability' in data) {
      const capability = (data as unknown as BackupGrantResponse).capability;
      const lifetime = Date.parse(capability.expiresAt) - serverTime;
      if (!Number.isFinite(lifetime) || lifetime > 901_000 || lifetime - elapsedMs <= 31_000) {
        throw new Error('Frameleaf Cloud returned an unusable temporary backup lifetime.');
      }
      capability.refreshAfterSec = Math.min(capability.refreshAfterSec, Math.floor((lifetime - elapsedMs) / 1000) - 30);
    }
    return data;
  }

  usage(target: ManagedBackupApi): Promise<BackupUsage> {
    return this.cloud.requestJson(backupUsageSchema, { url: backupEndpoints(target).usage, dpop: target.token });
  }

  /** Run telemetry; refused here when it would carry anything the contract does not allow. */
  async reportRun(target: ManagedBackupApi, report: BackupRunReport): Promise<void> {
    const body = backupRunReportSchema.parse(report);
    await this.cloud.requestJson(z.unknown(), {
      method: 'POST',
      url: backupEndpoints(target).runs,
      dpop: target.token,
      body,
    });
  }

  async putSettings(target: ManagedBackupApi, settings: BackupAgentSettings): Promise<void> {
    const body = backupAgentSettingsSchema.parse(settings);
    await this.cloud.requestJson(z.unknown(), {
      method: 'PUT',
      url: backupEndpoints(target).settings,
      dpop: target.token,
      body,
    });
  }

  async putEscrow(target: ManagedBackupApi, blob: KeyEscrowBlob): Promise<void> {
    const body = keyEscrowBlobSchema.parse(blob);
    await this.cloud.requestJson(z.unknown(), {
      method: 'PUT',
      url: backupEndpoints(target).escrow,
      dpop: target.token,
      body,
    });
  }

  getEscrow(target: ManagedBackupApi): Promise<KeyEscrowRecord> {
    return this.cloud.requestJson(keyEscrowRecordSchema, { url: backupEndpoints(target).escrow, dpop: target.token });
  }

  async deleteEscrow(target: ManagedBackupApi): Promise<void> {
    await this.cloud.requestJson(z.unknown(), {
      method: 'DELETE',
      url: backupEndpoints(target).escrow,
      dpop: target.token,
    });
  }

  /** Additive v2 opaque metadata. Root keys and recovery passphrases remain local. */
  async reportSnapshot(target: ManagedBackupApi, snapshot: BackupSnapshotRecord): Promise<void> {
    const { descriptor, signature } = backupSnapshotRecordSchema.parse(snapshot);
    await this.cloud.requestJson(backupSnapshotRecordSchema, {
      method: 'POST',
      url: `${target.api.replace(/\/+$/, '')}/v2/backup/snapshots`,
      dpop: target.token,
      body: { descriptor, signature },
    });
  }

  /** FL-697: every signed record Cloud holds for the vault after `afterSequence`, oldest first. Unverified. */
  async listSnapshots(target: ManagedBackupApi, vaultId: string, afterSequence: number): Promise<unknown[]> {
    const records: unknown[] = [];
    // A trusted history holds at most 100,000 snapshots (100 per page).
    for (let after: number | null = afterSequence, pages = 0; after !== null; pages++) {
      if (pages >= 1000) throw new Error('Frameleaf Cloud returned more snapshot pages than a history can hold');
      const url = new URL(`${target.api.replace(/\/+$/, '')}/v2/backup/snapshots`);
      url.search = new URLSearchParams({ vaultId, afterSequence: String(after), limit: '100' }).toString();
      const page = await this.cloud.requestJson(backupSnapshotListSchema, { url: url.href, dpop: target.token });
      records.push(...page.snapshots);
      if (page.nextAfterSequence !== null && page.nextAfterSequence <= after)
        throw new Error('Frameleaf Cloud snapshot pages did not advance');
      after = page.nextAfterSequence;
    }
    return records;
  }

  /* FL-362, FC-149: numeric run coverage. Every body is checked against the contract before it is sent. */

  /** `POST …/coverage/revisions`: begin an immutable revision header (an identical retry is accepted). */
  beginCoverage(target: ManagedBackupApi, runId: string, header: BackupCoverageRevisionInput) {
    return this.cloud.requestJson(backupCoverageRevisionSchema, {
      method: 'POST',
      url: backupCoverageEndpoints(target.api, runId).begin,
      dpop: target.token,
      body: backupCoverageRevisionInputSchema.parse(header),
    });
  }

  /**
   * `PUT …/pages/:pageIndex`: one page, sent as the exact text written when the report was made, so a
   * retry is byte-for-byte the first attempt.
   */
  putCoveragePage(target: ManagedBackupApi, runId: string, revisionId: string, pageIndex: number, body: string) {
    backupCoveragePageInputSchema.parse(JSON.parse(body));
    if (Buffer.byteLength(body, 'utf8') > BACKUP_COVERAGE_MAX_BYTES) {
      throw new Error('A coverage page exceeds the contract’s byte limit');
    }
    return this.cloud.requestJson(backupCoveragePageAcceptedSchema, {
      method: 'PUT',
      url: backupCoverageEndpoints(target.api, runId).page(z.uuid().parse(revisionId), pageIndex),
      dpop: target.token,
      raw: { contentType: 'application/json', body },
    });
  }

  /** `POST …/finalize`: publish the complete revision; a retry after a lost answer is safe. */
  finalizeCoverage(target: ManagedBackupApi, runId: string, revisionId: string) {
    return this.cloud.requestJson(backupCoverageRevisionSchema, {
      method: 'POST',
      url: backupCoverageEndpoints(target.api, runId).finalize(z.uuid().parse(revisionId)),
      dpop: target.token,
      body: {},
    });
  }

  /** `GET …/coverage`: the published and pending revision of a run. */
  getCoverageState(target: ManagedBackupApi, runId: string) {
    return this.cloud.requestJson(backupRunCoverageStateSchema, {
      url: backupCoverageEndpoints(target.api, runId).state,
      dpop: target.token,
    });
  }

  /** `GET …/revisions/:revisionId/pages`: one published page, then the next with its cursor. */
  getCoveragePage(target: ManagedBackupApi, runId: string, revisionId: string, afterPage: string | null) {
    return this.cloud.requestJson(backupCoverageRowsPageSchema, {
      url: backupCoverageEndpoints(target.api, runId).pages(z.uuid().parse(revisionId), afterPage),
      dpop: target.token,
    });
  }

  async putRecoveryPackage(target: ManagedBackupApi, value: BackupRecoveryPackage): Promise<void> {
    await this.cloud.requestJson(z.unknown(), {
      method: 'PUT',
      url: `${target.api.replace(/\/+$/, '')}/v2/backup/escrow`,
      dpop: target.token,
      body: backupRecoveryPackageSchema.parse(value),
    });
  }

  async deleteRecoveryPackages(target: ManagedBackupApi, vaultId: string): Promise<void> {
    z.uuid().parse(vaultId);
    const url = `${target.api.replace(/\/+$/, '')}/v2/backup/escrow?vaultId=${encodeURIComponent(vaultId)}`;
    const list = await this.cloud.requestJson(
      z.strictObject({
        packages: z.array(backupRecoveryPackageSchema.extend({ updatedAt: z.iso.datetime() })).max(100),
      }),
      { url, dpop: target.token },
    );
    for (const blob of list.packages) {
      if (blob.vaultId !== vaultId) throw new Error('Recovery package belongs to another vault');
      await this.cloud.requestJson(z.unknown(), {
        method: 'DELETE',
        url: `${url}&keyVersion=${blob.keyVersion}`,
        dpop: target.token,
      });
    }
  }
}
