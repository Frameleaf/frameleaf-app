import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_face" ADD "eyesOpen" real DEFAULT NULL, ADD "eyeSharpness" real DEFAULT NULL, ADD "eyeScoreVersion" smallint DEFAULT NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_face" DROP COLUMN "eyesOpen", DROP COLUMN "eyeSharpness", DROP COLUMN "eyeScoreVersion"`.execute(
    db,
  );
}
