import { Transaction, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { UserMetadataKey } from 'src/enum.js';
import { ICloudConnection } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { DB } from 'src/schema/index.js';
import { canonicalJson } from 'src/utils/studio-project.js';

/** Activation prerequisites only. Neither configuration nor consent certifies deployed qualification.
 * Root must qualify the worker/provider/schedule before enabling execution. No receipt carries this state.
 */
export const weeklyIdentityAdoptionActive = () =>
  process.env.FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION === 'true' && new ICloudTransportRepository().enabled();

export type WeeklyIdentityAdoptionContext = {
  ownerId: string;
  connectionId: string;
  grantId: string;
  generation: number;
  configFingerprint: string;
  privacyFingerprint: string;
  includeProtected: boolean;
  pinBinding: string | null;
  config: ICloudConnection['config'];
  privacy: unknown;
};
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Protect still/motion classification without taking an asset row before the managed path lock. */
export async function lockIdentityAdoptionMetadata(db: Transaction<DB>, assetId: string) {
  const related = async () =>
    (
      await sql<{ id: string }>`SELECT id FROM public.asset
    WHERE id=${assetId}::uuid OR "livePhotoVideoId"=${assetId}::uuid
      OR id IN (SELECT "livePhotoVideoId" FROM public.asset WHERE id=${assetId}::uuid)
    ORDER BY id`.execute(db)
    ).rows.map(({ id }) => id);
  const ids = await related();
  for (const id of [...new Set([assetId, ...ids])].sort()) {
    await sql`SELECT pg_advisory_xact_lock(-1,hashtext(${id})::int)`.execute(db);
  }
  return canonicalJson(ids) === canonicalJson(await related());
}

/** Caller holds the managed-writer digest/capture prefix; owner -> preferences -> connection -> grant.
 * This does not broaden original adoption eligibility or provide a user/provider session.
 */
export async function guardWeeklyIdentityAdoption(
  db: Transaction<DB>,
  ownerId: string,
  connectionId: string,
  expected?: WeeklyIdentityAdoptionContext,
): Promise<WeeklyIdentityAdoptionContext | undefined> {
  if (!db.isTransaction || !weeklyIdentityAdoptionActive()) {
    return;
  }
  const owner = await db
    .selectFrom('user')
    .select(['pinCode', 'deletedAt'])
    .where('id', '=', ownerId)
    .forUpdate()
    .executeTakeFirst();
  if (!owner || owner.deletedAt) {
    return;
  }
  const {
    rows: [metadata],
  } = await sql<{ privacy: unknown }>`SELECT coalesce(value->'privacy','{}'::jsonb) AS privacy
    FROM public.user_metadata WHERE "userId"=${ownerId}::uuid AND key=${UserMetadataKey.Preferences} FOR SHARE`.execute(
    db,
  );
  const {
    rows: [connection],
  } = await sql<ICloudConnection>`SELECT * FROM public.icloud_connection
    WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid FOR SHARE`.execute(db);
  if (
    !connection ||
    connection.state !== 'connected' ||
    !connection.encryptedSession ||
    connection.lastError === 'owner_removed'
  ) {
    return;
  }
  const {
    rows: [grant],
  } = await sql<{
    id: string;
    generation: number;
    enabled: boolean;
    includeProtected: boolean;
    configFingerprint: string;
    privacyFingerprint: string;
    pinBinding: string | null;
  }>`SELECT * FROM public.icloud_weekly_grant
    WHERE "ownerId"=${ownerId}::uuid AND "connectionId"=${connectionId}::uuid FOR SHARE`.execute(db);
  const privacy = metadata?.privacy ?? {};
  if (
    !grant?.enabled ||
    grant.configFingerprint !== fingerprint(connection.config) ||
    grant.privacyFingerprint !== fingerprint(privacy) ||
    (grant.includeProtected && (!owner.pinCode || grant.pinBinding !== fingerprint(['weekly-pin-v1', owner.pinCode])))
  ) {
    return;
  }
  const context: WeeklyIdentityAdoptionContext = {
    ownerId,
    connectionId,
    grantId: grant.id,
    generation: grant.generation,
    configFingerprint: grant.configFingerprint,
    privacyFingerprint: grant.privacyFingerprint,
    includeProtected: grant.includeProtected,
    pinBinding: grant.pinBinding,
    config: connection.config,
    privacy,
  };
  if (expected && canonicalJson(context) !== canonicalJson(expected)) {
    return;
  }
  return weeklyIdentityAdoptionActive() ? context : undefined;
}

/** Embed after all awaited checks in the mapping/replay SQL itself. Locks cannot extend leases or generation. */
export function weeklyIdentityAdoptionFence(context: WeeklyIdentityAdoptionContext) {
  return sql<boolean>`${weeklyIdentityAdoptionActive()} AND EXISTS (
    SELECT 1 FROM public.icloud_weekly_grant g
    JOIN public.icloud_connection c ON c.id=g."connectionId" AND c."ownerId"=g."ownerId"
    JOIN public."user" u ON u.id=g."ownerId"
    LEFT JOIN public.user_metadata p ON p."userId"=u.id AND p.key=${UserMetadataKey.Preferences}
    WHERE g.id=${context.grantId}::uuid AND g."ownerId"=${context.ownerId}::uuid AND g."connectionId"=${context.connectionId}::uuid
      AND g.enabled AND g.generation=${context.generation} AND g."configFingerprint"=${context.configFingerprint}
      AND g."privacyFingerprint"=${context.privacyFingerprint} AND g."includeProtected"=${context.includeProtected}
      AND g."pinBinding" IS NOT DISTINCT FROM ${context.pinBinding} AND u."deletedAt" IS NULL
      -- The final guard recomputes the PIN binding under this owner's held row lock. Carry no raw PIN in authority.
      AND (NOT g."includeProtected" OR (u."pinCode" IS NOT NULL AND u."pinCode"<>''))
      AND c.state='connected' AND c."encryptedSession" IS NOT NULL AND c."lastError" IS DISTINCT FROM 'owner_removed'
      AND c.config=${JSON.stringify(context.config)}::text::jsonb AND coalesce(p.value->'privacy','{}'::jsonb)=${JSON.stringify(context.privacy)}::text::jsonb)`;
}
