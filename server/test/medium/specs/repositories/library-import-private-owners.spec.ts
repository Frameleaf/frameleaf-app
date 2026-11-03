import { hash } from 'bcrypt';
import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ImportDatabase } from 'src/immich-import/types.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { CanonicalOwnerWriter, reconcileImportedOwners } from 'src/library-import/owner-reconciliation.js';
import { ImportedPassword, verifyImportedPassword } from 'src/library-import/passwords.js';
import { loadPrivateOwnerInputs, retainPrivateOwnerInputs } from 'src/library-import/private-owners.js';
import { loadReviewedImportInputs, retainReviewedImportInputs } from 'src/library-import/reviewed-inputs.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/2100000003046-LibraryImportPrivateOwners.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>, sourceHash: string;
const password = 'Synthetic retained owner password';
const wrap = (connection: Kysely<any>): ImportDatabase => ({
  query: async (statement, parameters = []) =>
    (await connection.executeQuery(CompiledQuery.raw(statement, parameters))).rows as Record<string, unknown>[],
  transaction: (body) => connection.transaction().execute((tx) => body(wrap(tx))),
});
const setup = async () => {
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.files = [];
  plan.owners = ['preserved', 'claim'].map((sourceId) => ({ sourceId, destinationId: randomUUID() }));
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 3,
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
    albums: [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    source: plan.source,
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
  };
  const context = { binding, destinationId: plan.destinationId };
  await new LibraryImportJournal(wrap(db)).begin(binding);
  await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
  const credential = await ImportedPassword.fromSource(
    {
      operationId: binding.operationId,
      sourceUserId: 'preserved',
      destinationUserId: plan.owners[0].destinationId,
    },
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
        disposition: { kind: 'claim', reason: 'no-local-verifier', claimPermitted: true },
      },
    },
  ];
  return { context, inventory, manifest, plan };
};
beforeAll(async () => {
  db = await getKyselyDB();
  sourceHash = await hash(password, 4);
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
afterAll(async () => db?.destroy());

it('restores reviewed accounts and protected passwords after reconnect without retaining the weak source verifier', async () => {
  const { context, inventory, plan } = await setup();
  await retainPrivateOwnerInputs(wrap(db), context, inventory);
  const [{ name }] = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows;
  await db.destroy();
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/${name}`;
  db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.href }));
  const recovered = await loadPrivateOwnerInputs(wrap(db), context);
  const inputs = await loadReviewedImportInputs(wrap(db), context);
  const writer = new CanonicalOwnerWriter(wrap(db), { ...context, ...inputs });
  for (const item of recovered) await writer.write(item.intent, item.credential);
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  expect(await reconcileImportedOwners(wrap(db), { ...context, ...inputs }, recovered)).toMatchObject({
    owners: 2,
    preservedPasswords: 1,
    claimPending: 1,
  });
  const owner = await db
    .selectFrom('user')
    .selectAll()
    .where('id', '=', plan.owners[0].destinationId)
    .executeTakeFirstOrThrow();
  expect(await verifyImportedPassword(password, owner.password!)).toBe(true);
  expect(owner.email).toBe('preserved@example.test');
  const [{ private_owners: retained, private_owners_sha256: checksum }] = await wrap(db).query(
    'SELECT private_owners,private_owners_sha256 FROM frameleaf_library_import',
  );
  expect(JSON.stringify(retained)).not.toContain(sourceHash);
  expect(JSON.stringify(recovered)).not.toContain(owner.password);
  const publicInputs = JSON.stringify(await loadReviewedImportInputs(wrap(db), context));
  const status = JSON.stringify(await new LibraryImportJournal(wrap(db)).status());
  for (const output of [publicInputs, status]) {
    expect(output).not.toContain(owner.password);
    expect(output).not.toContain(checksum);
    expect(output).not.toContain('preserved@example.test');
  }
});

it('replays normalized email and inventory order without changing the protected record', async () => {
  const { context, inventory } = await setup();
  await retainPrivateOwnerInputs(wrap(db), context, inventory);
  const before = await wrap(db).query('SELECT private_owners,private_owners_sha256 FROM frameleaf_library_import');
  inventory[0].intent.email = 'preserved@example.test';
  await retainPrivateOwnerInputs(wrap(db), context, inventory.toReversed());
  expect(await wrap(db).query('SELECT private_owners,private_owners_sha256 FROM frameleaf_library_import')).toEqual(
    before,
  );
});

it.each([
  ['email', 'IMPORT_PRIVATE_OWNERS_CHANGED'],
  ['snapshot', 'IMPORT_PRIVATE_OWNERS_CHANGED'],
  ['claim-reason', 'IMPORT_PRIVATE_OWNERS_CHANGED'],
  ['missing-credential', 'OWNER_CREDENTIAL_DISPOSITION_MISMATCH'],
  ['missing-owner', 'OWNER_RECONCILIATION_MISMATCH'],
  ['duplicate-owner', 'OWNER_RECONCILIATION_MISMATCH'],
  ['email-collision', 'OWNER_EMAIL_COLLISION'],
  ['mfa', 'OWNER_INTENT_INVALID'],
  ['extra-session', 'OWNER_INTENT_INVALID'],
] as const)('refuses changed %s without overwriting the archived accounts', async (kind, code) => {
  const { context, inventory } = await setup();
  await retainPrivateOwnerInputs(wrap(db), context, inventory);
  const changed = inventory.map(({ intent, credential }) => ({ intent: structuredClone(intent), credential }));
  switch (kind) {
    case 'email': {
      changed[0].intent.email = 'changed@example.test';
      break;
    }
    case 'snapshot': {
      changed[0].intent.login.snapshotSha256 = 'f'.repeat(64);
      break;
    }
    case 'claim-reason': {
      changed[1].intent.disposition.reason = 'unsupported-local-verifier';
      break;
    }
    case 'missing-credential': {
      changed[0].credential = undefined;
      break;
    }
    case 'missing-owner': {
      changed.pop();
      break;
    }
    case 'duplicate-owner': {
      changed[1] = changed[0];
      break;
    }
    case 'email-collision': {
      changed[0].intent.email = changed[1].intent.email;
      break;
    }
    case 'mfa': {
      changed[0].intent.login.secondFactorRequired = true;
      break;
    }
    case 'extra-session': {
      Object.assign(changed[0].intent, { session: 'synthetic forbidden source session' });
      break;
    }
  }
  await expect(retainPrivateOwnerInputs(wrap(db), context, changed)).rejects.toThrow(code);
  expect(await loadPrivateOwnerInputs(wrap(db), context)).toHaveLength(2);
  await retainPrivateOwnerInputs(wrap(db), context, inventory);
});

it('refuses changed protected credentials and credentials from another operation', async () => {
  const { context, inventory, plan } = await setup();
  await retainPrivateOwnerInputs(wrap(db), context, inventory);
  const identity = {
    operationId: context.binding.operationId,
    sourceUserId: 'preserved',
    destinationUserId: plan.owners[0].destinationId,
  };
  const changed = await ImportedPassword.fromSource(identity, 'bcrypt', await hash('changed source password', 4));
  await expect(
    retainPrivateOwnerInputs(wrap(db), context, [{ ...inventory[0], credential: changed }, inventory[1]]),
  ).rejects.toThrow('IMPORT_PRIVATE_OWNERS_CHANGED');
  const foreign = await ImportedPassword.fromSource({ ...identity, operationId: randomUUID() }, 'bcrypt', sourceHash);
  await expect(
    retainPrivateOwnerInputs(wrap(db), context, [{ ...inventory[0], credential: foreign }, inventory[1]]),
  ).rejects.toThrow('OWNER_CREDENTIAL_MISMATCH');
});

it('requires both complete public inputs and the exact operation/destination before recovery', async () => {
  const { context, inventory } = await setup();
  await expect(loadPrivateOwnerInputs(wrap(db), context)).rejects.toThrow('IMPORT_PRIVATE_OWNERS_MISSING');
  await retainPrivateOwnerInputs(wrap(db), context, inventory);
  await expect(
    loadPrivateOwnerInputs(wrap(db), { ...context, binding: { ...context.binding, operationId: randomUUID() } }),
  ).rejects.toThrow('IMPORT_BINDING_CHANGED');
  await expect(loadPrivateOwnerInputs(wrap(db), { ...context, destinationId: randomUUID() })).rejects.toThrow(
    'IMPORT_PLAN_DESTINATION_CHANGED',
  );
  await sql`UPDATE frameleaf_library_import SET reviewed_manifest=NULL,reviewed_plan=NULL`.execute(db);
  await expect(loadPrivateOwnerInputs(wrap(db), context)).rejects.toThrow('IMPORT_REVIEWED_INPUTS_MISSING');
});

it('refuses corrupted private contents, checksums and credential identity', async () => {
  const { context, inventory, plan } = await setup();
  await retainPrivateOwnerInputs(wrap(db), context, inventory);
  const [original] = await wrap(db).query('SELECT private_owners,private_owners_sha256 FROM frameleaf_library_import');
  const reset = () =>
    sql`UPDATE frameleaf_library_import SET private_owners=${JSON.stringify(original.private_owners)}::text::jsonb,
    private_owners_sha256=${original.private_owners_sha256}`.execute(db);
  await sql`UPDATE frameleaf_library_import SET private_owners=jsonb_set(private_owners,'{owners,0,intent,email}','"changed@example.test"'::jsonb)`.execute(
    db,
  );
  await expect(loadPrivateOwnerInputs(wrap(db), context)).rejects.toThrow('IMPORT_PRIVATE_OWNERS_CHANGED');
  await reset();
  await sql`UPDATE frameleaf_library_import SET private_owners_sha256=${'f'.repeat(64)}`.execute(db);
  await expect(loadPrivateOwnerInputs(wrap(db), context)).rejects.toThrow('IMPORT_PRIVATE_OWNERS_CHANGED');
  await reset();
  const foreign = await ImportedPassword.fromSource(
    { operationId: randomUUID(), sourceUserId: 'preserved', destinationUserId: plan.owners[0].destinationId },
    'bcrypt',
    sourceHash,
  );
  await sql`UPDATE frameleaf_library_import SET private_owners=jsonb_set(private_owners,'{owners,1,credential}',${JSON.stringify(foreign.forImport())}::text::jsonb)`.execute(
    db,
  );
  await expect(loadPrivateOwnerInputs(wrap(db), context)).rejects.toThrow('IMPORT_PRIVATE_OWNERS_INVALID');
  await sql`UPDATE frameleaf_library_import SET private_owners='{}'::jsonb`.execute(db);
  await expect(loadPrivateOwnerInputs(wrap(db), context)).rejects.toThrow('IMPORT_PRIVATE_OWNERS_INVALID');
});

it('recovers a lost commit acknowledgement and rolls back an interrupted retention transaction', async () => {
  const { context, inventory } = await setup();
  const actual = wrap(db);
  const interrupted: ImportDatabase = {
    ...actual,
    transaction: (body) =>
      actual.transaction(async (tx) => {
        await body(tx);
        throw new Error('synthetic private credential-bearing driver failure');
      }),
  };
  await expect(retainPrivateOwnerInputs(interrupted, context, inventory)).rejects.toThrow(
    /^Library import refused: IMPORT_REVIEWED_INPUTS_UNAVAILABLE$/,
  );
  await expect(loadPrivateOwnerInputs(actual, context)).rejects.toThrow('IMPORT_PRIVATE_OWNERS_MISSING');
  const lost: ImportDatabase = {
    ...actual,
    transaction: async (body) => {
      await actual.transaction(body);
      throw new Error('synthetic lost acknowledgement');
    },
  };
  await expect(retainPrivateOwnerInputs(lost, context, inventory)).rejects.toThrow(
    'IMPORT_REVIEWED_INPUTS_UNAVAILABLE',
  );
  expect(await loadPrivateOwnerInputs(actual, context)).toHaveLength(2);
  await retainPrivateOwnerInputs(actual, context, inventory);
});

it('retains recovery after abandonment without permitting further writes or destructive downgrade', async () => {
  const { context, inventory } = await setup();
  await retainPrivateOwnerInputs(wrap(db), context, inventory);
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'abandoned');
  expect(await loadPrivateOwnerInputs(wrap(db), context)).toHaveLength(2);
  await expect(retainPrivateOwnerInputs(wrap(db), context, inventory)).rejects.toThrow(
    'IMPORT_REVIEWED_INPUTS_READ_ONLY',
  );
  await expect(down(db)).rejects.toThrow('Private owner recovery inputs must be retained');
  expect(await loadPrivateOwnerInputs(wrap(db), context)).toHaveLength(2);
});

it('enforces paired private object/checksum storage and supports empty downgrade/upgrade', async () => {
  const { context } = await setup();
  await expect(sql`UPDATE frameleaf_library_import SET private_owners='{}'::jsonb`.execute(db)).rejects.toMatchObject({
    code: '23514',
  });
  await expect(
    sql`UPDATE frameleaf_library_import SET private_owners='[]'::jsonb,private_owners_sha256=${'a'.repeat(64)}`.execute(
      db,
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await down(db);
  await up(db);
  await expect(loadPrivateOwnerInputs(wrap(db), context)).rejects.toThrow('IMPORT_PRIVATE_OWNERS_MISSING');
});
