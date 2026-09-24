import { Kysely, sql } from 'kysely';

/**
 * Merge-suggestion verdicts (FL-57). When an owner reviews a suggested pair of people and answers
 * "different people" or "decide later", the answer is kept here so the pair is not suggested again:
 * `different` hides the pair for good, `later` for 30 days. Deleting the row is the undo.
 *
 * The pair is stored in one order (`personId` < `suggestionId`, the order the suggestion query
 * produces), so each unordered pair has a single row per owner. Person ids are person group ids.
 * Fork-owned, so it does not foreign-key into the official schema.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.person_merge_verdict (
      "ownerId" uuid NOT NULL,
      "personId" uuid NOT NULL,
      "suggestionId" uuid NOT NULL,
      verdict text NOT NULL CHECK (verdict = ANY (ARRAY['different'::text, 'later'::text])),
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY ("ownerId", "personId", "suggestionId"),
      CHECK ("personId" < "suggestionId")
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.person_merge_verdict`.execute(db);
}
