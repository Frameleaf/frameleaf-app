import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE asset_landmark
    ADD COLUMN inference character varying,
    ADD COLUMN "sourceAssetIds" uuid[],
    ADD CONSTRAINT asset_landmark_inference_check CHECK (
      ((inference IS NULL AND "sourceAssetIds" IS NULL) OR
      (inference = 'temporal' AND cardinality("sourceAssetIds") = 1) OR
      (inference = 'visual' AND cardinality("sourceAssetIds") BETWEEN 2 AND 3)) IS TRUE
    )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM asset_landmark WHERE inference IS NOT NULL`.execute(db);
  await sql`ALTER TABLE asset_landmark DROP COLUMN inference, DROP COLUMN "sourceAssetIds"`.execute(db);
}
