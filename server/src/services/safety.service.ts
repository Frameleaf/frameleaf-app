import { Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { SafetyLookupDto, SafetyLookupResponseDto, SafetySummaryDto } from 'src/dtos/safety.dto.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';

const date = (value: Date | null) => value?.toISOString() ?? null;
const percent = (count: number, total: number) => (total === 0 ? 0 : (100 * count) / total);

@Injectable()
export class SafetyService {
  constructor(
    private integrity: IntegrityRepository,
    private index: CloudBackupIndexRepository,
    private cloud: CloudBackupService,
  ) {}

  async lookup(auth: AuthDto, dto: SafetyLookupDto): Promise<SafetyLookupResponseDto> {
    const availability = await this.cloud.getSafetyAvailability();
    const assets = await this.index.getSafetyAssets(
      this.integrity.getSafetyQuery(auth, [...new Set(dto.hashes)]),
      availability.bucket,
    );
    return {
      cloudAvailability: availability.state,
      cloudReadOnly: availability.readOnly,
      cloudReadOnlyReason: availability.readOnlyReason,
      assets: assets.map((row) => ({
        id: row.id,
        sha256: row.sha256!,
        deliveredBy: row.deliveredBy,
        onServerSince: row.onServerSince.toISOString(),
        lastIntegrityAt: date(row.lastIntegrityAt),
        integrityResult: row.integrityResult ?? 'unknown',
        cloudBackup: {
          state: row.backedUpSince ? 'completed' : availability.bucket ? 'not-backed-up' : 'unavailable',
          since: date(row.backedUpSince),
          lastVerifiedRunAt: date(row.lastVerifiedAt),
        },
      })),
    };
  }

  async summary(auth: AuthDto): Promise<SafetySummaryDto> {
    const availability = await this.cloud.getSafetyAvailability();
    const row = await this.index.getSafetySummary(this.integrity.getSafetyQuery(auth), availability.bucket);
    return {
      cloudAvailability: availability.state,
      cloudReadOnly: availability.readOnly,
      cloudReadOnlyReason: availability.readOnlyReason,
      total: row.total,
      onServer: row.onServer,
      fromICloudSync: row.fromICloudSync,
      onServerPercent: percent(row.onServer, row.total),
      backedUp: availability.bucket ? row.backedUp : null,
      backedUpPercent: availability.bucket ? percent(row.backedUp, row.total) : null,
      lastCompletedRunAt: date(row.lastCompletedAt),
      lastVerifiedRunAt: date(row.lastVerifiedAt),
    };
  }
}
