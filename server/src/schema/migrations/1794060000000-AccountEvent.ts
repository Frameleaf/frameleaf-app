import { Kysely, sql } from 'kysely';

/** FL-808 (E16-02): the account activity log. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.account_event (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "userId" uuid NOT NULL,
    "sessionId" uuid,
    action character varying NOT NULL,
    subject character varying NOT NULL,
    detail character varying,
    "ipPrefix" character varying,
    "deviceType" character varying,
    "deviceOS" character varying,
    via character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_event_pkey PRIMARY KEY (id),
    CONSTRAINT "account_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "account_event_userId_createdAt_idx" ON public.account_event USING btree ("userId", "createdAt")`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.account_event`.execute(db);
}
