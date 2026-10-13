import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`UPDATE public.asset_lock SET reason = 'frameleaf-locked-folder' WHERE reason = 'immich-locked-folder'`.execute(
    db,
  );
  const mlUrl =
    process.env.FRAMELEAF_MACHINE_LEARNING_URL ||
    process.env.IMMICH_MACHINE_LEARNING_URL ||
    'http://immich-machine-learning:3003';
  // Saved settings omit defaults. Materialize the old values so approved configuration epochs still match.
  await sql`
    INSERT INTO public.system_metadata (key, value)
    SELECT 'system-config',
      (settings - 'machineLearning' - 'oauth') || jsonb_build_object(
        'machineLearning', jsonb_build_object('urls', ${[mlUrl]}::jsonb)
          || COALESCE(settings->'machineLearning', '{}'::jsonb),
        'oauth', jsonb_build_object('roleClaim', 'immich_role', 'storageQuotaClaim', 'immich_quota')
          || COALESCE(settings->'oauth', '{}'::jsonb)
      )
    FROM (SELECT COALESCE((SELECT value FROM public.system_metadata WHERE key = 'system-config'), '{}'::jsonb) AS settings) AS current
    WHERE EXISTS (
      SELECT 1 FROM public.system_metadata
      WHERE key = 'system-config' OR (key = 'effective-config-epoch' AND value->>'sourceKind' = 'database')
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`UPDATE public.asset_lock SET reason = 'immich-locked-folder' WHERE reason = 'frameleaf-locked-folder'`.execute(
    db,
  );
}
