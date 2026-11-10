import { Kysely, sql } from 'kysely';

/** FL-1384: pairs of people that may be the same person, worked out overnight. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "person_merge_candidate" (
  "ownerId" uuid NOT NULL,
  "personId" uuid NOT NULL,
  "suggestionId" uuid NOT NULL,
  "distance" real NOT NULL,
  CONSTRAINT "person_merge_candidate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_merge_candidate_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_merge_candidate_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_merge_candidate_pkey" PRIMARY KEY ("ownerId", "personId", "suggestionId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "person_merge_candidate";`.execute(db);
}
