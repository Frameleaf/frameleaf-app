import { Kysely, sql } from 'kysely';

/**
 * FL-1789: each person's count and most recent photo per viewer variant, so listing people never
 * aggregates faces, with one state row per variant; and an index for finding the faces that changed
 * since those were counted.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.person_summary (
      "ownerId" uuid NOT NULL,
      "viewerKey" text NOT NULL,
      "personGroupId" uuid NOT NULL,
      "assetCount" integer NOT NULL,
      "faceCount" integer NOT NULL,
      "lastSeenAt" timestamp with time zone,
      CONSTRAINT "person_summary_pkey" PRIMARY KEY ("ownerId", "viewerKey", "personGroupId"),
      CONSTRAINT "person_summary_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user" (id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "person_summary_personGroupId_fkey" FOREIGN KEY ("personGroupId") REFERENCES public.person_group (id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX "person_summary_personGroupId_idx" ON public.person_summary ("personGroupId")`.execute(db);
  await sql`
    CREATE TABLE public.person_summary_state (
      "ownerId" uuid NOT NULL,
      "viewerKey" text NOT NULL,
      "computedAt" timestamp with time zone NOT NULL,
      "checkedFrom" timestamp with time zone NOT NULL,
      "changeToken" text,
      CONSTRAINT "person_summary_state_pkey" PRIMARY KEY ("ownerId", "viewerKey"),
      CONSTRAINT "person_summary_state_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user" (id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX "asset_face_updateId_idx" ON public.asset_face ("updateId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX public."asset_face_updateId_idx"`.execute(db);
  await sql`DROP TABLE public.person_summary_state`.execute(db);
  await sql`DROP TABLE public.person_summary`.execute(db);
}
