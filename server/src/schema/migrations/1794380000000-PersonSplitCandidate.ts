import { Kysely, sql } from 'kysely';

/** FL-1385: people who may hold the faces of two different people, worked out overnight. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "person_split_candidate" (
  "ownerId" uuid NOT NULL,
  "personId" uuid NOT NULL,
  "faceIds" uuid[] NOT NULL,
  "distance" real NOT NULL,
  "dismissedUntil" timestamp with time zone,
  CONSTRAINT "person_split_candidate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_split_candidate_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_split_candidate_pkey" PRIMARY KEY ("ownerId", "personId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "person_split_candidate";`.execute(db);
}
