import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { DB } from 'src/schema/index.js';
import type { DesktopDeviceTable } from 'src/schema/tables/desktop-device.table.js';

export type DesktopDeviceRow = Selectable<DesktopDeviceTable>;
export type DesktopDeviceCreate = Omit<
  Insertable<DesktopDeviceTable>,
  'id' | 'createdAt' | 'revokedAt' | 'authorizationEpoch'
>;

@Injectable()
export class DesktopDeviceRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Unique account/installation identity survives retries; neither key replacement nor revival is an upsert. */
  enroll(row: DesktopDeviceCreate): Promise<DesktopDeviceRow | undefined> {
    return this.db
      .insertInto('desktop_device')
      .values(row)
      .onConflict((oc) =>
        oc
          .columns(['userId', 'installationId'])
          .doUpdateSet({ name: row.name, mode: row.mode, state: row.state })
          .where('desktop_device.publicKey', '=', row.publicKey)
          .where('desktop_device.platform', '=', row.platform)
          .where('desktop_device.architecture', '=', row.architecture)
          .where('desktop_device.revokedAt', 'is', null),
      )
      .returningAll()
      .executeTakeFirst();
  }

  list(userId: string): Promise<DesktopDeviceRow[]> {
    return this.db
      .selectFrom('desktop_device')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  async endSession(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('desktop_device')
      .set({ state: 'paused', authorizationEpoch: sql`"authorizationEpoch" + 1` })
      .where('id', '=', id)
      .where('userId', '=', userId)
      .where('revokedAt', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async revoke(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('desktop_device')
      .set({
        state: 'revoked',
        revokedAt: sql`coalesce("revokedAt", now())`,
        authorizationEpoch: sql`"authorizationEpoch" + 1`,
      })
      .where('id', '=', id)
      .where('userId', '=', userId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }
}
