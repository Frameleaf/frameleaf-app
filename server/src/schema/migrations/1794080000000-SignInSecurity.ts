import { Kysely, sql } from 'kysely';

export const up = async (db: Kysely<unknown>) => {
  await sql`alter table public.frameleaf_rate_limit add column failure_times timestamptz[]`.execute(db);
  await sql`create table public.user_known_device (
    "userId" uuid not null references public."user"(id) on update cascade on delete cascade,
    "fingerprintHash" bytea not null,
    "firstSeenAt" timestamptz not null default now(),
    "lastSeenAt" timestamptz not null default now(),
    primary key ("userId", "fingerprintHash")
  )`.execute(db);
};

export const down = async (db: Kysely<unknown>) => {
  await sql`drop table public.user_known_device`.execute(db);
  await sql`alter table public.frameleaf_rate_limit drop column failure_times`.execute(db);
};
