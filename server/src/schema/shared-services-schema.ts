import { type Kysely, sql } from 'kysely';

/** Called by the canonical baseline only. Shared-service startup never changes the schema. */
export async function createSharedServicesSchema(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.frameleaf_rate_limit (
    key text PRIMARY KEY, count integer NOT NULL CHECK (count >= 0), expires_at timestamptz NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX frameleaf_rate_limit_expiry ON public.frameleaf_rate_limit (expires_at)`.execute(db);
  await sql`CREATE TABLE public.frameleaf_upload_lease (
    key text PRIMARY KEY, token text NOT NULL, expires_at timestamptz NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX frameleaf_upload_lease_expiry ON public.frameleaf_upload_lease (expires_at)`.execute(db);
  await sql`CREATE TABLE public.socket_io_attachments (
    id bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), payload bytea NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX socket_io_attachments_expiry ON public.socket_io_attachments (created_at)`.execute(db);
  await sql`CREATE TABLE public.frameleaf_websocket_worker (
    id uuid PRIMARY KEY, expires_at timestamptz NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX frameleaf_websocket_worker_expiry ON public.frameleaf_websocket_worker (expires_at)`.execute(
    db,
  );
}
