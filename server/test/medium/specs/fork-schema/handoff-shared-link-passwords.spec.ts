import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { ForkHandoffService } from 'src/services/fork-handoff.service.js';
import { ForkSchemaMigrationService } from 'src/services/fork-schema-migration.service.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-161: shared-link passwords are bcrypt hashes the official server cannot check, so every
 * password-protected link stays locked there. The official handoff counts them on real PostgreSQL and
 * refuses to go ahead until the operator acknowledged it.
 */
describe('official handoff: password-protected shared links (FL-161)', () => {
  let db: Kysely<DB>;
  let repository: DatabaseRepository;
  let ownerId: string;

  beforeAll(async () => {
    db = await getKyselyDB();
    const user = await mediumFactory.userWithClusterGroup(db);
    await db.insertInto('user').values(user).execute();
    ownerId = user.id;
    repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM public.shared_link`.execute(db);
  });

  const seedLink = async (password: string | null) => {
    await sql`
      INSERT INTO public.shared_link (id, "userId", key, type, password)
      VALUES (${randomUUID()}::uuid, ${ownerId}::uuid, ${randomBytes(50)}, 'INDIVIDUAL', ${password})
    `.execute(db);
  };

  it('counts every link with a password, hashed or not, and none without', async () => {
    await expect(repository.countPasswordProtectedSharedLinks()).resolves.toBe(0);

    await seedLink(`$2b$10$${'a'.repeat(53)}`);
    await seedLink('left-in-plaintext');
    await seedLink(null);
    await seedLink('');

    await expect(repository.countPasswordProtectedSharedLinks()).resolves.toBe(2);
  });

  it('refuses the handoff preflight until the locked links are acknowledged', async () => {
    const service = new ForkHandoffService(repository, {} as ForkSchemaMigrationService);
    await expect(service.sharedLinkPasswordPreflight()).resolves.toEqual({ passwordProtectedLinks: 0 });

    await seedLink(`$2b$10$${'b'.repeat(53)}`);

    await expect(service.sharedLinkPasswordPreflight()).rejects.toThrow(
      '1 password-protected shared link(s) will stay locked on the official server',
    );
    await expect(service.sharedLinkPasswordPreflight({ acknowledgeSharedLinkPasswords: true })).resolves.toEqual({
      passwordProtectedLinks: 1,
    });
  });
});
