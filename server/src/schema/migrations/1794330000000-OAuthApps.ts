import { Kysely, sql } from 'kysely';

/** FL-803 (E3-03): connected apps through OAuth 2.1 (clients, grants, single-use codes, spent refresh tokens). */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.oauth_client (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    "redirectUris" character varying[] NOT NULL,
    "logoUri" character varying,
    dynamic boolean DEFAULT true NOT NULL,
    "createdById" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_client_pkey PRIMARY KEY (id),
    CONSTRAINT "oauth_client_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL
  )`.execute(db);
  await sql`CREATE INDEX "oauth_client_createdById_idx" ON public.oauth_client USING btree ("createdById")`.execute(db);

  await sql`CREATE TABLE public.oauth_grant (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "userId" uuid NOT NULL,
    "clientId" uuid NOT NULL,
    scopes character varying[] NOT NULL,
    resource character varying,
    "refreshTokenHash" bytea NOT NULL,
    "accessTokenHash" bytea NOT NULL,
    "accessExpiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "lastUsedAt" timestamp with time zone,
    "lastUsedVia" character varying,
    "revokedAt" timestamp with time zone,
    CONSTRAINT oauth_grant_pkey PRIMARY KEY (id),
    CONSTRAINT "oauth_grant_refreshTokenHash_uq" UNIQUE ("refreshTokenHash"),
    CONSTRAINT "oauth_grant_accessTokenHash_uq" UNIQUE ("accessTokenHash"),
    CONSTRAINT "oauth_grant_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "oauth_grant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public.oauth_client(id) ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "oauth_grant_clientId_idx" ON public.oauth_grant USING btree ("clientId")`.execute(db);
  await sql`CREATE INDEX "oauth_grant_userId_revokedAt_idx" ON public.oauth_grant USING btree ("userId", "revokedAt")`.execute(
    db,
  );

  await sql`CREATE TABLE public.oauth_authorization_code (
    "codeHash" bytea NOT NULL,
    "clientId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "sessionId" uuid NOT NULL,
    "redirectUri" character varying NOT NULL,
    "codeChallenge" character varying NOT NULL,
    scopes character varying[] NOT NULL,
    resource character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    CONSTRAINT oauth_authorization_code_pkey PRIMARY KEY ("codeHash"),
    CONSTRAINT oauth_authorization_code_hash_check CHECK ((octet_length("codeHash") = 32)),
    CONSTRAINT "oauth_authorization_code_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public.oauth_client(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "oauth_authorization_code_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "oauth_authorization_code_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.session(id) ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "oauth_authorization_code_clientId_idx" ON public.oauth_authorization_code USING btree ("clientId")`.execute(
    db,
  );
  await sql`CREATE INDEX "oauth_authorization_code_userId_idx" ON public.oauth_authorization_code USING btree ("userId")`.execute(
    db,
  );
  await sql`CREATE INDEX "oauth_authorization_code_sessionId_idx" ON public.oauth_authorization_code USING btree ("sessionId")`.execute(
    db,
  );
  await sql`CREATE INDEX "oauth_authorization_code_expiresAt_idx" ON public.oauth_authorization_code USING btree ("expiresAt")`.execute(
    db,
  );

  await sql`CREATE TABLE public.oauth_spent_refresh_token (
    "tokenHash" bytea NOT NULL,
    "grantId" uuid NOT NULL,
    "spentAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_spent_refresh_token_pkey PRIMARY KEY ("tokenHash"),
    CONSTRAINT "oauth_spent_refresh_token_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES public.oauth_grant(id) ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "oauth_spent_refresh_token_grantId_idx" ON public.oauth_spent_refresh_token USING btree ("grantId")`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.oauth_spent_refresh_token`.execute(db);
  await sql`DROP TABLE IF EXISTS public.oauth_authorization_code`.execute(db);
  await sql`DROP TABLE IF EXISTS public.oauth_grant`.execute(db);
  await sql`DROP TABLE IF EXISTS public.oauth_client`.execute(db);
}
