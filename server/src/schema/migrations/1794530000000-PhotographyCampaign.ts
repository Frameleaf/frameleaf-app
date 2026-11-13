import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE photography_contact (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    email text NOT NULL, name text NOT NULL, source text NOT NULL,
    "unsubscribeToken" text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
    "unsubscribedAt" timestamptz, UNIQUE ("ownerId", email)
  )`.execute(db);
  await sql`CREATE TABLE photography_campaign (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name text NOT NULL, "templateKey" text NOT NULL, subject text NOT NULL, body text NOT NULL,
    audience jsonb NOT NULL, revision uuid NOT NULL DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'draft', "scheduledFor" timestamptz,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "lastTestAt" timestamptz, "pausedUntil" timestamptz
  )`.execute(db);
  await sql`CREATE TABLE photography_campaign_delivery (
    "campaignId" uuid NOT NULL REFERENCES photography_campaign(id) ON DELETE CASCADE,
    "contactId" uuid NOT NULL REFERENCES photography_contact(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending', "attemptedAt" timestamptz,
    PRIMARY KEY ("campaignId", "contactId")
  )`.execute(db);
  await sql`CREATE INDEX photography_campaign_owner_idx ON photography_campaign ("ownerId","createdAt" DESC)`.execute(db);
  await sql`CREATE INDEX photography_campaign_due_idx ON photography_campaign ("scheduledFor") WHERE status = 'scheduled'`.execute(db);
  await sql`CREATE INDEX photography_campaign_attempt_idx ON photography_campaign_delivery ("attemptedAt" DESC) WHERE "attemptedAt" IS NOT NULL`.execute(db);
  await sql`INSERT INTO photography_contact ("ownerId", email, name, source)
    SELECT DISTINCT ON (w."ownerId", lower(trim(r->>'email'))) w."ownerId", lower(trim(r->>'email')), coalesce(r->>'name',''), 'clients'
    FROM photography_workflow w CROSS JOIN LATERAL jsonb_array_elements(coalesce(w.value->'recipients','[]')) r
    WHERE coalesce(r->>'email','') ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    ON CONFLICT ("ownerId", email) DO NOTHING`.execute(db);
  await sql`INSERT INTO photography_contact ("ownerId", email, name, source)
    SELECT DISTINCT ON (s."ownerId", lower(trim(i->>'email'))) s."ownerId", lower(trim(i->>'email')), coalesce(i->>'name',''), 'leads'
    FROM photography_studio_site s CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.value->'inquiries','[]')) i
    WHERE coalesce(i->>'email','') ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    ON CONFLICT ("ownerId", email) DO NOTHING`.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE photography_campaign_delivery, photography_campaign, photography_contact`.execute(db);
}
