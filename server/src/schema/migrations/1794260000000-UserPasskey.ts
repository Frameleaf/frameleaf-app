import { Kysely, sql } from 'kysely';

/**
 * FL-836: passkeys for local accounts. `user_passkey` holds each passkey's public key and sign-in
 * count, `auth_challenge` the short-lived ceremony challenges and password checks, and
 * `session_passkey` the sessions a passkey started.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.user_passkey (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "userId" uuid NOT NULL,
    "credentialId" bytea NOT NULL,
    "publicKey" bytea NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    transports text[] DEFAULT '{}' NOT NULL,
    name text NOT NULL,
    "rpId" text NOT NULL,
    aaguid uuid,
    "backedUp" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "lastUsedAt" timestamp with time zone,
    CONSTRAINT user_passkey_pkey PRIMARY KEY (id),
    CONSTRAINT "user_passkey_credentialId_uq" UNIQUE ("credentialId"),
    CONSTRAINT "user_passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "user_passkey_userId_idx" ON public.user_passkey USING btree ("userId")`.execute(db);

  await sql`CREATE TABLE public.auth_challenge (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    purpose text NOT NULL,
    challenge text NOT NULL,
    "userId" uuid,
    "sessionId" uuid,
    origin text,
    "rpId" text,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_challenge_pkey PRIMARY KEY (id),
    CONSTRAINT auth_challenge_challenge_uq UNIQUE (challenge),
    CONSTRAINT "auth_challenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "auth_challenge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.session(id) ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "auth_challenge_sessionId_idx" ON public.auth_challenge USING btree ("sessionId")`.execute(db);
  await sql`CREATE INDEX "auth_challenge_expiresAt_idx" ON public.auth_challenge USING btree ("expiresAt")`.execute(db);

  await sql`CREATE TABLE public.session_passkey (
    "sessionId" uuid NOT NULL,
    "passkeyId" uuid NOT NULL,
    CONSTRAINT session_passkey_pkey PRIMARY KEY ("sessionId"),
    CONSTRAINT "session_passkey_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.session(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "session_passkey_passkeyId_fkey" FOREIGN KEY ("passkeyId") REFERENCES public.user_passkey(id) ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "session_passkey_passkeyId_idx" ON public.session_passkey USING btree ("passkeyId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.session_passkey`.execute(db);
  await sql`DROP TABLE IF EXISTS public.auth_challenge`.execute(db);
  await sql`DROP TABLE IF EXISTS public.user_passkey`.execute(db);
}
