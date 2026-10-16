import { Injectable } from '@nestjs/common';
import { type Kysely, type QueryExecutorProvider, type Selectable, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import z from 'zod';
import type {
  DesktopQualificationTables,
  DesktopWorkerQualificationTable,
} from 'src/schema/tables/desktop-worker-qualification.table.js';
import { SystemMetadataKey } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { DesktopWorkerSessionTable } from 'src/schema/tables/desktop-worker-session.table.js';
import { desktopAccountPermitted, desktopAssistancePolicySchema } from 'src/utils/desktop-assistance-policy.js';
import { EFFECTIVE_CONFIG_LOCK } from 'src/utils/effective-config-lock.js';
import { canonicalJson } from 'src/utils/object.js';

export type DesktopWorkerTables = { desktop_worker_session: DesktopWorkerSessionTable };
export type DesktopWorkerGrant = {
  deviceId: string;
  authorizationEpoch: number;
  sessionId: string;
  credentialHash: Buffer;
};
type WorkerDatabase = DB & DesktopWorkerTables;
export type DesktopWorkerSession = Selectable<DesktopWorkerSessionTable>;
const expires = sql<Date>`clock_timestamp() + interval '1 hour'`;
const models = z.array(z.string().min(1).max(256)).max(64);

export async function desktopWorkerAccountAllowed(db: QueryExecutorProvider, ownerId: string, isAdmin: boolean) {
  const { rows } = await sql<{ value: unknown }>`SELECT value FROM system_metadata
    WHERE key=${SystemMetadataKey.FrameleafDesktopAssistance}`.execute(db);
  const parsed = desktopAssistancePolicySchema.safeParse(rows[0]?.value ?? { version: 1, accounts: {} });
  return parsed.success && desktopAccountPermitted(parsed.data, ownerId, isAdmin);
}

async function lockWorkerAuthority(
  db: QueryExecutorProvider,
  grant: Omit<DesktopWorkerGrant, 'credentialHash'>,
  credentialHash: Buffer | null,
): Promise<{ ownerId: string; modelKeys: string[]; expiresAt: Date } | undefined> {
  await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${EFFECTIVE_CONFIG_LOCK},0))`.execute(db);
  const credential = credentialHash === null ? sql`true` : sql`w."tokenHash"=${credentialHash}`;
  const { rows: owners } = await sql<{
    id: string;
    isAdmin: boolean;
  }>`SELECT u.id, u."isAdmin" FROM "user" u JOIN desktop_device d ON d."userId"=u.id
    WHERE d.id=${grant.deviceId} AND u."deletedAt" IS NULL FOR SHARE OF u`.execute(db);
  if (owners.length !== 1 || !(await desktopWorkerAccountAllowed(db, owners[0].id, owners[0].isAdmin))) return;
  const { rows: devices } = await sql`SELECT id FROM desktop_device WHERE id=${grant.deviceId}
    AND "userId"=${owners[0].id} AND "authorizationEpoch"=${grant.authorizationEpoch}
    AND state='preparing' AND mode='client-worker' AND "revokedAt" IS NULL FOR UPDATE`.execute(db);
  if (devices.length !== 1) return;
  const { rows } = await sql<{
    modelKeys: string[];
    expiresAt: Date;
  }>`SELECT w."modelKeys", w."expiresAt" FROM desktop_worker_session w
    JOIN session p ON p.id=w."photoSessionId" WHERE w.id=${grant.sessionId} AND w."deviceId"=${grant.deviceId}
    AND ${credential} AND w."authorizationEpoch"=${grant.authorizationEpoch} AND w."revokedAt" IS NULL AND w."expiresAt">clock_timestamp()
    AND p."userId"=${owners[0].id} AND (p."expiresAt" IS NULL OR p."expiresAt">clock_timestamp()) FOR SHARE OF w`.execute(
    db,
  );
  return rows[0] ? { ...rows[0], ownerId: owners[0].id } : undefined;
}

/** Lock owner/device/session and require the exact credential used to authenticate this request. */
export async function lockDesktopWorker(db: QueryExecutorProvider, grant: DesktopWorkerGrant) {
  if (!Buffer.isBuffer(grant.credentialHash) || grant.credentialHash.length !== 32) return;
  return lockWorkerAuthority(db, grant, grant.credentialHash);
}

/** NAS-only publication checks current authority after a result was staged, independent of token renewal. */
export function lockDesktopWorkerForAdoption(
  db: QueryExecutorProvider,
  grant: Omit<DesktopWorkerGrant, 'credentialHash'>,
) {
  return lockWorkerAuthority(db, grant, null);
}

@Injectable()
export class DesktopWorkerRepository {
  private db: Kysely<WorkerDatabase>;
  constructor(@InjectKysely() db: Kysely<DB>) {
    this.db = db.withTables<DesktopWorkerTables>();
  }

  async owner(grant: DesktopWorkerGrant): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('desktop_device as device')
      .innerJoin('desktop_worker_session as worker', 'worker.deviceId', 'device.id')
      .select('device.userId')
      .where('device.id', '=', grant.deviceId)
      .where('worker.id', '=', grant.sessionId)
      .where('worker.tokenHash', '=', grant.credentialHash)
      .where('worker.authorizationEpoch', '=', grant.authorizationEpoch)
      .executeTakeFirst();
    return row?.userId;
  }

  async grantQualifiedModel(
    input: {
      grant: DesktopWorkerGrant;
      ownerId: string;
      qualification: Selectable<DesktopWorkerQualificationTable>;
      modelKeys: readonly string[];
    },
    transaction: Transaction<DB>,
  ): Promise<boolean> {
    const { grant, ownerId, qualification: expected } = input;
    const allowed = models.parse(input.modelKeys);
    if (!allowed.includes(expected.modelKey)) return false;
    const db = transaction.withTables<DesktopWorkerTables & DesktopQualificationTables>();
    const worker = await lockDesktopWorker(db, grant);
    if (!worker) return false;
    const device = await db
      .selectFrom('desktop_device')
      .select('userId')
      .where('id', '=', grant.deviceId)
      .executeTakeFirst();
    if (device?.userId !== ownerId) return false;
    const current = await db
      .selectFrom('desktop_worker_qualification')
      .selectAll()
      .where('id', '=', expected.id)
      .where('deviceId', '=', grant.deviceId)
      .where('sessionId', '=', grant.sessionId)
      .where('authorizationEpoch', '=', grant.authorizationEpoch)
      .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    if (
      !current ||
      (['modelKey', 'profileSha256', 'configSha256', 'inputKind', 'runtimeFingerprint', 'reportSha256'] as const).some(
        (key) => current[key] !== expected[key],
      ) ||
      canonicalJson(current.runtime) !== canonicalJson(expected.runtime)
    )
      return false;
    const live = await db
      .selectFrom('desktop_worker_qualification')
      .select('modelKey')
      .where('deviceId', '=', grant.deviceId)
      .where('sessionId', '=', grant.sessionId)
      .where('authorizationEpoch', '=', grant.authorizationEpoch)
      .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
      .where('modelKey', 'in', [...worker.modelKeys, current.modelKey])
      .execute();
    const retained = worker.modelKeys.filter((key) => live.some((row) => row.modelKey === key));
    const keys = [...new Set([...retained, current.modelKey])].sort();
    if (keys.length > 64) return false;
    await db
      .updateTable('desktop_worker_session')
      .set({ modelKeys: sql<string[]>`${keys}::jsonb` })
      .where('id', '=', grant.sessionId)
      .execute();
    return true;
  }

  async device(userId: string, id: string) {
    const row = await this.db
      .selectFrom('desktop_device as device')
      .innerJoin('user as owner', 'owner.id', 'device.userId')
      .selectAll('device')
      .select('owner.isAdmin')
      .where('device.id', '=', id)
      .where('device.userId', '=', userId)
      .where('device.state', '=', 'preparing')
      .where('device.mode', '=', 'client-worker')
      .where('device.revokedAt', 'is', null)
      .where('owner.deletedAt', 'is', null)
      .executeTakeFirst();
    if (!row || !(await desktopWorkerAccountAllowed(this.db, userId, row.isAdmin))) return;
    const { isAdmin: _isAdmin, ...device } = row;
    return device;
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
      await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${EFFECTIVE_CONFIG_LOCK},0))`.execute(db);
      const { rows: owners } = await sql<{
        id: string;
        isAdmin: boolean;
      }>`SELECT u.id, u."isAdmin" FROM "user" u JOIN desktop_device d ON d."userId"=u.id
        WHERE d.id=${input.deviceId} AND u."deletedAt" IS NULL FOR SHARE OF u`.execute(db);
      if (owners.length !== 1 || !(await desktopWorkerAccountAllowed(db, owners[0].id, owners[0].isAdmin))) return;
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
      // A new photo association must never revive attempts or qualifications from an earlier sign-in.
      await db.deleteFrom('desktop_worker_session').where('deviceId', '=', input.deviceId).execute();
      return db.insertInto('desktop_worker_session').values(values).returningAll().executeTakeFirst();
    });
  }

  async session(id: string, tokenHash: Buffer) {
    const row = await this.db
      .selectFrom('desktop_worker_session as worker')
      .innerJoin('desktop_device as device', 'device.id', 'worker.deviceId')
      .innerJoin('user as owner', 'owner.id', 'device.userId')
      .innerJoin('session as photo', 'photo.id', 'worker.photoSessionId')
      .selectAll('worker')
      .select('device.publicKey')
      .select(['owner.id as ownerId', 'owner.isAdmin'])
      .where('worker.id', '=', id)
      .where('worker.tokenHash', '=', tokenHash)
      .where('worker.revokedAt', 'is', null)
      .where('worker.expiresAt', '>', sql<Date>`clock_timestamp()`)
      .whereRef('worker.authorizationEpoch', '=', 'device.authorizationEpoch')
      .whereRef('photo.userId', '=', 'owner.id')
      .where('device.state', '=', 'preparing')
      .where('device.mode', '=', 'client-worker')
      .where('device.revokedAt', 'is', null)
      .where('owner.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([eb('photo.expiresAt', 'is', null), eb('photo.expiresAt', '>', sql<Date>`clock_timestamp()`)]),
      )
      .executeTakeFirst();
    if (!row || !(await desktopWorkerAccountAllowed(this.db, row.ownerId, row.isAdmin))) return;
    const { ownerId: _ownerId, isAdmin: _isAdmin, ...session } = row;
    return session;
  }

  async consume(id: string, tokenHash: Buffer, sequence: number): Promise<DesktopWorkerGrant | undefined> {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2_147_483_647) return;
    const session = await this.session(id, tokenHash);
    if (!session) return;
    const grant = {
      sessionId: session.id,
      deviceId: session.deviceId,
      authorizationEpoch: session.authorizationEpoch,
      credentialHash: Buffer.from(session.tokenHash),
    };
    return this.db.transaction().execute(async (db) => {
      if (!(await lockDesktopWorker(db, grant))) return;
      const updated = await db
        .updateTable('desktop_worker_session')
        .set({ lastSequence: sequence, lastSeenAt: sql<Date>`clock_timestamp()` })
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
