import { Kysely, sql } from 'kysely';

/** Restore existing model tables omitted from the capture entry point; the frozen baseline stays unchanged. */
export async function up(db: Kysely<any>): Promise<void> {
  if (!db.isTransaction) return db.transaction().execute(up);
  await sql`CREATE TABLE "asset_audio" (
  "assetId" uuid NOT NULL,
  "bitrate" integer NOT NULL,
  "index" smallint NOT NULL,
  "profile" smallint,
  "codecName" text NOT NULL,
  "channels" smallint,
  "channelLayout" text,
  "sampleRate" integer,
  CONSTRAINT "asset_audio_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "asset_audio_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE TABLE "asset_video" (
  "assetId" uuid NOT NULL,
  "bitrate" integer NOT NULL,
  "frameCount" integer NOT NULL,
  "timeBase" integer NOT NULL,
  "index" smallint NOT NULL,
  "profile" smallint,
  "level" smallint,
  "colorPrimaries" smallint NOT NULL,
  "colorTransfer" smallint NOT NULL,
  "colorMatrix" smallint NOT NULL,
  "dvProfile" smallint,
  "dvLevel" smallint,
  "dvBlSignalCompatibilityId" smallint,
  "codecName" text NOT NULL,
  "formatName" text NOT NULL,
  "formatLongName" text NOT NULL,
  "pixelFormat" text NOT NULL,
  CONSTRAINT "asset_video_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "asset_video_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE TABLE "asset_keyframe" (
  "assetId" uuid NOT NULL,
  "pts" integer[] NOT NULL,
  "accDuration" integer[] NOT NULL,
  "ownDuration" integer[] NOT NULL,
  "totalDuration" integer NOT NULL,
  "packetCount" integer NOT NULL,
  "outputFrames" integer NOT NULL,
  CONSTRAINT "asset_keyframe_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "asset_keyframe_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE TABLE "workflow_log" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "workflowId" uuid NOT NULL,
  "result" character varying NOT NULL,
  "workflowStepId" uuid,
  "triggerDataId" uuid,
  "runId" uuid NOT NULL,
  CONSTRAINT "workflow_log_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "workflow_log_workflowStepId_fkey" FOREIGN KEY ("workflowStepId") REFERENCES "workflow_step" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "workflow_log_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "workflow_log_workflowId_idx" ON "workflow_log" ("workflowId");`.execute(db);
  await sql`CREATE INDEX "workflow_log_workflowStepId_idx" ON "workflow_log" ("workflowStepId");`.execute(db);
}

export function down(): Promise<never> {
  return Promise.reject(
    new Error('Restored metadata tables cannot be dropped. Restore a Frameleaf backup into a fresh database.'),
  );
}
