import { Kysely, sql } from 'kysely';

/**
 * FL-842: how an owner's people are related (parent, partner, sibling). One row per pair: a parent row names the
 * parent first, partners and siblings are stored smaller id first. Rows go with either person, and so with the
 * account, when they are deleted.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "person_relationship" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "ownerId" uuid NOT NULL,
  "personGroupId" uuid NOT NULL,
  "relatedPersonGroupId" uuid NOT NULL,
  "kind" text NOT NULL,
  "parentRole" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "person_relationship_ownerId_personGroupId_fkey" FOREIGN KEY ("ownerId", "personGroupId") REFERENCES "person" ("ownerId", "personGroupId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_relationship_ownerId_relatedPersonGroupId_fkey" FOREIGN KEY ("ownerId", "relatedPersonGroupId") REFERENCES "person" ("ownerId", "personGroupId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_relationship_kind_chk" CHECK ("kind" IN ('parent', 'partner', 'sibling')),
  CONSTRAINT "person_relationship_not_self_chk" CHECK ("personGroupId" <> "relatedPersonGroupId"),
  CONSTRAINT "person_relationship_parentRole_chk" CHECK (("kind" = 'parent' AND "parentRole" IN ('mother', 'father', 'parent')) OR ("kind" <> 'parent' AND "parentRole" IS NULL)),
  CONSTRAINT "person_relationship_order_chk" CHECK ("kind" = 'parent' OR "personGroupId" < "relatedPersonGroupId"),
  CONSTRAINT "person_relationship_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE UNIQUE INDEX "person_relationship_pair_uq" ON "person_relationship" ("ownerId", LEAST("personGroupId", "relatedPersonGroupId"), GREATEST("personGroupId", "relatedPersonGroupId"));`.execute(
    db,
  );
  await sql`CREATE INDEX "person_relationship_ownerId_relatedPersonGroupId_idx" ON "person_relationship" ("ownerId", "relatedPersonGroupId");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "person_relationship";`.execute(db);
}
