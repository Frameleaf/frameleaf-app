import { hash } from 'bcrypt';
import { Kysely, sql } from 'kysely';

/**
 * Shared-link passwords are stored as bcrypt hashes (FL-161).
 *
 * Passwords used to be saved as they were typed, so anyone who could read the database or a backup
 * of it could open every protected link. Each plaintext password is replaced by its bcrypt hash (cost
 * 10, like account passwords); the link keeps its password, so every existing link still opens with
 * the same one. An empty password, which never protected a link, becomes NULL. A value that is already
 * a bcrypt hash is left alone, so running this again changes nothing, and a row changed while this
 * runs is skipped rather than overwritten (the service hashes a leftover plaintext password on its
 * first correct use).
 *
 * `down` leaves the hashes in place: a hash cannot be turned back into the password, and the service
 * of every version since this one reads both forms.
 */
const SALT_ROUNDS = 10;

export async function up(db: Kysely<any>): Promise<void> {
  await sql`UPDATE "shared_link" SET "password" = NULL WHERE "password" = ''`.execute(db);

  const { rows } = await sql<{ id: string; password: string }>`
    SELECT "id", "password" FROM "shared_link"
    WHERE "password" IS NOT NULL AND "password" !~ '^\\$2[aby]\\$[0-9]{2}\\$[./A-Za-z0-9]{53}$'
  `.execute(db);

  for (const { id, password } of rows) {
    const hashed = await hash(password, SALT_ROUNDS);
    await sql`UPDATE "shared_link" SET "password" = ${hashed} WHERE "id" = ${id} AND "password" = ${password}`.execute(
      db,
    );
  }
}

export function down(): Promise<void> {
  // nothing to undo: see above
  return Promise.resolve();
}
