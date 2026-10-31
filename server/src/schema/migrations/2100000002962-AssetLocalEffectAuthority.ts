import { Kysely, sql } from 'kysely';

/** Reserved FL296 local effect authority. No inferred historical order or grant backfill. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.asset_local_effect_stream (
    "ownerId" uuid PRIMARY KEY REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "streamEpoch" uuid NOT NULL, "nextSequence" bigint NOT NULL DEFAULT 1,
    CONSTRAINT asset_local_effect_stream_sequence_check CHECK ("nextSequence">0)
  )`.execute(db);
  await sql`CREATE TABLE public.asset_local_effect (
    "ownerId" uuid NOT NULL REFERENCES public.asset_local_effect_stream("ownerId") ON UPDATE CASCADE ON DELETE CASCADE,
    sequence bigint NOT NULL, "effectId" uuid NOT NULL, bundle jsonb NOT NULL, "bundleSha256" bytea NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY("ownerId",sequence),
    CONSTRAINT asset_local_effect_id_uq UNIQUE("effectId"),
    CONSTRAINT asset_local_effect_sequence_check CHECK(sequence>0),
    CONSTRAINT asset_local_effect_digest_check CHECK(octet_length("bundleSha256")=32),
    CONSTRAINT asset_local_effect_bundle_check CHECK(jsonb_typeof(bundle)='object' AND bundle->>'formatVersion'='1')
  )`.execute(db);
  await sql`CREATE TABLE public.asset_local_effect_cursor (
    "ownerId" uuid PRIMARY KEY REFERENCES public.asset_local_effect_stream("ownerId") ON UPDATE CASCADE ON DELETE CASCADE,
    "acknowledgedSequence" bigint,
    CONSTRAINT asset_local_effect_cursor_sequence_check CHECK("acknowledgedSequence" IS NULL OR "acknowledgedSequence">0),
    FOREIGN KEY("ownerId","acknowledgedSequence") REFERENCES public.asset_local_effect("ownerId",sequence)
  )`.execute(db);
  await sql`CREATE TABLE public.asset_source_epoch (
    "assetId" uuid PRIMARY KEY REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "ownerId" uuid NOT NULL REFERENCES public.asset_local_effect_stream("ownerId") ON UPDATE CASCADE ON DELETE CASCADE,
    "lastTrashSequence" bigint NOT NULL,
    CONSTRAINT asset_source_epoch_sequence_check CHECK("lastTrashSequence">0),
    FOREIGN KEY("ownerId","lastTrashSequence") REFERENCES public.asset_local_effect("ownerId",sequence)
  )`.execute(db);
  await sql`CREATE INDEX asset_source_epoch_owner_sequence_idx ON public.asset_source_epoch("ownerId","lastTrashSequence","assetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.asset_source_epoch,public.asset_local_effect_cursor,public.asset_local_effect,public.asset_local_effect_stream`.execute(db);
}
