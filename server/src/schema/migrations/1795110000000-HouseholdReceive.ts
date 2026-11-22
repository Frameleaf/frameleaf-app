import { Kysely, sql } from 'kysely';

/** FL-994: what this server received from linked households, per local account. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.household_link ADD COLUMN "pollRequestedAt" timestamp with time zone`.execute(db);
  await sql`
    CREATE TABLE public.household_inbound_share (
      id uuid NOT NULL DEFAULT immich_uuid_v7(),
      "linkId" uuid NOT NULL,
      "remoteShareId" uuid NOT NULL,
      "userId" uuid NOT NULL,
      "albumId" uuid,
      "spaceName" text NOT NULL,
      "ownerName" text NOT NULL,
      state text NOT NULL DEFAULT 'invited',
      cursor integer NOT NULL DEFAULT 0,
      "lastPulledAt" timestamp with time zone,
      "lastError" text,
      failures integer NOT NULL DEFAULT 0,
      "nextPullAt" timestamp with time zone,
      "pullingUntil" timestamp with time zone,
      "leaveUnsent" boolean NOT NULL DEFAULT false,
      "partialPath" text,
      "reconcileStartedAt" timestamp with time zone,
      "lastReconciledAt" timestamp with time zone,
      "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT household_inbound_share_pkey PRIMARY KEY (id),
      CONSTRAINT "household_inbound_share_linkId_remoteShareId_userId_uq" UNIQUE ("linkId", "remoteShareId", "userId"),
      CONSTRAINT "household_inbound_share_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES public.household_link (id) ON DELETE CASCADE,
      CONSTRAINT "household_inbound_share_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user" (id) ON DELETE CASCADE,
      CONSTRAINT "household_inbound_share_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album (id) ON DELETE SET NULL,
      CONSTRAINT household_inbound_share_state_check CHECK (state = ANY (ARRAY['invited'::text, 'accepted'::text, 'left'::text]))
    )
  `.execute(db);
  await sql`CREATE INDEX "household_inbound_share_userId_idx" ON public.household_inbound_share ("userId")`.execute(db);
  await sql`CREATE INDEX "household_inbound_share_albumId_idx" ON public.household_inbound_share ("albumId")`.execute(db);
  await sql`
    CREATE TABLE public.household_origin (
      "linkId" uuid NOT NULL,
      "remoteId" uuid NOT NULL,
      kind text NOT NULL,
      "userId" uuid NOT NULL,
      "localId" uuid NOT NULL,
      "followUntilEdited" boolean NOT NULL DEFAULT true,
      "overriddenFields" text[] NOT NULL DEFAULT '{}',
      "isCopy" boolean NOT NULL DEFAULT false,
      "shareIds" uuid[] NOT NULL DEFAULT '{}',
      "pairedRemoteId" uuid,
      "remoteUpdatedAt" timestamp with time zone,
      "lastSeenAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT household_origin_pkey PRIMARY KEY ("linkId", "remoteId", kind, "userId"),
      CONSTRAINT "household_origin_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES public.household_link (id) ON DELETE CASCADE,
      CONSTRAINT "household_origin_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user" (id) ON DELETE CASCADE,
      CONSTRAINT household_origin_kind_check CHECK (kind = ANY (ARRAY['asset'::text, 'album'::text, 'person'::text]))
    )
  `.execute(db);
  await sql`CREATE INDEX "household_origin_localId_kind_idx" ON public.household_origin ("localId", kind)`.execute(db);
  await sql`CREATE INDEX "household_origin_userId_idx" ON public.household_origin ("userId")`.execute(db);
  await sql`
    CREATE TABLE public.household_received_file (
      "linkId" uuid NOT NULL,
      checksum bytea NOT NULL,
      path text NOT NULL,
      size bigint NOT NULL,
      "receivedAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT household_received_file_pkey PRIMARY KEY ("linkId", checksum),
      CONSTRAINT "household_received_file_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES public.household_link (id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`
    CREATE TABLE public.household_person_pending (
      "linkId" uuid NOT NULL,
      "userId" uuid NOT NULL,
      "remoteId" uuid NOT NULL,
      name text NOT NULL,
      faces jsonb NOT NULL,
      CONSTRAINT household_person_pending_pkey PRIMARY KEY ("linkId", "userId", "remoteId"),
      CONSTRAINT "household_person_pending_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES public.household_link (id) ON DELETE CASCADE,
      CONSTRAINT "household_person_pending_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user" (id) ON DELETE CASCADE
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.household_person_pending`.execute(db);
  await sql`DROP TABLE public.household_received_file`.execute(db);
  await sql`DROP TABLE public.household_origin`.execute(db);
  await sql`DROP TABLE public.household_inbound_share`.execute(db);
  await sql`ALTER TABLE public.household_link DROP COLUMN "pollRequestedAt"`.execute(db);
}
