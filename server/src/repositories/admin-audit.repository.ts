import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema/index.js';
import { AdminAuditEventTable } from 'src/schema/tables/admin-audit-event.table.js';

/**
 * The administrator audit trail (FL-76): what administrators did to each account and its libraries.
 * Written by the services that make those changes, read only through the admin account history
 * endpoint.
 */
@Injectable()
export class AdminAuditRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async create(events: Insertable<AdminAuditEventTable>[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await this.db.insertInto('admin_audit_event').values(events).execute();
  }

  /**
   * One account's history, newest first. `before` is the id of the last event of the previous page;
   * paging on (createdAt, id) keeps events recorded in the same instant in a stable order. A cursor
   * that names no event of this account yields an empty page.
   */
  getByUserId(userId: string, { before, take }: { before?: string; take: number }) {
    return this.db
      .selectFrom('admin_audit_event')
      .leftJoin('user as actor', 'actor.id', 'admin_audit_event.actorId')
      .select([
        'admin_audit_event.id',
        'admin_audit_event.userId',
        'admin_audit_event.actorId',
        'actor.name as actorName',
        'admin_audit_event.libraryId',
        'admin_audit_event.action',
        'admin_audit_event.subject',
        'admin_audit_event.detail',
        'admin_audit_event.createdAt',
      ])
      .where('admin_audit_event.userId', '=', userId)
      .$if(before !== undefined, (qb) =>
        qb.where(
          sql<boolean>`("admin_audit_event"."createdAt", "admin_audit_event"."id") < (
            SELECT "cursor"."createdAt", "cursor"."id"
            FROM "admin_audit_event" AS "cursor"
            WHERE "cursor"."id" = ${before}::uuid AND "cursor"."userId" = ${userId}::uuid
          )`,
        ),
      )
      .orderBy('admin_audit_event.createdAt', 'desc')
      .orderBy('admin_audit_event.id', 'desc')
      .limit(take)
      .execute();
  }
}
