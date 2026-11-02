import { hash } from 'bcrypt';
import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AlbumUserRole, SharedLinkType, UserMetadataKey } from 'src/enum.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { reconcileImportedAlbums } from 'src/library-import/album-reconciliation.js';
import { CanonicalAlbumWriter } from 'src/library-import/album-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { CanonicalOwnerWriter, reconcileImportedOwners } from 'src/library-import/owner-reconciliation.js';
import { ImportedPassword } from 'src/library-import/passwords.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>, sourceHash: string;
const wrap = (connection: Kysely<any>): ImportDatabase => ({
  query: async (statement, parameters = []) =>
    (await connection.executeQuery(CompiledQuery.raw(statement, parameters))).rows as Record<string, unknown>[],
  transaction: (body) => connection.transaction().execute((tx) => body(wrap(tx))),
});
const setup = async (withAlbum = false) => {
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.files = [];
  plan.owners = ['preserved', 'claim'].map((sourceId) => ({ sourceId, destinationId: randomUUID() }));
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 2,
    source: plan.source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: plan.source.revision,
      revisionAfter: plan.source.revision,
    },
    users: plan.owners.map((owner) => ({ id: owner.sourceId, name: 'Source ' + owner.sourceId })),
    files: [],
    assets: [],
    albums: withAlbum
      ? [
          {
            id: 'album',
            ownerId: 'preserved',
            name: 'Shared album',
            assetIds: [],
            members: [{ userId: 'claim', role: 'viewer' }],
          },
        ]
      : [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
    source: plan.source,
  };
  const context = { binding, plan, manifest, destinationId: plan.destinationId };
  await new LibraryImportJournal(wrap(db)).begin(binding);
  const credential = await ImportedPassword.fromSource(
    { operationId: binding.operationId, sourceUserId: 'preserved', destinationUserId: plan.owners[0].destinationId },
    'bcrypt',
    sourceHash,
  );
  const login = {
    revision: plan.source.revision,
    snapshotSha256: 'e'.repeat(64),
    accountEnabled: true,
    passwordLoginEnabled: true,
    secondFactorRequired: false,
    externalIdentityRequired: false,
    ownedLibraryAccess: 'full',
    otherRestrictions: 'none',
  };
  const inventory = [
    {
      intent: { sourceUserId: 'preserved', email: 'Preserved@Example.TEST', login, disposition: { kind: 'preserve' } },
      credential,
    },
    {
      intent: {
        sourceUserId: 'claim',
        email: 'claim@example.test',
        login,
        disposition: { kind: 'claim', reason: 'unsupported-local-verifier', claimPermitted: true },
      },
    },
  ];
  return {
    context,
    inventory,
    credential,
    ownerId: plan.owners[0].destinationId,
    claimId: plan.owners[1].destinationId,
  };
};
const ready = async () => {
  const fixture = await setup();
  const writer = new CanonicalOwnerWriter(wrap(db), fixture.context);
  for (const item of fixture.inventory) await writer.write(item.intent, item.credential);
  await new LibraryImportJournal(wrap(db)).phase(fixture.context.binding, 'verifying');
  return fixture;
};
beforeAll(async () => {
  db = await getKyselyDB();
  sourceHash = await hash('synthetic owner password', 9);
});
beforeEach(async () => {
  await sql`TRUNCATE public.frameleaf_account_link,public.frameleaf_session,public."user",public.cluster_group,public.user_audit,public.user_preference_history,
    public.frameleaf_library_import_mapping,public.frameleaf_library_import,public.frameleaf_immich_import CASCADE`.execute(
    db,
  );
  await sql`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO public."user"(email,"clusterGroupId","isAdmin") SELECT 'bootstrap@example.test',id,true FROM g`.execute(
    db,
  );
});
afterEach(async () => {
  await sql`TRUNCATE public.frameleaf_account_link,public.frameleaf_session`.execute(db);
});
afterAll(async () => db?.destroy());

