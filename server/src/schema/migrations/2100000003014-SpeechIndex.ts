import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE speech_settings (
    "ownerId" uuid PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false, scope text NOT NULL DEFAULT 'library',
    "albumIds" uuid[] NOT NULL DEFAULT '{}', "destinationId" uuid,
    generation uuid NOT NULL, "modelFingerprint" text, cursor uuid,
    "nextScanAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE speech_transcript (
    "assetId" uuid PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
    "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "operationId" uuid NOT NULL UNIQUE, generation uuid NOT NULL,
    checksum bytea NOT NULL, "indexVersion" integer NOT NULL,
    "modelFingerprint" text NOT NULL, model text, language text, "completedAt" timestamptz
  )`.execute(db);
  await sql`CREATE INDEX "IDX_speech_transcript_ownerId" ON speech_transcript("ownerId")`.execute(db);
  await sql`CREATE TABLE speech_window (
    "operationId" uuid NOT NULL, sequence integer NOT NULL,
    "assetId" uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    vector tsvector NOT NULL, tokens text[] NOT NULL, words jsonb NOT NULL,
    PRIMARY KEY ("operationId",sequence)
  )`.execute(db);
  await sql`CREATE INDEX "IDX_speech_window_assetId_operationId" ON speech_window("assetId","operationId")`.execute(db);
  await sql`CREATE INDEX "IDX_speech_window_vector" ON speech_window USING gin(vector)`.execute(db);
  await sql`CREATE TABLE speech_checkpoint (
    "operationId" uuid PRIMARY KEY, "assetId" uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    "nextChunk" integer NOT NULL, tail jsonb NOT NULL, model text, language text
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE speech_checkpoint, speech_window, speech_transcript, speech_settings`.execute(db);
}
