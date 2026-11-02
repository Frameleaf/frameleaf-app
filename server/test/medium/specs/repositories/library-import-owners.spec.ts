import { hash } from 'bcrypt';
import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ImportDatabase } from 'src/immich-import/types.js';
import { createImportedOwner } from 'src/library-import/owners.js';
import { ImportedPassword } from 'src/library-import/passwords.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { DB } from 'src/schema/index.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const wrap = (connection: Kysely<any>): ImportDatabase => ({
  query: async (statement, parameters = []) =>
    (await connection.executeQuery(CompiledQuery.raw(statement, parameters))).rows as Record<string, unknown>[],
  transaction: (body) => connection.transaction().execute((tx) => body(wrap(tx))),
});
const input = () => ({
  operationId: randomUUID(),
  sourceUserId: 'source-owner',
  destinationUserId: randomUUID(),
  name: 'Synthetic owner',
  email: `${randomUUID()}@example.test`,
});
beforeAll(async () => {
  db = await getKyselyDB();
});
beforeEach(async () => {
  await sql`TRUNCATE public."user",public.cluster_group CASCADE`.execute(db);
  await sql`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO public."user" (email,"clusterGroupId","isAdmin") SELECT 'bootstrap@example.test',id,true FROM g`.execute(
    db,
  );
});
afterAll(async () => db?.destroy());

it('creates a mapped owner with the preserved password, permits new sessions and grants no source administration', async () => {
  const owner = input();
  const credential = await ImportedPassword.fromSource(
    { operationId: owner.operationId, sourceUserId: owner.sourceUserId, destinationUserId: owner.destinationUserId },
    'bcrypt',
    await hash('synthetic password', 9),
  );
  await createImportedOwner(wrap(db), owner, credential);
  const row = await db
    .selectFrom('user')
    .selectAll()
    .where('id', '=', owner.destinationUserId)
    .executeTakeFirstOrThrow();
  expect(row).toMatchObject({
    password: credential.forImport(),
    importClaimPending: false,
    shouldChangePassword: false,
    isAdmin: false,
    oauthId: null,
    pinCode: null,
    passwordLinkHash: null,
  });
  expect(await new CryptoRepository().compareBcrypt('synthetic password', row.password!)).toBe(true);
  const session = SessionFactory.create({ userId: row.id });
  await new SessionRepository(db).create(session, row.password!);
  expect(await new SessionRepository(db).getByToken(session.token)).toMatchObject({ user: { id: row.id } });
});

it('uses secure claims only when no portable password is supplied', async () => {
  const owner = input();
  await createImportedOwner(wrap(db), owner);
  const row = await db
    .selectFrom('user')
    .selectAll()
    .where('id', '=', owner.destinationUserId)
    .executeTakeFirstOrThrow();
  expect(row).toMatchObject({ password: null, importClaimPending: true, isAdmin: false });
  const sessions = new SessionRepository(db);
  const session = SessionFactory.create({ userId: row.id });
  await sessions.create(session);
  expect(await sessions.getByToken(session.token)).toMatchObject({ user: null });
});

it('rejects email collisions and cross-owner credentials without leaving partial accounts or groups', async () => {
  const owner = input();
  const credential = await ImportedPassword.fromSource(
    { operationId: owner.operationId, sourceUserId: owner.sourceUserId, destinationUserId: owner.destinationUserId },
    'bcrypt',
    await hash('synthetic password', 9),
  );
  await expect(
    createImportedOwner(wrap(db), { ...owner, destinationUserId: randomUUID() }, credential),
  ).rejects.toThrow('OWNER_CREDENTIAL_MISMATCH');
  await expect(
    createImportedOwner(wrap(db), { ...owner, email: 'bootstrap@example.test' }, credential),
  ).rejects.toThrow('OWNER_WRITE_FAILED');
  expect(await db.selectFrom('user').select('id').execute()).toHaveLength(1);
  expect(await db.selectFrom('cluster_group').select('id').execute()).toHaveLength(1);
});

it('requires an existing destination administrator', async () => {
  await db.deleteFrom('user').execute();
  await expect(createImportedOwner(wrap(db), input())).rejects.toThrow('DESTINATION_ADMIN_REQUIRED');
  expect(await db.selectFrom('user').select('id').execute()).toHaveLength(0);
  expect(await db.selectFrom('cluster_group').select('id').execute()).toHaveLength(1);
});
