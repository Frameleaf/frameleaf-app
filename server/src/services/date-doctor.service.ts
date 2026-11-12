import { BadRequestException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { Selectable } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  DateDoctorFindingsResponseDto,
  DateDoctorFixDto,
  DateDoctorGroup,
  DateDoctorPreviewResponseDto,
  DateFixBatchResponseDto,
} from 'src/dtos/date-doctor.dto.js';
import type { DateFixBatchTable } from 'src/schema/tables/date-fix.table.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AccountEventAction, JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { publishJobResult } from 'src/queue/context.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AccountEventRepository } from 'src/repositories/account-event.repository.js';
import { DateDoctorRepository, type DateFixWrite } from 'src/repositories/date-doctor.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetOriginField, PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { recordAssetEdit } from 'src/services/partner-copy.service.js';
import { requireAccess } from 'src/utils/access.js';
import { detectDateFindings, wallToInstant } from 'src/utils/date-doctor.js';
import { getAssetDateTimeUpdates } from 'src/utils/date.js';

/** FL-930: how long an Apply can be undone; older batches are removed nightly. */
export const DATE_FIX_UNDO_DAYS = 30;

const iso = (date: Date | string) => new Date(date).toISOString();

/**
 * FL-912: the Date & Time Doctor finds photos whose date or time zone is probably wrong and proposes a fix with a
 * reason (`src/utils/date-doctor.ts`). The scan changes nothing. FL-930 applies proposals, or a zone and shift
 * chosen for a selection, the way a bulk date edit does (locked, sidecars rewritten, partner copies following), and
 * undoes them for 30 days.
 *
 * A scan runs per owner, when asked (`POST /date-doctor/scan`) and once a week in the overnight "Check files" step,
 * on the file checks' queue, so that step waits for it.
 */
@Injectable()
export class DateDoctorService {
  constructor(
    private logger: LoggingRepository,
    private jobRepository: JobRepository,
    private dateDoctorRepository: DateDoctorRepository,
    private accessRepository: AccessRepository,
    private accountEventRepository: AccountEventRepository,
    private eventRepository: EventRepository,
    private partnerOriginRepository: PartnerOriginRepository,
  ) {
    this.logger.setContext(DateDoctorService.name);
  }

  async scan(auth: AuthDto): Promise<void> {
    await this.jobRepository.queue({ name: JobName.DateDoctorScan, data: { userId: auth.user.id } });
  }

  async getFindings(auth: AuthDto): Promise<DateDoctorFindingsResponseDto> {
    const rows = await this.dateDoctorRepository.getFindings(auth.user.id);
    const groups = new Map<string, DateDoctorGroup>();
    for (const row of rows) {
      let group = groups.get(row.groupKey);
      if (!group) {
        // the key ends with `|` and the day: a camera's name may hold a `|` of its own
        const separator = row.groupKey.lastIndexOf('|');
        const camera = row.groupKey.slice(0, separator);
        const day = row.groupKey.slice(separator + 1);
        group = { groupKey: row.groupKey, camera: camera === 'unknown' ? null : camera, day, findings: [] };
        groups.set(row.groupKey, group);
      }
      group.findings.push({
        assetId: row.assetId,
        cause: row.cause,
        currentDate: new Date(row.currentDate).toISOString(),
        currentZone: row.currentZone,
        proposedDate: row.proposedDate ? new Date(row.proposedDate).toISOString() : null,
        proposedZone: row.proposedZone,
        confidence: row.confidence,
      });
    }
    return { total: rows.length, groups: groups.values().toArray() };
  }

