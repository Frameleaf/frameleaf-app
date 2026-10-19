import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`DO $repair$
  DECLARE owned_sequence text;
  BEGIN
    owned_sequence := pg_get_serial_sequence('public.naturalearth_countries', 'id');
    IF owned_sequence = 'public.naturalearth_countries_tmp_id_seq' THEN
      IF to_regclass('public.naturalearth_countries_id_seq') IS NOT NULL THEN
        RAISE EXCEPTION 'geodata_sequence_conflict';
      END IF;
      ALTER SEQUENCE public.naturalearth_countries_tmp_id_seq RENAME TO naturalearth_countries_id_seq;
    ELSIF owned_sequence IS DISTINCT FROM 'public.naturalearth_countries_id_seq' THEN
      RAISE EXCEPTION 'geodata_sequence_binding_invalid';
    END IF;
  END $repair$`.execute(db);
  await sql`DO $repair$
  DECLARE index_method text;
  BEGIN
    IF to_regclass('public."IDX_geodata_gist_earthcoord"') IS NOT NULL THEN
      SELECT am.amname INTO index_method FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
        WHERE i.indexrelid = 'public."IDX_geodata_gist_earthcoord"'::regclass
          AND i.indrelid = 'public.geodata_places'::regclass
          AND NOT i.indisunique AND i.indisvalid AND i.indisready
          AND i.indpred IS NULL AND i.indnatts = 1
          AND pg_get_expr(i.indexprs, i.indrelid) = 'll_to_earth_public(latitude, longitude)';
      IF index_method IS NULL OR index_method NOT IN ('btree', 'gist') THEN
        RAISE EXCEPTION 'geodata_index_binding_invalid';
      END IF;
      IF index_method = 'gist' THEN RETURN; END IF;
      DROP INDEX public."IDX_geodata_gist_earthcoord";
    END IF;
    CREATE INDEX "IDX_geodata_gist_earthcoord" ON public.geodata_places
      USING gist (ll_to_earth_public(latitude, longitude));
  END $repair$`.execute(db);
  // PG19's dump/restore normalizes this array cast; retain the same two allowed values.
  const { rows } = await sql<{ definition: string }>`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid = 'public.desktop_worker_qualification'::regclass
      AND conname = 'desktop_worker_qualification_kind_check'`.execute(db);
  if (
    !new Set([
      `CHECK ((("inputKind")::text = ANY ((ARRAY['image'::character varying, 'text'::character varying])::text[])))`,
      `CHECK ((("inputKind")::text = ANY (ARRAY[('image'::character varying)::text, ('text'::character varying)::text])))`,
    ]).has(rows[0]?.definition)
  ) {
    throw new Error('geodata_qualification_constraint_changed');
  }
  await sql`ALTER TABLE public.desktop_worker_qualification
    DROP CONSTRAINT desktop_worker_qualification_kind_check,
    ADD CONSTRAINT desktop_worker_qualification_kind_check
      CHECK ("inputKind"::text = ANY (ARRAY['image'::varchar::text, 'text'::varchar::text]))`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Keep the repaired identity sequence: its canonical name is also valid on older runtimes.
  await sql`DROP INDEX public."IDX_geodata_gist_earthcoord"`.execute(db);
  await sql`CREATE INDEX "IDX_geodata_gist_earthcoord" ON public.geodata_places
    USING btree (ll_to_earth_public(latitude, longitude))`.execute(db);
}
