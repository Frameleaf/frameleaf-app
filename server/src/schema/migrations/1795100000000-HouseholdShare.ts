import { Kysely, sql } from 'kysely';

/**
 * FL-979: a shared space offered to a linked household, the accounts invited to it on that household's
 * server, and the change feed its manifest is read from.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.household_share (
      id uuid NOT NULL DEFAULT immich_uuid_v7(),
      "albumId" uuid NOT NULL,
      "linkId" uuid NOT NULL,
      "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT household_share_pkey PRIMARY KEY (id),
      CONSTRAINT "household_share_albumId_linkId_uq" UNIQUE ("albumId", "linkId"),
      CONSTRAINT "household_share_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album (id) ON DELETE CASCADE,
      CONSTRAINT "household_share_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES public.household_link (id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX "household_share_linkId_idx" ON public.household_share ("linkId")`.execute(db);
  await sql`
    CREATE TABLE public.household_share_member (
      "shareId" uuid NOT NULL,
      "remoteUserId" uuid NOT NULL,
      "displayName" text NOT NULL,
      role text NOT NULL,
      "invitedAt" timestamp with time zone NOT NULL DEFAULT now(),
      "acceptedAt" timestamp with time zone,
      "leftAt" timestamp with time zone,
      CONSTRAINT household_share_member_pkey PRIMARY KEY ("shareId", "remoteUserId"),
      CONSTRAINT "household_share_member_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES public.household_share (id) ON DELETE CASCADE,
      CONSTRAINT household_share_member_role_check CHECK (role = ANY (ARRAY['viewer'::text, 'contributor'::text]))
    )
  `.execute(db);
  await sql`
    CREATE TABLE public.household_share_change (
      seq integer NOT NULL GENERATED ALWAYS AS IDENTITY,
      "shareId" uuid NOT NULL,
      kind text NOT NULL,
      "entityId" uuid NOT NULL,
      "changedAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT household_share_change_pkey PRIMARY KEY (seq),
      CONSTRAINT "household_share_change_shareId_kind_entityId_uq" UNIQUE ("shareId", kind, "entityId"),
      CONSTRAINT "household_share_change_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES public.household_share (id) ON DELETE CASCADE,
      CONSTRAINT household_share_change_kind_check CHECK (kind = ANY (ARRAY['asset'::text, 'person'::text, 'comment'::text, 'space'::text]))
    )
  `.execute(db);
  await sql`CREATE INDEX "household_share_change_shareId_seq_idx" ON public.household_share_change ("shareId", seq)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.household_share_change`.execute(db);
  await sql`DROP TABLE public.household_share_member`.execute(db);
  await sql`DROP TABLE public.household_share`.execute(db);
}
