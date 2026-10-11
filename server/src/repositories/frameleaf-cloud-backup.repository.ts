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
  BackupAgentSettings,
  BackupGrantMetadata,
  BackupGrantResponse,
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
  backupLocationsSchema,
  backupRunReportSchema,
  backupUsageSchema,
  keyEscrowBlobSchema,
  keyEscrowRecordSchema,
} from 'src/utils/frameleaf-cloud-backup.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';

/** Where to reach Frameleaf Cloud's API and the DPoP-bound instance token for it (FL-178). */
export type ManagedBackupApi = { api: string; token: FrameleafInstanceToken };

/**
 * Frameleaf Cloud's managed backup routes (FL-164, CLD-302; FC-33 BAK-001 and FC-38 BAK-002): the bucket
 * grant and its rotation, usage, run telemetry, the agent's settings and key escrow. Every body is checked
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
        url: backupEndpoints(target).grant,
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
  ): Promise<BackupGrantMetadata | BackupGrantResponse> {
    return this.issue(z.union([backupGrantResponseSchema, backupGrantMetadataSchema]), {
      method: 'POST',
      url: backupEndpoints(target).grant,
      dpop: target.token,
      body: backupGrantRequestSchema.parse({ locationId, operation }),
    });
  }

  /**
   * `POST /v4/backup/grant/rotate`: an independent temporary session for the same operation.
   * Existing sessions and multipart state survive renewal.
   */
  rotate(target: ManagedBackupApi, operation: BackupOperation): Promise<BackupGrantResponse> {
    return this.issue(backupGrantResponseSchema, {
      method: 'POST',
      url: backupEndpoints(target).rotate,
      dpop: target.token,
      body: backupCapabilityRequestSchema.parse({ operation }),
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
