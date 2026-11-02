import { Kysely, sql } from 'kysely';

// FL-1094: one outfit embedding (the torso under a face) per face, for magic albums' "same outfit" signal.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE asset_face_outfit (
    "faceId" uuid NOT NULL,
    "modelName" text NOT NULL,
    "embedding" text,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT asset_face_outfit_pkey PRIMARY KEY ("faceId"),
    CONSTRAINT "asset_face_outfit_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES asset_face(id) ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "asset_face_outfit_faceId_idx" ON asset_face_outfit ("faceId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE asset_face_outfit`.execute(db);
}
