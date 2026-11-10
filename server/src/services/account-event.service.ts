import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import {
  AccountActivityAdminSearchDto,
  AccountActivityResponseDto,
  AccountActivitySearchDto,
} from 'src/dtos/account-event.dto.js';
import { BaseService } from 'src/services/base.service.js';
import { asDateTimeString } from 'src/utils/date.js';

/** FL-808: the default page size of the activity log. */
const PAGE_SIZE = 50;
/** FL-808: how long the activity log is kept. */
export const ACCOUNT_EVENT_RETENTION_DAYS = 400;

type EventRow = {
  id: string;
  userId: string;
  action: string;
  subject: string;
  detail: string | null;
  ipPrefix: string | null;
  deviceType: string | null;
  deviceOS: string | null;
  via: string | null;
  createdAt: Date | string;
  source?: string;
  actorId?: string | null;
  actorName?: string | null;
};

const toResponse = (rows: EventRow[], take: number): AccountActivityResponseDto => ({
  events: rows.slice(0, take).map((row) => ({
    id: row.id,
    source: row.source ?? 'account',
    userId: row.userId,
    action: row.action,
    subject: row.subject,
    detail: row.detail,
    ipPrefix: row.ipPrefix,
    deviceType: row.deviceType,
    deviceOS: row.deviceOS,
    via: row.via,
    actorId: row.actorId ?? null,
    actorName: row.actorName ?? null,
    createdAt: asDateTimeString(row.createdAt),
  })),
  hasMore: rows.length > take,
});

@Injectable()
export class AccountEventService extends BaseService {
  /** The caller's own log, newest first. */
  async getMine(auth: AuthDto, dto: AccountActivitySearchDto): Promise<AccountActivityResponseDto> {
    const take = dto.take ?? PAGE_SIZE;
    // one extra row says whether an older page exists
    const rows = await this.accountEventRepository.getByUserId(auth.user.id, { before: dto.before, take: take + 1 });
    return toResponse(rows, take);
  }

  /** Every account's log merged with the administrator history (FL-76), for administrators. */
  async getAll(auth: AuthDto, { take: pageSize, ...dto }: AccountActivityAdminSearchDto) {
    const take = pageSize ?? PAGE_SIZE;
    const rows = await this.accountEventRepository.getAll({ ...dto, take: take + 1 });
    return toResponse(rows, take);
  }

  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async onNightlyDatabaseCleanup(): Promise<void> {
    const cutoff = DateTime.now().minus({ days: ACCOUNT_EVENT_RETENTION_DAYS }).toJSDate();
    const removed = await this.accountEventRepository.deleteOlderThan(cutoff);
    if (removed > 0) {
      this.logger.log(`Removed ${removed} account activity events older than ${ACCOUNT_EVENT_RETENTION_DAYS} days`);
    }
  }
}
