import { Injectable } from '@nestjs/common';
import { type Kysely, type QueryExecutorProvider, type Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import z from 'zod';
import { DB } from 'src/schema/index.js';
import { DesktopWorkerSessionTable } from 'src/schema/tables/desktop-worker-session.table.js';

export type DesktopWorkerTables = { desktop_worker_session: DesktopWorkerSessionTable };
export type DesktopWorkerGrant = { deviceId: string; authorizationEpoch: number; sessionId: string };
type WorkerDatabase = DB & DesktopWorkerTables;
export type DesktopWorkerSession = Selectable<DesktopWorkerSessionTable>;
const expires = sql<Date>`clock_timestamp() + interval '1 hour'`;
const models = z.array(z.string().min(1).max(256)).max(64);

/** Lock in owner/device/session order; a photo-session cascade waits for the worker row. */
export async function lockDesktopWorker(
  db: QueryExecutorProvider,
  grant: DesktopWorkerGrant,
): Promise<{ modelKeys: string[]; expiresAt: Date } | undefined> {
  const { rows: owners } = await sql<{ id: string }>`SELECT u.id FROM "user" u JOIN desktop_device d ON d."userId"=u.id
    WHERE d.id=${grant.deviceId} AND u."isAdmin" AND u."deletedAt" IS NULL FOR SHARE OF u`.execute(db);
  if (owners.length !== 1) return;
  const { rows: devices } = await sql`SELECT id FROM desktop_device WHERE id=${grant.deviceId}
    AND "authorizationEpoch"=${grant.authorizationEpoch} AND state='preparing' AND mode='client-worker' AND "revokedAt" IS NULL FOR UPDATE`.execute(
    db,
  );
  if (devices.length !== 1) return;
  const { rows } = await sql<{
    modelKeys: string[];
    expiresAt: Date;
  }>`SELECT w."modelKeys", w."expiresAt" FROM desktop_worker_session w
    JOIN session p ON p.id=w."photoSessionId" WHERE w.id=${grant.sessionId} AND w."deviceId"=${grant.deviceId}
    AND w."authorizationEpoch"=${grant.authorizationEpoch} AND w."revokedAt" IS NULL AND w."expiresAt">clock_timestamp()
    AND p."userId"=${owners[0].id} AND (p."expiresAt" IS NULL OR p."expiresAt">clock_timestamp()) FOR SHARE OF w`.execute(
    db,
  );
  return rows[0];
}

@Injectable()
export class DesktopWorkerRepository {
  private db: Kysely<WorkerDatabase>;
  constructor(@InjectKysely() db: Kysely<DB>) {
    this.db = db.withTables<DesktopWorkerTables>();
  }

  device(userId: string, id: string) {
    return this.db
      .selectFrom('desktop_device as device')
      .innerJoin('user as owner', 'owner.id', 'device.userId')
      .selectAll('device')
      .where('device.id', '=', id)
      .where('device.userId', '=', userId)
      .where('device.state', '=', 'preparing')
      .where('device.mode', '=', 'client-worker')
      .where('device.revokedAt', 'is', null)
      .where('owner.isAdmin', '=', true)
      .where('owner.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  issue(input: {
    deviceId: string;
    authorizationEpoch: number;
    photoSessionId: string;
    tokenHash: Buffer;
    modelKeys: string[];
  }): Promise<DesktopWorkerSession | undefined> {
    if (input.tokenHash.length !== 32) throw new Error('desktop_worker_hash_invalid');
    const modelKeys = models.parse(input.modelKeys);
    return this.db.transaction().execute(async (db) => {
      const { rows: owners } = await sql<{
        id: string;
      }>`SELECT u.id FROM "user" u JOIN desktop_device d ON d."userId"=u.id
        WHERE d.id=${input.deviceId} AND u."isAdmin" AND u."deletedAt" IS NULL FOR SHARE OF u`.execute(db);
      if (owners.length !== 1) return;
      const photo = await db
        .selectFrom('session')
        .select('id')
        .where('id', '=', input.photoSessionId)
        .where('userId', '=', owners[0].id)
        .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`clock_timestamp()`)]))
        .forShare()
        .executeTakeFirst();
      if (!photo) return;
      const device = await db
        .selectFrom('desktop_device')
        .select('id')
        .where('id', '=', input.deviceId)
        .where('authorizationEpoch', '=', input.authorizationEpoch)
        .where('state', '=', 'preparing')
        .where('mode', '=', 'client-worker')
        .where('revokedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!device) return;
      const values = {
        ...input,
        modelKeys: sql<string[]>`${modelKeys}::jsonb`,
        lastSequence: 0,
        expiresAt: expires,
        revokedAt: null,
      };
      return db
        .insertInto('desktop_worker_session')
        .values(values)
        .onConflict((oc) => oc.column('deviceId').doUpdateSet(values))
        .returningAll()
        .executeTakeFirst();
    });
  }

  session(id: string, tokenHash: Buffer) {
    return this.db
      .selectFrom('desktop_worker_session as worker')
      .innerJoin('desktop_device as device', 'device.id', 'worker.deviceId')
      .innerJoin('user as owner', 'owner.id', 'device.userId')
      .innerJoin('session as photo', 'photo.id', 'worker.photoSessionId')
      .selectAll('worker')
      .select('device.publicKey')
      .where('worker.id', '=', id)
      .where('worker.tokenHash', '=', tokenHash)
      .where('worker.revokedAt', 'is', null)
      .where('worker.expiresAt', '>', sql<Date>`clock_timestamp()`)
      .whereRef('worker.authorizationEpoch', '=', 'device.authorizationEpoch')
      .whereRef('photo.userId', '=', 'owner.id')
      .where('device.state', '=', 'preparing')
      .where('device.mode', '=', 'client-worker')
      .where('device.revokedAt', 'is', null)
      .where('owner.isAdmin', '=', true)
      .where('owner.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([eb('photo.expiresAt', 'is', null), eb('photo.expiresAt', '>', sql<Date>`clock_timestamp()`)]),
      )
      .executeTakeFirst();
  }

  async consume(id: string, tokenHash: Buffer, sequence: number): Promise<DesktopWorkerGrant | undefined> {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2_147_483_647) return;
    const session = await this.session(id, tokenHash);
    if (!session) return;
    const grant = { sessionId: session.id, deviceId: session.deviceId, authorizationEpoch: session.authorizationEpoch };
    return this.db.transaction().execute(async (db) => {
      if (!(await lockDesktopWorker(db, grant))) return;
      const updated = await db
        .updateTable('desktop_worker_session')
        .set({ lastSequence: sequence })
        .where('id', '=', id)
        .where('tokenHash', '=', tokenHash)
        .where('lastSequence', '<', sequence)
        .returning('id')
        .executeTakeFirst();
      return updated ? grant : undefined;
    });
  }

  rotate(grant: DesktopWorkerGrant, previousHash: Buffer, nextHash: Buffer): Promise<DesktopWorkerSession | undefined> {
    return this.db.transaction().execute(async (db) => {
      if (!(await lockDesktopWorker(db, grant))) return;
      return db
        .updateTable('desktop_worker_session')
        .set({ tokenHash: nextHash, lastSequence: 0, expiresAt: expires })
        .where('id', '=', grant.sessionId)
        .where('tokenHash', '=', previousHash)
        .returningAll()
        .executeTakeFirst();
    });
  }

  revoke(grant: DesktopWorkerGrant): Promise<boolean> {
    return this.db.transaction().execute(async (db) => {
      if (!(await lockDesktopWorker(db, grant))) return false;
      await db
        .updateTable('desktop_worker_session')
        .set({ revokedAt: sql<Date>`clock_timestamp()`, modelKeys: sql<string[]>`'[]'::jsonb` })
        .where('id', '=', grant.sessionId)
        .execute();
      return true;
    });
  }
}
