import { Inject, Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { InjectKysely } from 'nestjs-kysely';
import { isIPv4, isIPv6 } from 'node:net';
import type { Request } from 'express';
import type { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
import { requestVia } from 'src/middleware/frameleaf-via.middleware.js';
import { DB } from 'src/schema/index.js';
import { AccountEventTable } from 'src/schema/tables/account-event.table.js';
import { getUserAgentDetails } from 'src/utils/request.js';

/** What a service passes; the request's device, via and address are filled in when left out. */
export type AccountEventInsert = Pick<Insertable<AccountEventTable>, 'userId' | 'action' | 'subject'> &
  Partial<Pick<Insertable<AccountEventTable>, 'sessionId' | 'detail' | 'ipPrefix' | 'deviceType' | 'deviceOS' | 'via'>>;

export type AccountEventFilter = { userId?: string; action?: string; from?: Date; to?: Date };

/** FL-808: how a request arrived, in the log's words (the edge worker's `lan` is home). */
export const toAccountEventVia = (via: FrameleafVia | null | undefined): string | null => {
  switch (via) {
    case 'lan': {
      return 'home';
    }
    case 'wan': {
      return 'direct';
    }
    case 'relay': {
      return 'relay';
    }
    default: {
      return null;
    }
  }
};

/** FL-808: a client address cut to its /24 (IPv4) or /48 (IPv6); never the full address. */
export const toIpPrefix = (ip: string | null | undefined): string | null => {
  if (!ip) {
    return null;
  }
  const v4 = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIPv4(v4)) {
    const [a, b, c] = v4.split('.', 3);
    return `${a}.${b}.${c}.0/24`;
  }
  const address = ip.split('%', 1)[0];
  if (!isIPv6(address)) {
    return null;
  }
  const [head, tail] = address.split('::', 2);
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // an embedded IPv4 tail fills two groups
  const rightGroups = right.length + (right.at(-1)?.includes('.') ? 1 : 0);
  const groups = [...left, ...Array.from({ length: 8 - left.length - rightGroups }, () => '0'), ...right];
  return `${groups
    .slice(0, 3)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':')}::/48`;
};

/**
 * The account activity log (FL-808, E16-02): what each account did. Written by the services that
 * make the change, read by the owner and by administrators (merged with FL-76's `admin_audit_event`).
 */
@Injectable()
export class AccountEventRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    @Inject(ClsService) private cls?: ClsService,
  ) {}

  /** The current request's device, via and address prefix; empty outside a request. */
  private requestDetails() {
    const request = this.cls?.isActive() ? this.cls.get<Request | undefined>(CLS_REQ) : undefined;
    if (!request?.headers) {
      return {};
    }
    const { deviceType, deviceOS } = getUserAgentDetails(request.headers);
    return {
      deviceType: deviceType || null,
      deviceOS: deviceOS || null,
      via: toAccountEventVia(requestVia(request)),
      ipPrefix: toIpPrefix(request.ip),
    };
  }

  async create(event: AccountEventInsert): Promise<void> {
    await this.db
      .insertInto('account_event')
      .values({ ...this.requestDetails(), ...event })
      .execute();
  }

  /**
   * One account's log, newest first. `before` is the id of the last event of the previous page; a
   * cursor that names no event of this account yields an empty page.
   */
  getByUserId(userId: string, { before, take }: { before?: string; take: number }) {
    return this.db
      .selectFrom('account_event')
      .selectAll()
      .where('userId', '=', userId)
      .$if(before !== undefined, (qb) =>
        qb.where(
          sql<boolean>`("account_event"."createdAt", "account_event"."id") < (
            SELECT "cursor"."createdAt", "cursor"."id"
            FROM "account_event" AS "cursor"
            WHERE "cursor"."id" = ${before}::uuid AND "cursor"."userId" = ${userId}::uuid
          )`,
        ),
      )
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(take)
      .execute();
  }

  /**
   * Every account's log merged with what administrators did (`admin_audit_event`, `source: admin`),
   * newest first, for administrators only. `before` is the id of the last event of the previous page,
   * from either table.
   */
  getAll({ before, take, ...filter }: AccountEventFilter & { before?: string; take: number }) {
    const own = this.db
      .selectFrom('account_event')
      .select([
        'account_event.id',
        sql<'account' | 'admin'>`'account'`.as('source'),
        'account_event.userId',
        'account_event.action',
        'account_event.subject',
        'account_event.detail',
        'account_event.ipPrefix',
        'account_event.deviceType',
        'account_event.deviceOS',
        'account_event.via',
        sql<string | null>`null::uuid`.as('actorId'),
        sql<string | null>`null::varchar`.as('actorName'),
        'account_event.createdAt',
      ]);
    const admin = this.db
      .selectFrom('admin_audit_event')
      .leftJoin('user as actor', 'actor.id', 'admin_audit_event.actorId')
      .select([
        'admin_audit_event.id',
        sql<'account' | 'admin'>`'admin'`.as('source'),
        'admin_audit_event.userId',
        'admin_audit_event.action',
        'admin_audit_event.subject',
        'admin_audit_event.detail',
        sql<string | null>`null`.as('ipPrefix'),
        sql<string | null>`null`.as('deviceType'),
        sql<string | null>`null`.as('deviceOS'),
        sql<string | null>`null`.as('via'),
        'admin_audit_event.actorId',
        'actor.name as actorName',
        'admin_audit_event.createdAt',
      ]);

    return this.db
      .selectFrom(own.unionAll(admin).as('event'))
      .selectAll()
      .$if(filter.userId !== undefined, (qb) => qb.where('event.userId', '=', filter.userId!))
      .$if(filter.action !== undefined, (qb) => qb.where('event.action', '=', filter.action!))
      .$if(filter.from !== undefined, (qb) => qb.where('event.createdAt', '>=', filter.from!))
      .$if(filter.to !== undefined, (qb) => qb.where('event.createdAt', '<', filter.to!))
      .$if(before !== undefined, (qb) =>
        qb.where(
          sql<boolean>`("event"."createdAt", "event"."id") < (
            SELECT "cursor"."createdAt", "cursor"."id" FROM (
              SELECT "createdAt", "id" FROM "account_event" WHERE "id" = ${before}::uuid
              UNION ALL
              SELECT "createdAt", "id" FROM "admin_audit_event" WHERE "id" = ${before}::uuid
            ) AS "cursor" LIMIT 1
          )`,
        ),
      )
      .orderBy('event.createdAt', 'desc')
      .orderBy('event.id', 'desc')
      .limit(take)
      .execute();
  }

  /** Removes events older than `date`; returns how many. */
  async deleteOlderThan(date: Date): Promise<number> {
    const result = await this.db.deleteFrom('account_event').where('createdAt', '<', date).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
