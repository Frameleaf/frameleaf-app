import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable, Kysely, Updateable } from 'kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { SessionTable } from 'src/schema/tables/session.table.js';
import { asUuid } from 'src/utils/database.js';

@Injectable()
export class SessionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  cleanup() {
    return this.db
      .deleteFrom('session')
      .where((eb) =>
        eb.or([
          eb('updatedAt', '<=', DateTime.now().minus({ days: 90 }).toJSDate()),
          eb.and([eb('expiresAt', 'is not', null), eb('expiresAt', '<=', DateTime.now().toJSDate())]),
        ]),
      )
      .returning(['id', 'deviceOS', 'deviceType'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db
      .selectFrom('session')
      .select(['id', 'expiresAt', 'pinExpiresAt', 'oauthBearerToken'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async isPendingSyncReset(id: string) {
    const result = await this.db
      .selectFrom('session')
      .select(['isPendingSyncReset'])
      .where('id', '=', id)
      .executeTakeFirst();
    return result?.isPendingSyncReset ?? false;
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  getByToken(token: Buffer) {
    return this.db
      .selectFrom('session')
      .select((eb) => [
        ...columns.authSession,
        jsonObjectFrom(
          eb
            .selectFrom('user')
            .select(columns.authUser)
            .whereRef('user.id', '=', 'session.userId')
            .where('user.deletedAt', 'is', null),
        ).as('user'),
      ])
      .where('session.token', '=', token)
      .where((eb) =>
        eb.or([eb('session.expiresAt', 'is', null), eb('session.expiresAt', '>', DateTime.now().toJSDate())]),
      )
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getByUserId(userId: string) {
    return this.db
      .selectFrom('session')
      .innerJoin('user', (join) => join.onRef('user.id', '=', 'session.userId').on('user.deletedAt', 'is', null))
      .selectAll('session')
      .where('session.userId', '=', userId)
      .where((eb) =>
        eb.or([eb('session.expiresAt', 'is', null), eb('session.expiresAt', '>', DateTime.now().toJSDate())]),
      )
      .orderBy('session.updatedAt', 'desc')
      .orderBy('session.createdAt', 'desc')
      .execute();
  }

  create(dto: Insertable<SessionTable>) {
    return this.db.insertInto('session').values(dto).returningAll().executeTakeFirstOrThrow();
  }

  update(id: string, dto: Updateable<SessionTable>) {
    return this.db
      .updateTable('session')
      .set(dto)
      .where('session.id', '=', asUuid(id))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Extends a still-elevated session's PIN expiry (FL-34). The update only applies while the session
   * is elevated and unexpired at write time: PostgreSQL rechecks this predicate after a concurrent
   * row update, so a lock (or `lockAll`) that cleared the expiry after the caller read the session
   * wins over the caller's stale snapshot. Returns whether the session is still elevated.
   */
  async refreshPinExpiry(id: string, pinExpiresAt: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('session')
      .set({ pinExpiresAt })
      .where('id', '=', asUuid(id))
      .where('pinExpiresAt', '>', sql<Date>`clock_timestamp()`)
      .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`clock_timestamp()`)]))
      .returning('id')
      .executeTakeFirst();
    return !!result;
  }

  /**
   * Elevates a session after its PIN was checked (FL-34), only while the account's PIN and password
   * are still the ones that check read. A PIN change or reset, or a password change, that commits
   * (with its `lockAll`) between the check and this write is never undone by it: PostgreSQL
   * re-evaluates the predicate against the committed user row. Returns whether it applied.
   */
  async elevate(
    id: string,
    userId: string,
    verified: { pinCode: string | null; password: string | null },
    pinExpiresAt: Date,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('session')
      .set({ pinExpiresAt })
      .where('session.id', '=', asUuid(id))
      .where('session.userId', '=', asUuid(userId))
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('user')
            .select('user.id')
            .whereRef('user.id', '=', 'session.userId')
            .where('user.deletedAt', 'is', null)
            .where(sql<boolean>`"user"."pinCode" is not distinct from ${verified.pinCode}`)
            .where(sql<boolean>`"user"."password" is not distinct from ${verified.password}`)
            .forShare(),
        ),
      )
      .returning('session.id')
      .executeTakeFirst();
    return !!result;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('session').where('id', '=', asUuid(id)).execute();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, excludeId: DummyValue.UUID }] })
  async invalidateAll({ userId, excludeId }: { userId: string; excludeId?: string }): Promise<string[]> {
    // the deleted ids, so each revoked session's open tabs can be told (FL-34)
    const deleted = await this.db
      .deleteFrom('session')
      .where('userId', '=', userId)
      .$if(!!excludeId, (qb) => qb.where('id', '!=', excludeId!))
      .returning('id')
      .execute();
    return deleted.map(({ id }) => id);
  }

  @GenerateSql({ params: [DummyValue.STRING, DummyValue.STRING] })
  async invalidateOAuth({ oauthSid, oauthId }: { oauthSid?: string; oauthId?: string }): Promise<string[]> {
    let query = this.db.deleteFrom('session').returning('session.id');

    if (oauthSid && oauthId) {
      query = query
        .using('user')
        .whereRef('user.id', '=', 'session.userId')
        .where('session.oauthSid', '=', oauthSid)
        .where('user.oauthId', '=', oauthId);
    } else if (!oauthSid && oauthId) {
      query = query.using('user').whereRef('user.id', '=', 'session.userId').where('user.oauthId', '=', oauthId);
    } else if (oauthSid && !oauthId) {
      query = query.where('session.oauthSid', '=', oauthSid);
    } else {
      throw new Error('Invalid arguments: at least one of oauthSid or oauthId must be present');
    }

    const deletedRows = await query.execute();
    return deletedRows.map((row) => row.id);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async lockAll(userId: string) {
    await this.db.updateTable('session').set({ pinExpiresAt: null }).where('userId', '=', userId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async requestSyncResetForUser(userId: string) {
    await this.db.updateTable('session').set({ isPendingSyncReset: true }).where('userId', '=', userId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async resetSyncProgress(sessionId: string) {
    await this.db.transaction().execute((tx) => {
      return Promise.all([
        tx.updateTable('session').set({ isPendingSyncReset: false }).where('id', '=', sessionId).execute(),
        tx.deleteFrom('session_sync_checkpoint').where('sessionId', '=', sessionId).execute(),
      ]);
    });
  }
}
