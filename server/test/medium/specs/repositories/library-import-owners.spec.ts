import { hash } from 'bcrypt';
import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AdminAuditAction } from 'src/enum.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { assertFreshImportDestination } from 'src/library-import/admission.js';
import { createImportedOwner } from 'src/library-import/owners.js';
import { ImportedPassword } from 'src/library-import/passwords.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
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
  await sql`TRUNCATE public."user",public.cluster_group,public.user_audit,public.album CASCADE`.execute(db);
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

it.each(['second-owner', 'orphan-group', 'existing-album', 'past-library', 'past-user', 'non-admin', 'deleted-admin'])(
  'keeps generic destination admission restricted: %s',
  async (state) => {
    const bootstrap = await db.selectFrom('user').selectAll().executeTakeFirstOrThrow();
    switch (state) {
      case 'second-owner': {
        await sql`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
          INSERT INTO public."user" (email,"clusterGroupId") SELECT 'extra@example.test',id FROM g`.execute(db);
        break;
      }
      case 'orphan-group': {
        await sql`INSERT INTO public.cluster_group DEFAULT VALUES`.execute(db);
        break;
      }
      case 'existing-album': {
        await sql`INSERT INTO public.album DEFAULT VALUES`.execute(db);
        break;
      }
      case 'past-library': {
        await db
          .insertInto('admin_audit_event')
          .values({
            userId: bootstrap.id,
            actorId: bootstrap.id,
            libraryId: null,
            action: AdminAuditAction.LibraryDeleted,
            subject: 'Previously used library',
            detail: null,
          })
          .execute();
        break;
      }
      case 'past-user': {
        await sql`INSERT INTO public.user_audit ("userId") VALUES (${randomUUID()}::uuid)`.execute(db);
        break;
      }
      case 'non-admin': {
        await sql`UPDATE public."user" SET "isAdmin"=false`.execute(db);
        break;
      }
      case 'deleted-admin': {
        await sql`UPDATE public."user" SET "deletedAt"=now()`.execute(db);
        break;
      }
      // No default
    }
    await expect(assertFreshImportDestination(wrap(db), { allowBootstrapAdmin: true })).rejects.toThrow(
      'DESTINATION_NOT_FRESH',
    );
    expect(await wrap(db).query('SELECT operation_id FROM public.frameleaf_library_import')).toEqual([]);
  },
);

it('admits an unused setup administrator and journals preserved owner credentials atomically', async () => {
  const bootstrap = await db.selectFrom('user').selectAll().executeTakeFirstOrThrow();
  await db
    .insertInto('admin_audit_event')
    .values({
      userId: bootstrap.id,
      actorId: bootstrap.id,
      libraryId: null,
      action: AdminAuditAction.AccountCreated,
      subject: 'Bootstrap administrator',
      detail: 'server-claimed:web',
    })
    .execute();
  await new SessionRepository(db).create(SessionFactory.create({ userId: bootstrap.id }));
  const owner = input();
  const binding = {
    operationId: owner.operationId,
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    source: {
      kind: 'photoview',
      version: '2.4.0',
      identity: 'synthetic-library',
      revision: 'frozen',
      schemaSha256: 'c'.repeat(64),
    },
  };
  const journal = new LibraryImportJournal(wrap(db));
  await expect(assertFreshImportDestination(wrap(db))).rejects.toThrow('DESTINATION_NOT_FRESH');
  await expect(journal.begin(binding)).resolves.toMatchObject({ status: 'copying' });
  const credential = await ImportedPassword.fromSource(
    {
      operationId: owner.operationId,
      sourceUserId: owner.sourceUserId,
      destinationUserId: owner.destinationUserId,
    },
    'bcrypt',
    await hash('synthetic preserved password', 9),
  );
  const mapping = {
    kind: 'owner',
    sourceId: owner.sourceUserId,
    destinationId: owner.destinationUserId,
    recordSha256: 'd'.repeat(64),
  };
  await journal.apply(binding, mapping, (transaction) => createImportedOwner(transaction, owner, credential));
  await expect(journal.begin(binding)).resolves.toMatchObject({ status: 'copying' });
  await expect(
    journal.apply(binding, mapping, () => {
      throw new Error('committed owner must not replay');
    }),
  ).resolves.toBe(owner.destinationUserId);
  const imported = await db
    .selectFrom('user')
    .selectAll()
    .where('id', '=', owner.destinationUserId)
    .executeTakeFirstOrThrow();
  expect(await new CryptoRepository().compareBcrypt('synthetic preserved password', imported.password!)).toBe(true);
  expect(imported).toMatchObject({ isAdmin: false, importClaimPending: false });
  expect(await db.selectFrom('user').selectAll().where('id', '=', bootstrap.id).executeTakeFirstOrThrow()).toEqual(
    bootstrap,
  );
  expect(await db.selectFrom('session').select('id').where('userId', '=', owner.destinationUserId).execute()).toEqual(
    [],
  );
});
