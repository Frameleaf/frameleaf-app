import { Kysely, sql } from 'kysely';

/** FL-864, FL-941: a person's date of passing and the owner's private notes. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "person_profile" (
  "ownerId" uuid NOT NULL,
  "personId" uuid NOT NULL,
  "deathDate" date,
  "notes" text,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "person_profile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_profile_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_profile_pkey" PRIMARY KEY ("ownerId", "personId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "person_profile";`.execute(db);
}