  @OnJob({ name: JobName.DateDoctorScanQueueAll, queue: QueueName.IntegrityCheck })
  async handleQueueAll(): Promise<JobStatus> {
    const userIds = await this.dateDoctorRepository.getOwnerIds();
    await this.jobRepository.queueAll(
      userIds.map((userId) => ({ name: JobName.DateDoctorScan as const, data: { userId } })),
    );
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.DateDoctorScan, queue: QueueName.IntegrityCheck })
  async handleScan({ userId }: JobOf<JobName.DateDoctorScan>): Promise<JobStatus> {
    const started = Date.now();
    const rows = await this.dateDoctorRepository.getScanRows(userId);
    const findings = detectDateFindings(rows);
    await publishJobResult(() => this.dateDoctorRepository.replaceFindings(userId, findings));
    this.logger.log(
      `Date & Time Doctor: ${findings.length} findings in ${rows.length} photos of ${userId} (${Date.now() - started} ms)`,
    );
    return JobStatus.Success;
  }

  async preview(auth: AuthDto, dto: DateDoctorFixDto): Promise<DateDoctorPreviewResponseDto> {
    const items = await this.plan(auth, dto);
    return {
      items: items.map((item) => ({
        assetId: item.assetId,
        previousDate: iso(item.currentTakenAt),
        previousZone: item.currentZone,
        newDate: iso(item.newDate),
        newZone: item.newZone,
      })),
    };
  }

  async apply(auth: AuthDto, dto: DateDoctorFixDto): Promise<DateFixBatchResponseDto> {
    const items = await this.plan(auth, dto);
    const result = items.length > 0 ? await this.dateDoctorRepository.applyFixes(auth.user.id, items) : undefined;
    if (!result) {
      throw new BadRequestException('Nothing to fix');
    }
    const { batch, assetIds } = result;
    await this.afterDateChange(auth.user.id, assetIds, false);
    try {
      await this.accountEventRepository.create({
        userId: auth.user.id,
        action: AccountEventAction.DatesFixed,
        subject: auth.user.name,
        detail: String(batch.count),
      });
    } catch (error) {
      this.logger.error(`Unable to record account activity (${AccountEventAction.DatesFixed}): ${error}`);
    }
    return toBatchResponse(batch);
  }

  async undo(auth: AuthDto, id: string): Promise<DateFixBatchResponseDto> {
    const since = DateTime.now().minus({ days: DATE_FIX_UNDO_DAYS }).toJSDate();
    const result = await this.dateDoctorRepository.undoBatch(auth.user.id, id, since);
    if (!result) {
      throw new BadRequestException('Batch not found');
    }
    if (result.alreadyUndone) {
      throw new BadRequestException('Already undone');
    }
    const { batch, restored } = result;
    // a date that was not set by hand before goes back to being read from the file, once the sidecar holds it
    const release = new Set(restored.filter(({ previousLocked }) => !previousLocked).map(({ assetId }) => assetId));
    await this.afterDateChange(
      auth.user.id,
      restored.map(({ assetId }) => assetId),
      release,
    );
    return { ...toBatchResponse(batch), restored: restored.length };
  }

  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async onNightlyDatabaseCleanup(): Promise<void> {
    const before = DateTime.now().minus({ days: DATE_FIX_UNDO_DAYS }).toJSDate();
    const removed = await this.dateDoctorRepository.pruneBatches(before);
    if (removed > 0) {
      this.logger.log(`Removed ${removed} Date & Time Doctor batches older than ${DATE_FIX_UNDO_DAYS} days`);
    }
  }

  /**
   * What each photo would get, read from the database: the Doctor's proposal, or the selection's zone (the clock
   * time shown stays) and shift. Only the caller's own photos: a partner's copy, or the original of one, is refused.
   */
  private async plan(auth: AuthDto, dto: DateDoctorFixDto): Promise<(DateFixWrite & { currentZone: string | null })[]> {
    const ids = dto.findings ? dto.findings.map(({ assetId }) => assetId) : (dto.assetIds ?? []);
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetUpdate, ids });
    const proposals = dto.findings
      ? new Map(
          (await this.dateDoctorRepository.getProposals(auth.user.id, dto.findings)).map((row) => [row.assetId, row]),
        )
      : undefined;
    const ordered = new Map(ids.map((id, index) => [id, index]));
    const rows = await this.dateDoctorRepository.getCurrent(auth.user.id, proposals ? proposals.keys().toArray() : ids);
    const items: (DateFixWrite & { currentZone: string | null })[] = [];
    for (const row of rows.toSorted((a, b) => ordered.get(a.assetId)! - ordered.get(b.assetId)!)) {
      const proposal = proposals?.get(row.assetId);
      const shift = (dto.shiftMinutes ?? 0) * 60_000;
      const newZone = proposal ? (proposal.proposedZone ?? row.timeZone) : (dto.timeZone ?? row.timeZone);
      const newDate = proposal
        ? new Date(proposal.proposedDate)
        : dto.timeZone
          ? wallToInstant(new Date(row.localDateTime.getTime() + shift), dto.timeZone)
          : new Date(row.takenAt.getTime() + shift);
      const { localDateTime: newLocalDateTime } = getAssetDateTimeUpdates(newDate.toISOString(), newZone, {
        fileCreatedAt: row.takenAt,
        localDateTime: row.localDateTime,
      });
      if (
        !newLocalDateTime ||
        (newDate.getTime() === row.takenAt.getTime() &&
          newLocalDateTime.getTime() === row.localDateTime.getTime() &&
          newZone === row.timeZone)
      ) {
        continue;
      }
      items.push({
        assetId: row.assetId,
        currentTakenAt: row.takenAt,
        currentLocalDateTime: row.localDateTime,
        currentZone: row.timeZone,
        ...(row.earlier ?? {
          previousDate: row.dateTimeOriginal,
          previousZone: row.timeZone,
          previousTakenAt: row.takenAt,
          previousLocalDateTime: row.localDateTime,
          previousLocked: row.locked,
        }),
        newDate,
        newZone,
        newLocalDateTime,
      });
    }
    return items;
  }

  /**
   * What a date edit sets off, as `AssetService.updateAll` does it: the date is the owner's on partner copies and
   * copies following these photos receive it, the sidecars are rewritten, and timelines and memories hear of it.
   * `release`: photos whose date lock goes once their sidecar holds the restored date (undo).
   */
  private async afterDateChange(ownerId: string, assetIds: string[], release: Set<string> | false) {
    if (assetIds.length === 0) {
      return;
    }
    await recordAssetEdit({ partnerOrigin: this.partnerOriginRepository, job: this.jobRepository }, ownerId, assetIds, [
      AssetOriginField.DateTimeOriginal,
    ]);
    await this.jobRepository.queueAll(
      assetIds.map((id) => ({
        name: JobName.SidecarWrite as const,
        data: release && release.has(id) ? { id, releaseDateLock: true } : { id },
      })),
    );
    await this.eventRepository.emit('AssetsChanged', { assetIds });
  }
}

const toBatchResponse = (batch: Selectable<DateFixBatchTable>): DateFixBatchResponseDto => ({
  id: batch.id,
  count: batch.count,
  createdAt: iso(batch.createdAt),
  undoneAt: batch.undoneAt ? iso(batch.undoneAt) : null,
  undoUntil: DateTime.fromJSDate(new Date(batch.createdAt)).plus({ days: DATE_FIX_UNDO_DAYS }).toUTC().toISO()!,
});
