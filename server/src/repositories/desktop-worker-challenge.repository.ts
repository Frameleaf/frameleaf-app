import { Injectable } from '@nestjs/common';
import { type Kysely, type Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import z from 'zod';
import { type DesktopWorkerGrant, lockDesktopWorker } from 'src/repositories/desktop-worker.repository.js';
import { DB } from 'src/schema/index.js';
import { DesktopWorkerChallengeTable } from 'src/schema/tables/desktop-worker-challenge.table.js';
import { type DesktopQualificationTables } from 'src/schema/tables/desktop-worker-qualification.table.js';
import {
  type DesktopModelProfile,
  createDesktopModelChallenge,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { DesktopQualificationReceipt, type DesktopRuntimeIdentity } from 'src/utils/desktop-qualification.js';
import { canonicalJson } from 'src/utils/object.js';

export type DesktopWorkerChallengeTables = { desktop_worker_challenge: DesktopWorkerChallengeTable };
type ChallengeDatabase = DB & DesktopWorkerChallengeTables & DesktopQualificationTables;
type Challenge = Selectable<DesktopWorkerChallengeTable>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const runtimeSchema = z.strictObject({
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  provider: z.string().min(1).max(64),
  platform: z.enum(['macos', 'windows', 'linux']),
  architecture: z.enum(['aarch64', 'x86_64']),
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

@Injectable()
export class DesktopWorkerChallengeRepository {
  private db: Kysely<ChallengeDatabase>;
  constructor(@InjectKysely() db: Kysely<DB>) {
    this.db = db.withTables<DesktopWorkerChallengeTables & DesktopQualificationTables>();
  }

  /** Call only after release-owned profile selection and factory runtime verification; never grants inference scope. */
  issue(
    grant: DesktopWorkerGrant,
    requestId: string,
    profile: DesktopModelProfile,
    runtime: DesktopRuntimeIdentity,
  ): Promise<Challenge | undefined> {
    z.uuidv4()
      .refine((value) => value === value.toLowerCase())
      .parse(requestId);
    parseDesktopModelCatalogue({ schemaVersion: 1, epoch: 1, profiles: [profile] });
    const identity = runtimeSchema.parse(runtime);
    if (identity.sourceRevision !== profile.runtimeSourceRevision || identity.provider !== profile.spec.provider)
      throw new Error('desktop_challenge_runtime_invalid');
    const profileSha256 = sha(canonicalJson(profile));
    return this.db.transaction().execute(async (db) => {
      const worker = await lockDesktopWorker(db, grant);
      if (!worker) return;
      const device = await db
        .selectFrom('desktop_device')
        .select(['platform', 'architecture'])
        .where('id', '=', grant.deviceId)
        .executeTakeFirstOrThrow();
      if (
        device.platform !== identity.platform ||
        (device.architecture === 'arm64' ? 'aarch64' : device.architecture) !== identity.architecture
      )
        throw new Error('desktop_challenge_runtime_invalid');
      await db
        .deleteFrom('desktop_worker_challenge')
        .where('deviceId', '=', grant.deviceId)
        .where((eb) =>
          eb.or([
            eb('expiresAt', '<=', sql<Date>`clock_timestamp()`),
            eb('credentialHash', '!=', grant.credentialHash),
            eb('sessionId', '!=', grant.sessionId),
            eb('authorizationEpoch', '!=', grant.authorizationEpoch),
          ]),
        )
        .execute();
      const existing = await db
        .selectFrom('desktop_worker_challenge')
        .selectAll()
        .where('sessionId', '=', grant.sessionId)
        .where('requestId', '=', requestId)
        .executeTakeFirst();
      if (existing) {
        if (existing.profileSha256 !== profileSha256 || canonicalJson(existing.runtime) !== canonicalJson(identity))
          throw new Error('desktop_challenge_conflict');
        return existing;
      }
      const count = await db
        .selectFrom('desktop_worker_challenge')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('deviceId', '=', grant.deviceId)
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= 16) throw new Error('desktop_challenge_capacity');
      const { issuedAt } = await db.selectNoFrom(sql<Date>`clock_timestamp()`.as('issuedAt')).executeTakeFirstOrThrow();
      const id = randomUUID();
      const challenge = createDesktopModelChallenge(profile, id);
      if (Buffer.byteLength(challenge.specJson) > 1024 * 1024) throw new Error('desktop_challenge_too_large');
      return db
        .insertInto('desktop_worker_challenge')
        .values({
          id,
          deviceId: grant.deviceId,
          sessionId: grant.sessionId,
          requestId,
          authorizationEpoch: grant.authorizationEpoch,
          credentialHash: grant.credentialHash,
          modelKey: profile.modelKey,
          profileSha256,
          runtime: sql<DesktopRuntimeIdentity>`${identity}::jsonb`,
          specJson: challenge.specJson,
          bindingSha256: challenge.bindingSha256,
          createdAt: issuedAt,
          expiresAt: sql<Date>`LEAST(${issuedAt}::timestamptz + interval '10 minutes', ${worker.expiresAt}::timestamptz)`,
          reportSha256: null,
          runtimeFingerprint: null,
          reportedAt: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  read(grant: DesktopWorkerGrant, id: string): Promise<Challenge | undefined> {
    z.uuidv4().parse(id);
    return this.db.transaction().execute(async (db) => {
      if (!(await lockDesktopWorker(db, grant))) return;
      return this.scoped(db, grant, id).executeTakeFirst();
    });
  }

  record(grant: DesktopWorkerGrant, id: string, receipt: DesktopQualificationReceipt): Promise<boolean> {
    z.uuidv4().parse(id);
    if (!(receipt instanceof DesktopQualificationReceipt) || !Object.isFrozen(receipt)) return Promise.resolve(false);
    return this.db.transaction().execute(async (db) => {
      if (!(await lockDesktopWorker(db, grant))) return false;
      const row = await this.scoped(db, grant, id).forUpdate().executeTakeFirst();
      if (
        !row ||
        row.bindingSha256 !== receipt.bindingSha256 ||
        row.profileSha256 !== receipt.profileSha256 ||
        row.modelKey !== receipt.modelKey ||
        row.runtime.manifestSha256 !== receipt.manifestSha256
      )
        return false;
      if (row.reportSha256 !== null)
        return row.reportSha256 === receipt.reportSha256 && row.runtimeFingerprint === receipt.runtimeFingerprint;
      const spec = z
        .object({ entries: z.record(z.string(), z.json()), fixtureKind: z.enum(['image', 'text']) })
        .parse(JSON.parse(row.specJson));
      await db
        .deleteFrom('desktop_worker_qualification')
        .where('deviceId', '=', grant.deviceId)
        .where((eb) => eb.or([eb('expiresAt', '<=', sql<Date>`clock_timestamp()`), eb('modelKey', '=', row.modelKey)]))
        .execute();
      const { count } = await db
        .selectFrom('desktop_worker_qualification')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('deviceId', '=', grant.deviceId)
        .executeTakeFirstOrThrow();
      if (Number(count) >= 64) throw new Error('desktop_qualification_capacity');
      const { acceptedAt } = await db
        .selectNoFrom(sql<Date>`clock_timestamp()`.as('acceptedAt'))
        .executeTakeFirstOrThrow();
      await db
        .insertInto('desktop_worker_qualification')
        .values({
          id: row.id,
          deviceId: grant.deviceId,
          sessionId: grant.sessionId,
          authorizationEpoch: grant.authorizationEpoch,
          modelKey: row.modelKey,
          profileSha256: row.profileSha256,
          configSha256: sha(canonicalJson(spec.entries)),
          inputKind: spec.fixtureKind,
          runtime: sql<DesktopRuntimeIdentity>`${row.runtime}::jsonb`,
          runtimeFingerprint: receipt.runtimeFingerprint,
          reportSha256: receipt.reportSha256,
          createdAt: acceptedAt,
          expiresAt: sql<Date>`${acceptedAt}::timestamptz + interval '1 hour'`,
        })
        .execute();
      await db
        .updateTable('desktop_worker_challenge')
        .set({
          reportSha256: receipt.reportSha256,
          runtimeFingerprint: receipt.runtimeFingerprint,
          reportedAt: sql<Date>`clock_timestamp()`,
        })
        .where('id', '=', row.id)
        .execute();
      return true;
    });
  }

  private scoped(db: Kysely<ChallengeDatabase>, grant: DesktopWorkerGrant, id: string) {
    return db
      .selectFrom('desktop_worker_challenge')
      .selectAll()
      .where('id', '=', id)
      .where('sessionId', '=', grant.sessionId)
      .where('deviceId', '=', grant.deviceId)
      .where('authorizationEpoch', '=', grant.authorizationEpoch)
      .where('credentialHash', '=', grant.credentialHash)
      .where('expiresAt', '>', sql<Date>`clock_timestamp()`);
  }
}
