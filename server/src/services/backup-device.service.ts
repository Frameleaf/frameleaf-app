import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { BackupDeviceTable, BackupReconciliationTable } from 'src/schema/tables/backup-device.table.js';
import {
  BackupDeviceDto,
  BackupDeviceListDto,
  BackupDevicePageDto,
  BackupDeviceWriteDto,
  ReconciliationBucketDto,
  ReconciliationHistoryDto,
  ReconciliationResultDto,
  ReconciliationStartDto,
} from 'src/dtos/backup-device.dto.js';
import { PushEventType } from 'src/enum.js';
import { BackupDeviceRepository } from 'src/repositories/backup-device.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { requireReconciliationScope } from 'src/utils/backup-reconciliation.js';

const mapDevice = (row: Selectable<BackupDeviceTable>): BackupDeviceDto => ({
  id: row.id,
  ownerId: row.ownerId,
  deviceKey: row.deviceKey,
  displayName: row.displayName,
  model: row.model,
  platform: row.platform,
  appVersion: row.appVersion,
  reportedAt: row.reportedAt.toISOString(),
  lastSuccessfulBackupAt: row.lastSuccessfulBackupAt?.toISOString() ?? null,
  pendingCount: row.pendingCount,
  quietForDays: row.lastSuccessfulBackupAt
    ? Math.max(0, Math.floor((Date.now() - row.lastSuccessfulBackupAt.getTime()) / 86_400_000))
    : null,
});
const mapRun = (row: Selectable<BackupReconciliationTable>, missingHashes: string[] = []): ReconciliationResultDto => ({
  id: row.id,
  deviceId: row.deviceId,
  startedAt: row.startedAt.toISOString(),
  checkedAt: row.checkedAt.toISOString(),
  completedAt: row.completedAt?.toISOString() ?? null,
  differingBuckets: row.progress.differing,
  pendingBuckets: row.progress.differing.filter((i) => !row.progress.completed.includes(i)),
  itemsChecked: row.itemsChecked,
  itemsMissing: row.itemsMissing,
  missingHashes,
  evidence: 'registered-current-originals',
});

@Injectable()
export class BackupDeviceService {
  constructor(
    private repository: BackupDeviceRepository,
    private events: EventRepository,
  ) {}
  private owner(auth: AuthDto) {
    if (auth.sharedLink) throw new ForbiddenException('Backup devices require an owner session');
  }
  async register(auth: AuthDto, dto: BackupDeviceWriteDto): Promise<BackupDeviceDto> {
    this.owner(auth);
    if (dto.lastSuccessfulBackupAt && new Date(dto.lastSuccessfulBackupAt).getTime() > Date.now())
      throw new BadRequestException('Backup success cannot be in the future');
    return mapDevice(await this.repository.register(auth.user.id, dto));
  }
  async list(auth: AuthDto, page: BackupDevicePageDto, admin = false): Promise<BackupDeviceListDto> {
    this.owner(auth);
    if (admin && !auth.user.isAdmin) throw new ForbiddenException('Admin access required');
    const rows = await this.repository.list(admin ? undefined : auth.user.id, page);
    return {
      devices: rows.slice(0, page.limit).map((row) => mapDevice(row)),
      nextOffset: rows.length > page.limit ? page.offset + page.limit : null,
    };
  }
  async remove(auth: AuthDto, id: string): Promise<void> {
    this.owner(auth);
    await this.repository.remove(auth.user.id, id);
  }
  async start(auth: AuthDto, id: string, dto: ReconciliationStartDto): Promise<ReconciliationResultDto> {
    requireReconciliationScope(auth);
    const run = await this.repository.start(auth, id, dto);
    await this.announceMissing(run);
    return mapRun(run);
  }
  async submit(
    auth: AuthDto,
    id: string,
    runId: string,
    dto: ReconciliationBucketDto,
  ): Promise<ReconciliationResultDto> {
    requireReconciliationScope(auth);
    const result = await this.repository.submit(auth, id, runId, dto);
    await this.announceMissing(result.run);
    return mapRun(result.run, result.missingHashes);
  }
  /**
   * FL-228: a finished reconciliation that found items missing from the server needs the owner. A
   * replayed bucket returns the same finished run; the dedupe key keeps that to one notice.
   */
  private async announceMissing(run: Selectable<BackupReconciliationTable>) {
    if (!run.completedAt || run.itemsMissing <= 0) return;
    await this.events.emit('PushNotify', {
      type: PushEventType.BackupNeedsAttention,
      userIds: [run.ownerId],
      title: 'Backup needs attention',
      body:
        run.itemsMissing === 1
          ? 'One item on this device is not on your server yet'
          : `${run.itemsMissing} items on this device are not on your server yet`,
      systemTemplate:
        run.itemsMissing === 1
          ? { version: 1, key: 'reconciliation-missing-one', args: {} }
          : { version: 1, key: 'reconciliation-missing-many', args: { count: run.itemsMissing } },
      data: { deviceId: run.deviceId, itemsMissing: run.itemsMissing, reason: 'reconciliation-missing' },
      dedupeKey: `backup-attention/${run.id}`,
      delayMs: 30_000,
    });
  }
  async history(auth: AuthDto, id: string, page: BackupDevicePageDto): Promise<ReconciliationHistoryDto> {
    requireReconciliationScope(auth);
    const rows = await this.repository.history(auth.user.id, id, page);
    return {
      runs: rows.slice(0, page.limit).map((row) => {
        const { missingHashes: _, ...run } = mapRun(row);
        return run;
      }),
      nextOffset: rows.length > page.limit ? page.offset + page.limit : null,
    };
  }
}
