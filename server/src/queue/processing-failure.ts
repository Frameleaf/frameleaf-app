import { type Kysely, type RawBuilder, sql } from 'kysely';
import { validate as isUuid } from 'uuid';
import type { DB } from 'src/schema/index.js';
import { JobName } from 'src/enum.js';

export const processingFailureSteps = [
  JobName.AssetExtractMetadata,
  JobName.AssetGenerateThumbnails,
  JobName.AssetEncodeVideo,
  JobName.SmartSearch,
  JobName.AssetDetectFaces,
  JobName.Ocr,
] as const;

export const isProcessingFailureStep = (name: string): name is (typeof processingFailureSteps)[number] =>
  (processingFailureSteps as readonly string[]).includes(name);

export const processingSetAsideOverride = (force?: boolean, includeSetAside?: boolean) =>
  force && includeSetAside ? ([{ includeSetAside: true }] as const) : [];

export const processingFailureCause = (reason: string, lifecycle?: 'crashed' | 'timed-out') => {
  if (lifecycle) return lifecycle;
  if (/worker.*(?:crashed|exited|killed)/iu.test(reason)) return 'crashed';
  if (/timed? ?out|deadline/iu.test(reason)) return 'timed-out';
  if (/unsupported|unknown format/iu.test(reason)) return 'unsupported';
  if (/too large|pixel limit|memory limit/iu.test(reason)) return 'too-large';
  return 'unreadable';
};

export const processingIsSetAside = (
  id: RawBuilder<unknown>,
  name: RawBuilder<unknown>,
  includeSetAside: RawBuilder<unknown>,
) => sql<boolean>`exists (
  select 1 from asset_processing_failure f where f."assetId" = ${id} and f.step = ${name}
  and (f."dismissedAt" is not null or (not ${includeSetAside} and f."quarantinedAt" is not null))
)`;

export const queuedProcessingIsSetAside = sql<boolean>`j.name = any(${[...processingFailureSteps]}::text[])
  and ${processingIsSetAside(
    sql`case when pg_input_is_valid(j.data->>'id', 'uuid') then (j.data->>'id')::uuid end`,
    sql`j.name`,
    sql`coalesce(j.data->'includeSetAside' = 'true'::jsonb, false)`,
  )}`;

export async function recordProcessingFailure(
  db: Kysely<DB>,
  { name, assetId }: { name: string; assetId: string | null },
  reason: string,
  lifecycle?: 'crashed' | 'timed-out',
): Promise<boolean> {
  if (!isProcessingFailureStep(name) || !assetId || !isUuid(assetId)) return false;
  // A worker can lose permission to publish because the original changed. That does not condemn the new source.
  if (
    !lifecycle &&
    (reason === 'Prepared output source changed' || reason.endsWith('source changed before publication'))
  ) {
    return false;
  }
  const cause = processingFailureCause(reason, lifecycle);
  // Store a fixed cause rather than exception text, which can contain paths or private metadata.
  const { rows } = await sql<{ setAside: boolean }>`insert into asset_processing_failure as f
    ("assetId", step, attempts, "lastError", "lastFailedAt")
    select id, ${name}, 1, ${cause}, clock_timestamp()
    from asset where id = ${assetId}::uuid and status = 'active' and not "isOffline"
    on conflict ("assetId", step) do update set attempts = f.attempts + 1,
      "lastError" = excluded."lastError", "lastFailedAt" = excluded."lastFailedAt",
      "quarantinedAt" = coalesce(f."quarantinedAt", case when f.attempts >= 2 then excluded."lastFailedAt" end)
    returning ("quarantinedAt" is not null or "dismissedAt" is not null) as "setAside"`.execute(db);
  return rows[0]?.setAside ?? false;
}

export async function clearProcessingFailure(db: Kysely<DB>, name: string, assetId: unknown) {
  if (!isProcessingFailureStep(name) || typeof assetId !== 'string' || !isUuid(assetId)) return;
  await db.deleteFrom('asset_processing_failure').where('assetId', '=', assetId).where('step', '=', name).execute();
}
