import { Kysely, sql } from 'kysely';

/**
 * FL-793: two-step sign-in. `user_two_factor` holds an account's sealed authenticator secret (on once
 * `enabledAt` is set); `user_recovery_code` its one-time recovery codes as SHA-256 hashes.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.user_two_factor (
    "userId" uuid NOT NULL,
    secret text NOT NULL,
    "enabledAt" timestamp with time zone,
    "lastUsedStep" bigint,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_two_factor_pkey PRIMARY KEY ("userId"),
    CONSTRAINT "user_two_factor_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE TABLE public.user_recovery_code (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "userId" uuid NOT NULL,
    "codeHash" bytea NOT NULL,
    "usedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_recovery_code_pkey PRIMARY KEY (id),
    CONSTRAINT "user_recovery_code_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "user_recovery_code_userId_idx" ON public.user_recovery_code USING btree ("userId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.user_recovery_code`.execute(db);
  await sql`DROP TABLE IF EXISTS public.user_two_factor`.execute(db);
}
