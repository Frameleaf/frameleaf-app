import { Kysely, sql } from 'kysely';

/**
 * FL-952: a link with another household's server, and the request proofs admitted from it (kept until
 * their grant expires, so none can be replayed).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.household_link (
      id uuid NOT NULL DEFAULT immich_uuid_v7(),
      "cloudLinkId" uuid NOT NULL,
      "peerInstanceId" uuid NOT NULL,
      "peerName" text NOT NULL,
      "householdName" text NOT NULL,
      "peerPublicKey" text NOT NULL,
      addresses jsonb NOT NULL DEFAULT '[]',
      state text NOT NULL DEFAULT 'active',
      "pausedReason" text,
      "connectionPath" text,
      "lastSeenAt" timestamp with time zone,
      "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
      "endedAt" timestamp with time zone,
      CONSTRAINT household_link_pkey PRIMARY KEY (id),
      CONSTRAINT "household_link_cloudLinkId_uq" UNIQUE ("cloudLinkId"),
      CONSTRAINT household_link_state_check CHECK (state = ANY (ARRAY['active'::text, 'paused'::text, 'ended'::text]))
    )
  `.execute(db);
  await sql`
    CREATE TABLE public.household_peer_request (
      jti text NOT NULL,
      "linkId" uuid NOT NULL,
      "expiresAt" timestamp with time zone NOT NULL,
      CONSTRAINT household_peer_request_pkey PRIMARY KEY (jti),
      CONSTRAINT "household_peer_request_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES public.household_link (id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX "household_peer_request_linkId_idx" ON public.household_peer_request ("linkId")`.execute(db);
  await sql`CREATE INDEX "household_peer_request_expiresAt_idx" ON public.household_peer_request ("expiresAt")`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.household_peer_request`.execute(db);
  await sql`DROP TABLE public.household_link`.execute(db);
}
