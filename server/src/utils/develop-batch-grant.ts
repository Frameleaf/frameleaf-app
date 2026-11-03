import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { Permission } from 'src/enum.js';
import { isGranted } from 'src/utils/access.js';

/** Null means revoked; otherwise returns whether the current session has a live PIN grant. */
export async function liveBatchGrant(
  db: Kysely<DB>,
  ownerId: string,
  sessionId: string | null,
  apiKeyId: string | null,
  permission: Permission,
  lock = false,
): Promise<boolean | null> {
  if (sessionId && !apiKeyId) {
    const query = db
      .selectFrom('session')
      .innerJoin('user', 'user.id', 'session.userId')
      .select(sql<boolean>`COALESCE(session."pinExpiresAt">clock_timestamp(),false)`.as('elevated'))
      .where('session.id', '=', sessionId)
      .where('session.userId', '=', ownerId)
      .where('user.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([eb('session.expiresAt', 'is', null), eb('session.expiresAt', '>', sql<Date>`clock_timestamp()`)]),
      );
    const session = await (lock ? query.forShare('session') : query).executeTakeFirst();
    return session ? session.elevated : null;
  }
  if (apiKeyId && !sessionId) {
    const query = db
      .selectFrom('api_key')
      .innerJoin('user', 'user.id', 'api_key.userId')
      .select('api_key.permissions')
      .where('api_key.id', '=', apiKeyId)
      .where('api_key.userId', '=', ownerId)
      .where('user.deletedAt', 'is', null);
    const key = await (lock ? query.forShare('api_key') : query).executeTakeFirst();
    return key && isGranted({ requested: [permission], current: key.permissions }) ? false : null;
  }
  return null;
}
