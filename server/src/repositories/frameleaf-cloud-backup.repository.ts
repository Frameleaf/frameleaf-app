import { Injectable } from '@nestjs/common';
import z from 'zod';
import type { FrameleafInstanceToken } from 'src/utils/frameleaf-dpop.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import {
  BackupAgentSettings,
  BackupGrantMetadata,
  BackupGrantResponse,
  BackupRunReport,
  BackupUsage,
  KeyEscrowBlob,
  KeyEscrowRecord,
  backupAgentSettingsSchema,
  backupEndpoints,
  backupGrantMetadataSchema,
  backupGrantResponseSchema,
  backupRunReportSchema,
  backupUsageSchema,
  keyEscrowBlobSchema,
  keyEscrowRecordSchema,
} from 'src/utils/frameleaf-cloud-backup.js';

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

  /** `POST /v1/backup/grant`: provision (201, with a key) or read (200, without) this server's bucket. */
  grant(target: ManagedBackupApi): Promise<BackupGrantMetadata | BackupGrantResponse> {
    return this.cloud.requestJson(z.union([backupGrantResponseSchema, backupGrantMetadataSchema]), {
      method: 'POST',
      url: backupEndpoints(target).grant,
      dpop: target.token,
      body: {},
    });
  }

  /**
   * `POST /v1/backup/grant/rotate`: a new bucket-scoped key; the previous one is revoked before the answer
   * comes back. Called at the start of every operation that touches the bucket.
   */
  rotate(target: ManagedBackupApi): Promise<BackupGrantResponse> {
    return this.cloud.requestJson(backupGrantResponseSchema, {
      method: 'POST',
      url: backupEndpoints(target).rotate,
      dpop: target.token,
      body: {},
    });
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
}
