import { type Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import type { DesktopMlRequest } from 'src/repositories/desktop-ml.repository.js';
import type { DesktopWorkerGrant } from 'src/repositories/desktop-worker.repository.js';
import type { DB } from 'src/schema/index.js';
import type { DesktopQualificationTables } from 'src/schema/tables/desktop-worker-qualification.table.js';
import { canonicalJson } from 'src/utils/object.js';

/** Synthetic broker evidence only; factory qualification is exercised by the challenge repository suite. */
export async function seedDesktopQualification(
  database: Kysely<DB>,
  grant: DesktopWorkerGrant,
  request: Pick<DesktopMlRequest, 'modelKey' | 'config' | 'inputKind'>,
) {
  const db = database.withTables<DesktopQualificationTables>();
  await db
    .deleteFrom('desktop_worker_qualification')
    .where('sessionId', '=', grant.sessionId)
    .where('modelKey', '=', request.modelKey)
    .execute();
  return db
    .insertInto('desktop_worker_qualification')
    .values({
      sessionId: grant.sessionId,
      deviceId: grant.deviceId,
      authorizationEpoch: grant.authorizationEpoch,
      modelKey: request.modelKey,
      profileSha256: 'a'.repeat(64),
      configSha256: createHash('sha256').update(canonicalJson(request.config)).digest('hex'),
      inputKind: request.inputKind,
      runtime: sql`${{ manifestSha256: 'b'.repeat(64), sourceRevision: 'c'.repeat(40), provider: 'CPUExecutionProvider', platform: 'linux', architecture: 'x86_64', epoch: 2 }}::jsonb`,
      runtimeFingerprint: 'd'.repeat(64),
      reportSha256: 'e'.repeat(64),
      createdAt: sql`now()`,
      expiresAt: sql`now() + interval '1 hour'`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
