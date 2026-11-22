import { Injectable } from '@nestjs/common';
import { type Insertable, Kysely, type Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema/index.js';
import { HouseholdLinkTable } from 'src/schema/tables/household-link.table.js';

/** FL-952: this server's links with other households, and the request proofs admitted from them. */
@Injectable()
export class HouseholdLinkRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  getAll() {
    return this.db.selectFrom('household_link').selectAll().orderBy('createdAt', 'asc').execute();
  }

  get(id: string) {
    return this.db.selectFrom('household_link').selectAll().where('id', '=', id).executeTakeFirst();
  }

  getByCloudLinkId(cloudLinkId: string) {
    return this.db.selectFrom('household_link').selectAll().where('cloudLinkId', '=', cloudLinkId).executeTakeFirst();
  }

  /** A link Cloud already introduced keeps its row: the key stored at pairing is never replaced. */
  async create(link: Insertable<HouseholdLinkTable>) {
    await this.db
      .insertInto('household_link')
      .values({ ...link, addresses: sql`${JSON.stringify(link.addresses ?? [])}::text::jsonb` })
      .onConflict((oc) => oc.column('cloudLinkId').doNothing())
      .execute();
    return this.db
      .selectFrom('household_link')
      .selectAll()
      .where('cloudLinkId', '=', link.cloudLinkId)
      .executeTakeFirstOrThrow();
  }

  /** An ended link is final: nothing changes it again, so a check still running cannot bring it back. */
  update(id: string, { addresses, ...link }: Updateable<HouseholdLinkTable>) {
    return this.db
      .updateTable('household_link')
      .set({ ...link, ...(addresses !== undefined && { addresses: sql`${JSON.stringify(addresses)}::text::jsonb` }) })
      .where('id', '=', id)
      .where('state', '<>', 'ended')
      .returningAll()
      .executeTakeFirst();
  }

  /** The administrator's own name for the other household; allowed on an ended link too. */
  rename(id: string, householdName: string) {
    return this.db
      .updateTable('household_link')
      .set({ householdName })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Admit a request proof once. False when this `jti` was already admitted: the request is a replay.
   * Rows are only needed until their grant expires, so expired ones are removed on the way.
   */
  async admit(jti: string, linkId: string, expiresAt: Date) {
    await this.db
      .deleteFrom('household_peer_request')
      .where('expiresAt', '<=', sql<Date>`now()`)
      .execute();
    const admitted = await this.db
      .insertInto('household_peer_request')
      .values({ jti, linkId, expiresAt })
      .onConflict((oc) => oc.column('jti').doNothing())
      .returning('jti')
      .executeTakeFirst();
    return !!admitted;
  }
}
