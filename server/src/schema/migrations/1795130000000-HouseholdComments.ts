import { Kysely, sql } from 'kysely';

/** FL-1012: comments and likes across linked households. A remote comment has an author row and no local user. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.household_remote_author (
      id uuid NOT NULL DEFAULT uuid_generate_v4(),
      "linkId" uuid NOT NULL,
      "remoteUserId" uuid NOT NULL,
      "displayName" text NOT NULL,
      "avatarPath" text,
      CONSTRAINT household_remote_author_pkey PRIMARY KEY (id),
      CONSTRAINT "household_remote_author_linkId_remoteUserId_uq" UNIQUE ("linkId", "remoteUserId"),
      CONSTRAINT "household_remote_author_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES public.household_link (id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`
    ALTER TABLE public.activity
      ALTER COLUMN "userId" DROP NOT NULL,
      ADD COLUMN "remoteAuthorId" uuid,
      ADD CONSTRAINT "activity_remoteAuthorId_fkey" FOREIGN KEY ("remoteAuthorId") REFERENCES public.household_remote_author (id) ON DELETE CASCADE,
      ADD CONSTRAINT activity_author_check CHECK (("userId" IS NULL) <> ("remoteAuthorId" IS NULL))
  `.execute(db);
  await sql`CREATE INDEX "activity_remoteAuthorId_idx" ON public.activity ("remoteAuthorId")`.execute(db);
  await sql`
    CREATE UNIQUE INDEX activity_remote_asset_like_idx ON public.activity ("albumId", "assetId", "remoteAuthorId")
    WHERE ("isLiked" = true AND "assetId" IS NOT NULL AND "remoteAuthorId" IS NOT NULL)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX activity_remote_space_like_idx ON public.activity ("albumId", "remoteAuthorId")
    WHERE ("isLiked" = true AND "assetId" IS NULL AND "remoteAuthorId" IS NOT NULL)
  `.execute(db);

  await sql`ALTER TABLE public.household_share_change ADD COLUMN "assetId" uuid`.execute(db);
  await sql`
    CREATE INDEX household_share_change_comment_asset_idx ON public.household_share_change ("assetId")
    WHERE (kind = 'comment')
  `.execute(db);

  await sql`
    CREATE TABLE public.household_comment (
      "inboundShareId" uuid NOT NULL,
      "remoteId" uuid NOT NULL,
      "activityId" uuid,
      own boolean NOT NULL DEFAULT false,
      pending text,
      revision integer NOT NULL DEFAULT 0,
      attempts integer NOT NULL DEFAULT 0,
      "nextAttemptAt" timestamp with time zone,
      CONSTRAINT household_comment_pkey PRIMARY KEY ("inboundShareId", "remoteId"),
      CONSTRAINT "household_comment_inboundShareId_fkey" FOREIGN KEY ("inboundShareId") REFERENCES public.household_inbound_share (id) ON DELETE CASCADE,
      CONSTRAINT "household_comment_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public.activity (id) ON DELETE SET NULL,
      CONSTRAINT household_comment_pending_check CHECK (pending = ANY (ARRAY['post'::text, 'put'::text, 'delete'::text]))
    )
  `.execute(db);
  await sql`CREATE INDEX "household_comment_activityId_idx" ON public.household_comment ("activityId")`.execute(db);
  await sql`
    CREATE INDEX household_comment_pending_idx ON public.household_comment ("inboundShareId", "nextAttemptAt")
    WHERE (pending IS NOT NULL)
  `.execute(db);

  // existing shares: every comment already in a shared space enters its feed, after the items it is about
  await sql`
    INSERT INTO public.household_share_change ("shareId", kind, "entityId", "assetId")
    SELECT hs.id, 'comment', activity.id, activity."assetId"
    FROM public.household_share hs
    INNER JOIN public.activity ON activity."albumId" = hs."albumId"
    ON CONFLICT ("shareId", kind, "entityId") DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM public.household_share_change WHERE kind = 'comment'`.execute(db);
  await sql`DROP TABLE public.household_comment`.execute(db);
  await sql`DROP INDEX public.household_share_change_comment_asset_idx`.execute(db);
  await sql`ALTER TABLE public.household_share_change DROP COLUMN "assetId"`.execute(db);
  await sql`DELETE FROM public.activity WHERE "remoteAuthorId" IS NOT NULL`.execute(db);
  await sql`DROP INDEX public.activity_remote_space_like_idx`.execute(db);
  await sql`DROP INDEX public.activity_remote_asset_like_idx`.execute(db);
  await sql`DROP INDEX public."activity_remoteAuthorId_idx"`.execute(db);
  await sql`
    ALTER TABLE public.activity
      DROP CONSTRAINT activity_author_check,
      DROP CONSTRAINT "activity_remoteAuthorId_fkey",
      DROP COLUMN "remoteAuthorId",
      ALTER COLUMN "userId" SET NOT NULL
  `.execute(db);
  await sql`DROP TABLE public.household_remote_author`.execute(db);
}