it('preserves the local password, normalized identity and explicit restricted claim without copying administration', async () => {
  const { context, inventory, ownerId, claimId, credential } = await ready();
  const owners = await db.selectFrom('user').selectAll().where('id', 'in', [ownerId, claimId]).execute();
  expect(owners.find((row) => row.id === ownerId)).toMatchObject({
    email: 'preserved@example.test',
    name: 'Source preserved',
    isAdmin: false,
    clusterGroupId: ownerId,
    importClaimPending: false,
    shouldChangePassword: false,
    password: credential.forImport(),
  });
  expect(owners.find((row) => row.id === claimId)).toMatchObject({
    email: 'claim@example.test',
    isAdmin: false,
    clusterGroupId: claimId,
    importClaimPending: true,
    shouldChangePassword: true,
    password: null,
  });
  expect(await new CryptoRepository().compareBcrypt('synthetic owner password', credential.forImport())).toBe(true);
  const first = await reconcileImportedOwners(wrap(db), context, inventory);
  expect(first).toMatchObject({
    format: 'frameleaf-owner-reconciliation',
    version: 1,
    operationId: context.binding.operationId,
    manifestSha256: context.binding.manifestSha256,
    planSha256: context.binding.planSha256,
    owners: 2,
    preservedPasswords: 1,
    claimPending: 1,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(await reconcileImportedOwners(wrap(db), context, inventory)).toEqual(first);
  expect(JSON.stringify(first)).not.toContain(credential.forImport());
  expect(JSON.stringify(first)).not.toContain(sourceHash);
});

it('replays only identical private owner intent and recovers after a lost commit acknowledgement', async () => {
  const { context, inventory, ownerId } = await setup();
  const item = inventory[0];
  const actual = wrap(db);
  const lost: ImportDatabase = {
    ...actual,
    transaction: async (body) => {
      await actual.transaction(body);
      throw new Error('lost reply');
    },
  };
  await expect(new CanonicalOwnerWriter(lost, context).write(item.intent, item.credential)).rejects.toThrow(
    'OWNER_WRITE_FAILED',
  );
  const recovered = await ImportedPassword.fromSource(
    { operationId: context.binding.operationId, sourceUserId: 'preserved', destinationUserId: ownerId },
    'bcrypt',
    sourceHash,
  );
  expect(
    await new CanonicalOwnerWriter(actual, context).write(
      { ...item.intent, email: 'preserved@example.test' },
      recovered,
    ),
  ).toBe(ownerId);
  await expect(
    new CanonicalOwnerWriter(actual, context).write({
      ...item.intent,
      disposition: { kind: 'claim', reason: 'unsupported-local-verifier', claimPermitted: true },
    }),
  ).rejects.toThrow('IMPORT_MAPPING_CHANGED');
  await expect(
    new CanonicalOwnerWriter(actual, context).write({ ...item.intent, email: 'changed@example.test' }, item.credential),
  ).rejects.toThrow('IMPORT_MAPPING_CHANGED');
  const changed = await ImportedPassword.fromSource(
    { operationId: context.binding.operationId, sourceUserId: 'preserved', destinationUserId: ownerId },
    'bcrypt',
    await hash('other synthetic password', 9),
  );
  await expect(new CanonicalOwnerWriter(actual, context).write(item.intent, changed)).rejects.toThrow(
    'IMPORT_MAPPING_CHANGED',
  );
  expect(await db.selectFrom('user').select('id').execute()).toHaveLength(2);
});

it('never silently substitutes a claim for a missing or wrong-owner portable credential', async () => {
  const { context, inventory, credential } = await setup();
  const writer = new CanonicalOwnerWriter(wrap(db), context);
  await expect(writer.write(inventory[0].intent)).rejects.toThrow('OWNER_CREDENTIAL_DISPOSITION_MISMATCH');
  await expect(writer.write(inventory[1].intent, credential)).rejects.toThrow('OWNER_CREDENTIAL_DISPOSITION_MISMATCH');
  const wrong = await ImportedPassword.fromSource(
    { operationId: randomUUID(), sourceUserId: 'preserved', destinationUserId: context.plan.owners[0].destinationId },
    'bcrypt',
    sourceHash,
  );
  await expect(writer.write(inventory[0].intent, wrong)).rejects.toThrow('OWNER_CREDENTIAL_MISMATCH');
  expect(await db.selectFrom('user').select('id').execute()).toHaveLength(1);
});

it.each([
  { accountEnabled: false },
  { passwordLoginEnabled: false },
  { secondFactorRequired: true },
  { externalIdentityRequired: true },
  { ownedLibraryAccess: 'restricted' },
  { otherRestrictions: 'password-change-required' },
  { otherRestrictions: undefined },
  { secondFactorRequired: undefined },
])('refuses unqualified or non-equivalent source restrictions: %j', async (change) => {
  const { context, inventory } = await setup();
  const item = inventory[0];
  await expect(
    new CanonicalOwnerWriter(wrap(db), context).write(
      { ...item.intent, login: { ...item.intent.login, ...change } },
      item.credential,
    ),
  ).rejects.toThrow('OWNER_INTENT_INVALID');
  expect(await db.selectFrom('user').select('id').execute()).toHaveLength(1);
});

it('refuses collisions and interrupted account writes without leaving a partial group or mapping', async () => {
  const { context, inventory } = await setup();
  const item = inventory[0];
  await expect(
    new CanonicalOwnerWriter(wrap(db), context).write(
      { ...item.intent, email: 'BOOTSTRAP@example.test' },
      item.credential,
    ),
  ).rejects.toThrow('OWNER_EMAIL_COLLISION');
  const actual = wrap(db);
  const fault = (tx: ImportDatabase): ImportDatabase => ({
    ...tx,
    query: (statement, parameters) =>
      statement.includes('INSERT INTO public.frameleaf_library_import_mapping')
        ? Promise.reject(new Error('fault after user write'))
        : tx.query(statement, parameters),
    transaction: (body) => tx.transaction((nested) => body(fault(nested))),
  });
  await expect(new CanonicalOwnerWriter(fault(actual), context).write(item.intent, item.credential)).rejects.toThrow(
    'OWNER_WRITE_FAILED',
  );
  expect(await db.selectFrom('user').select('id').execute()).toHaveLength(1);
  expect(await db.selectFrom('cluster_group').select('id').execute()).toHaveLength(1);
  expect((await new LibraryImportJournal(wrap(db)).status()).mappings).toEqual([]);
});

it.each([
  'email',
  'name',
  'password',
  'claim',
  'admin',
  'group',
  'oauth',
  'pin',
  'password-link',
  'session',
  'api-key',
  'metadata',
  'identity-link',
  'bootstrap-identity-link',
  'orphan-identity-link',
  'shared-link',
  'partner-outgoing',
  'partner-incoming',
  'mapping',
  'extra-owner',
])('refuses independently observed owner corruption: %s', async (kind) => {
  const { context, inventory, ownerId, claimId } = await ready();
  switch (kind) {
    case 'email': {
      await db.updateTable('user').set({ email: 'changed@example.test' }).where('id', '=', ownerId).execute();
      break;
    }
    case 'name': {
      await db.updateTable('user').set({ name: 'changed' }).where('id', '=', ownerId).execute();
      break;
    }
    case 'password': {
      await db.updateTable('user').set({ password: null }).where('id', '=', ownerId).execute();
      break;
    }
    case 'claim': {
      await db.updateTable('user').set({ importClaimPending: false }).where('id', '=', claimId).execute();
      break;
    }
    case 'admin': {
      await db.updateTable('user').set({ isAdmin: true }).where('id', '=', ownerId).execute();
      break;
    }
    case 'group': {
      await db.updateTable('user').set({ clusterGroupId: claimId }).where('id', '=', ownerId).execute();
      break;
    }
    case 'oauth': {
      await db.updateTable('user').set({ oauthId: 'unexpected' }).where('id', '=', ownerId).execute();
      break;
    }
    case 'pin': {
      await db.updateTable('user').set({ pinCode: 'unexpected' }).where('id', '=', ownerId).execute();
      break;
    }
    case 'password-link': {
      await db
        .updateTable('user')
        .set({ passwordLinkHash: Buffer.alloc(32, 1) })
        .where('id', '=', ownerId)
        .execute();
      break;
    }
    case 'session': {
      await db
        .insertInto('session')
        .values({ userId: ownerId, token: Buffer.alloc(32, 1) })
        .execute();
      break;
    }
    case 'api-key': {
      await db
        .insertInto('api_key')
        .values({ userId: ownerId, name: 'unexpected', key: Buffer.alloc(32, 1), permissions: [] })
        .execute();
      break;
    }
    case 'metadata': {
      await sql`INSERT INTO user_metadata("userId",key,value) VALUES(${ownerId}::uuid,${UserMetadataKey.Preferences},'{}'::jsonb)`.execute(
        db,
      );
      break;
    }
    case 'bootstrap-identity-link':
    case 'orphan-identity-link':
    case 'identity-link': {
      await new FrameleafAccountRepository(db).upsertLink({
        userId:
          kind === 'identity-link'
            ? ownerId
            : kind === 'bootstrap-identity-link'
              ? (await db.selectFrom('user').select('id').where('isAdmin', '=', true).executeTakeFirstOrThrow()).id
              : randomUUID(),
        sub: randomUUID(),
        email: 'unexpected@example.test',
        emailVerified: true,
        role: 'user',
        autoRegistered: false,
      });
      break;
    }
    case 'shared-link': {
      await db
        .insertInto('shared_link')
        .values({
          userId: ownerId,
          key: Buffer.alloc(32, 1),
          type: SharedLinkType.Individual,
          allowUpload: false,
        })
        .execute();
      break;
    }
    case 'partner-outgoing':
    case 'partner-incoming': {
      const administrator = await db
        .selectFrom('user')
        .select('id')
        .where('isAdmin', '=', true)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('partner')
        .values({
          sharedById: kind === 'partner-outgoing' ? ownerId : administrator.id,
          sharedWithId: kind === 'partner-outgoing' ? administrator.id : ownerId,
        })
        .execute();
      break;
    }
    case 'mapping': {
      await sql`UPDATE frameleaf_library_import_mapping SET record_sha256=${'f'.repeat(64)} WHERE source_id='preserved'`.execute(
        db,
      );
      break;
    }
    case 'extra-owner': {
      await sql`WITH g AS (INSERT INTO cluster_group DEFAULT VALUES RETURNING id)
        INSERT INTO public."user"(email,"clusterGroupId") SELECT 'extra@example.test',id FROM g`.execute(db);
      break;
    }
  }
  await expect(reconcileImportedOwners(wrap(db), context, inventory)).rejects.toThrow('OWNER_RECONCILIATION_MISMATCH');
});

it('requires the verifying phase, full binding and complete private owner inventory', async () => {
  const { context, inventory } = await setup();
  await expect(reconcileImportedOwners(wrap(db), context, inventory)).rejects.toThrow('IMPORT_NOT_VERIFYING');
  const writer = new CanonicalOwnerWriter(wrap(db), context);
  for (const item of inventory) await writer.write(item.intent, item.credential);
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  await expect(reconcileImportedOwners(wrap(db), context, [])).rejects.toThrow('OWNER_RECONCILIATION_MISMATCH');
  await expect(reconcileImportedOwners(wrap(db), context, [inventory[0], inventory[0]])).rejects.toThrow(
    'OWNER_RECONCILIATION_MISMATCH',
  );
  const operationId = randomUUID();
  const credential = await ImportedPassword.fromSource(
    { operationId, sourceUserId: 'preserved', destinationUserId: context.plan.owners[0].destinationId },
    'bcrypt',
    sourceHash,
  );
  await expect(
    reconcileImportedOwners(wrap(db), { ...context, binding: { ...context.binding, operationId } }, [
      { ...inventory[0], credential },
      inventory[1],
    ]),
  ).rejects.toThrow('IMPORT_BINDING_CHANGED');
  await expect(reconcileImportedOwners(wrap(db), context, [null, null])).rejects.toThrow(
    'OWNER_RECONCILIATION_MISMATCH',
  );
});

it('retains a bootstrap administrator session while excluding imported-owner authentication artifacts', async () => {
  const administrator = await db.selectFrom('user').select('id').where('isAdmin', '=', true).executeTakeFirstOrThrow();
  await db
    .insertInto('session')
    .values({ userId: administrator.id, token: Buffer.alloc(32, 7) })
    .execute();
  const { context, inventory } = await ready();
  expect(await reconcileImportedOwners(wrap(db), context, inventory)).toMatchObject({
    owners: 2,
    preservedPasswords: 1,
    claimPending: 1,
  });
  expect(await db.selectFrom('session').select('userId').execute()).toEqual([{ userId: administrator.id }]);
});

it('retains imported album grants while independently refusing changed permissions', async () => {
  const { context, inventory, claimId } = await setup(true);
  const writer = new CanonicalOwnerWriter(wrap(db), context);
  for (const item of inventory) await writer.write(item.intent, item.credential);
  const albumId = await new CanonicalAlbumWriter(wrap(db), context).write('album');
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  expect(await reconcileImportedOwners(wrap(db), context, inventory)).toMatchObject({ owners: 2 });
  expect(await reconcileImportedAlbums(wrap(db), context)).toMatchObject({ albums: 1, grants: 2 });
  await db
    .updateTable('album_user')
    .set({ role: AlbumUserRole.Editor })
    .where('albumId', '=', albumId)
    .where('userId', '=', claimId)
    .execute();
  await expect(reconcileImportedAlbums(wrap(db), context)).rejects.toThrow('ALBUM_RECONCILIATION_MISMATCH');
});

it('refuses verification when abandonment commits across snapshot and advisory acquisition', async () => {
  const { context, inventory } = await ready();
  const { promise: release, resolve: releaseCommit } = Promise.withResolvers<void>();
  const { promise: announced, resolve: announce } = Promise.withResolvers<void>();
  const committed = db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(${LIBRARY_IMPORT_LOCK}::bigint)`.execute(tx);
    await sql`UPDATE frameleaf_library_import SET status='abandoned'`.execute(tx);
    announce();
    await release;
  });
  await announced;
  const actual = wrap(db);
  const raced: ImportDatabase = {
    ...actual,
    transaction: (body) =>
      actual.transaction((tx) =>
        body({
          ...tx,
          query: async (statement, parameters) => {
            if (statement.startsWith('SELECT pg_try_advisory_xact_lock')) {
              // Freeze the same snapshot the advisory SELECT takes before evaluating its lock function.
              await tx.query('SELECT 1');
              releaseCommit();
              await committed;
            }
            return tx.query(statement, parameters);
          },
        }),
      ),
  };
  try {
    await expect(reconcileImportedOwners(raced, context, inventory)).rejects.toThrow(
      /IMPORT_ALREADY_RUNNING|IMPORT_NOT_VERIFYING/,
    );
  } finally {
    releaseCommit();
    await committed;
  }
});
