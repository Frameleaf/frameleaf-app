import { BadRequestException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { Selectable, Transaction } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  DateDoctorApplyResponseDto,
  DateDoctorBatchDto,
  DateDoctorFindingsResponseDto,
  DateDoctorFixDto,
  DateDoctorGroup,
  DateDoctorPreviewResponseDto,
} from 'src/dtos/date-doctor.dto.js';
import type { DB } from 'src/schema/index.js';
import type { DateFixBatchTable, DateLock } from 'src/schema/tables/date-fix.table.js';
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
import { requireAccess } from 'src/utils/access.js';
import { type DateFindingCause, detectDateFindings, wallToInstant } from 'src/utils/date-doctor.js';
import { getAssetDateTimeUpdates } from 'src/utils/date.js';

/** FL-930: how long an Apply can be undone; older batches are removed nightly. */
export const DATE_FIX_UNDO_DAYS = 30;

const iso = (date: Date | string) => new Date(date).toISOString();

const DATE_LOCKS: DateLock[] = ['dateTimeOriginal', 'timeZone'];

/**
 * FL-912: the Date & Time Doctor finds photos whose date or time zone is probably wrong and proposes a fix with a
 * reason (`src/utils/date-doctor.ts`). The scan changes nothing. FL-930 gives chosen photos their proposals, or a
 * zone and shift, the way a bulk date edit does (locked, sidecars rewritten, partner copies following), and
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
    const { items } = await this.plan(auth, dto);
    return {
      items: items.map((item) => ({
        assetId: item.assetId,
        before: toTime(item.currentTakenAt, item.currentZone, item.currentLocalDateTime),
        after: toTime(item.newDate, item.newZone, item.newLocalDateTime),
      })),
    };
  }

  async apply(auth: AuthDto, dto: DateDoctorFixDto): Promise<DateDoctorApplyResponseDto> {
    const { items, cause } = await this.plan(auth, dto);
    const asked = { cause, shiftMinutes: dto.shiftMinutes ?? null, timeZone: dto.timeZone ?? null };
    // the sidecars and partner copies commit with the dates: a failure leaves nothing changed, so a retry is safe
    const result =
      items.length > 0
        ? await this.dateDoctorRepository.applyFixes(auth.user.id, items, asked, (tx, assetIds) =>
            this.queueDateEffects(tx, auth.user.id, assetIds, () => ({})),
          )
        : undefined;
    if (!result) {
      throw new BadRequestException('Nothing to fix');
    }
    const { batch, assetIds } = result;
    await this.afterCommit(auth.user.id, assetIds, AccountEventAction.DatesFixed, batch.count, auth.user.name);
    const written = new Set(assetIds);
    return { batch: toBatchResponse(batch), skipped: dto.assetIds.filter((id) => !written.has(id)) };
  }

  async getBatches(auth: AuthDto): Promise<DateDoctorBatchDto[]> {
    const rows = await this.dateDoctorRepository.getBatches(auth.user.id, undoSince());
    return rows.map((batch) => toBatchResponse(batch));
  }

  async undo(auth: AuthDto, id: string): Promise<DateDoctorBatchDto> {
    // the same check as a fix: a photo Locked since then needs an elevated session to change
    const ids = await this.dateDoctorRepository.getBatchAssetIds(auth.user.id, id);
    if (ids.length > 0) {
      await requireAccess(this.accessRepository, { auth, permission: Permission.AssetUpdate, ids });
    }
    const result = await this.dateDoctorRepository.undoBatch(auth.user.id, id, undoSince(), (tx, restored) => {
      // a date or zone that was not set by hand before goes back to being read from the file, once the sidecar
      // holds the restored value
      const release = new Map(
        restored.map(({ assetId, previousLocks }) => [
          assetId,
          DATE_LOCKS.filter((property) => !previousLocks.includes(property)),
        ]),
      );
      return this.queueDateEffects(
        tx,
        auth.user.id,
        restored.map(({ assetId }) => assetId),
        (assetId) => {
          const released = release.get(assetId) ?? [];
          return released.length === 0 ? {} : { releaseDateLock: released.length === 2 ? true : released };
        },
      );
    });
    if (!result) {
      throw new BadRequestException('Batch not found');
    }
    if (result.alreadyUndone) {
      throw new BadRequestException('Already undone');
    }
    const { batch, restored } = result;
    await this.afterCommit(
      auth.user.id,
      restored.map(({ assetId }) => assetId),
    );
    return { ...toBatchResponse(batch), restored: restored.length };
  }

  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async onNightlyDatabaseCleanup(): Promise<void> {
    const removed = await this.dateDoctorRepository.pruneBatches(undoSince());
    if (removed > 0) {
      this.logger.log(`Removed ${removed} Date & Time Doctor batches older than ${DATE_FIX_UNDO_DAYS} days`);
    }
  }

  /**
   * What each photo would get, read from the database: the Doctor's proposal, or the zone (keeping the moment, or with
   * `keepWallTime` the clock time shown) and the shift. Only the caller's own photos: a partner's copy, or the
   * original of one, is refused. `cause` is the proposals' cause when they all share one.
   */
  private async plan(auth: AuthDto, dto: DateDoctorFixDto) {
    const ids = dto.assetIds;
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetUpdate, ids });
    const proposals = dto.useProposal
      ? new Map((await this.dateDoctorRepository.getProposals(auth.user.id, ids)).map((row) => [row.assetId, row]))
      : undefined;
    const ordered = new Map(ids.map((id, index) => [id, index]));
    const rows = await this.dateDoctorRepository.getCurrent(auth.user.id, proposals ? proposals.keys().toArray() : ids);
    const shift = (dto.shiftMinutes ?? 0) * 60_000;
    const items: DateFixPlan[] = [];
    for (const row of rows.toSorted((a, b) => ordered.get(a.assetId)! - ordered.get(b.assetId)!)) {
      const proposal = proposals?.get(row.assetId);
      // a proposal made for a date the photo no longer has (edited since the scan) is not applied over the edit
      if (
        proposal &&
        (new Date(proposal.currentDate).getTime() !== row.takenAt.getTime() || proposal.currentZone !== row.timeZone)
      ) {
        continue;
      }
      const newZone = proposal ? (proposal.proposedZone ?? row.timeZone) : (dto.timeZone ?? row.timeZone);
      const newDate = proposal
        ? new Date(proposal.proposedDate)
        : dto.timeZone && dto.keepWallTime
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
        cause: proposal?.cause ?? null,
        currentTakenAt: row.takenAt,
        currentLocalDateTime: row.localDateTime,
        currentZone: row.timeZone,
        ...(row.earlier ?? {
          previousDate: row.dateTimeOriginal,
          previousZone: row.timeZone,
          previousTakenAt: row.takenAt,
          previousLocalDateTime: row.localDateTime,
          previousLocks: row.locks,
        }),
        newDate,
        newZone,
        newLocalDateTime,
      });
    }
    const causes = new Set(items.map(({ cause }) => cause));
    return { items, cause: causes.size === 1 ? causes.values().next().value! : null };
  }

  /**
   * What a date edit sets off, as `AssetService.updateAll` does it, in the transaction that changed the dates: the
   * date is the owner's on their partner copies, copies following these photos receive it, and the sidecars are
   * rewritten (`sidecar`: what each photo's job does with the lock).
   */
  private async queueDateEffects(
    tx: Transaction<DB>,
    ownerId: string,
    assetIds: string[],
    sidecar: (assetId: string) => Omit<JobOf<JobName.SidecarWrite>, 'id'>,
  ) {
    if (assetIds.length === 0) {
      return;
    }
    const fields = [AssetOriginField.DateTimeOriginal];
    await this.partnerOriginRepository.markOverridden('asset', assetIds, fields, ownerId, tx);
    const sources = await this.partnerOriginRepository.getIdsWithFollowers('asset', assetIds);
    await this.jobRepository.queueAllInTransaction(tx, [
      ...sources.map((sourceId) => ({
        name: JobName.PartnerPropagate as const,
        data: { kind: 'asset' as const, sourceId, fields },
      })),
      ...assetIds.map((id) => ({ name: JobName.SidecarWrite as const, data: { id, ...sidecar(id) } })),
    ]);
  }

  /** After the dates commit: timelines and memories hear of it, and an Apply goes in the activity log. */
  private async afterCommit(
    ownerId: string,
    assetIds: string[],
    action?: AccountEventAction,
    count?: number,
    subject?: string,
  ) {
    // the change is in; a failure here must not make the client think it is not, and try again
    try {
      if (assetIds.length > 0) {
        await this.eventRepository.emit('AssetsChanged', { assetIds });
      }
      if (action) {
        await this.accountEventRepository.create({ userId: ownerId, action, subject: subject!, detail: String(count) });
      }
    } catch (error) {
      this.logger.error(`Date & Time Doctor: unable to announce changed dates of ${ownerId}: ${error}`);
    }
  }
}

type DateFixPlan = DateFixWrite & { cause: DateFindingCause | null; currentZone: string | null };

const undoSince = () => DateTime.now().minus({ days: DATE_FIX_UNDO_DAYS }).toJSDate();

/** A moment as the Doctor shows it; `local` is the clock time, which the asset row keeps in UTC fields. */
const toTime = (date: Date, zone: string | null, local: Date) => ({
  date: iso(date),
  zone,
  local: iso(local).slice(0, 19),
});

const toBatchResponse = (batch: Selectable<DateFixBatchTable>): DateDoctorBatchDto => ({
  id: batch.id,
  createdAt: iso(batch.createdAt),
  expiresAt: DateTime.fromJSDate(new Date(batch.createdAt)).plus({ days: DATE_FIX_UNDO_DAYS }).toUTC().toISO()!,
  count: batch.count,
  cause: batch.cause,
  shiftMinutes: batch.shiftMinutes,
  timeZone: batch.timeZone,
  undoneAt: batch.undoneAt ? iso(batch.undoneAt) : null,
});
