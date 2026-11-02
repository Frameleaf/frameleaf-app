import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ImportDatabase } from 'src/immich-import/types.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { loadReviewedImportInputs, retainReviewedImportInputs } from 'src/library-import/reviewed-inputs.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/2100000003045-LibraryImportReviewedInputs.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const wrap = (connection: Kysely<any>): ImportDatabase => ({
  query: async (statement, parameters = []) =>
    (await connection.executeQuery(CompiledQuery.raw(statement, parameters))).rows as Record<string, unknown>[],
  transaction: (body) => connection.transaction().execute((tx) => body(wrap(tx))),
});
const setup = async (version: 1 | 2 | 3 = 2) => {
  const plan = parseDestinationImportPlan(fixture.plan);
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version,
    source: plan.source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: plan.source.revision,
      revisionAfter: plan.source.revision,
    },
    users: [{ id: 'owner-1', name: 'Synthetic owner' }],
    files: [{ id: 'file-1', path: 'camera.jpg', bytes: '14', sha256: plan.files[0].sha256, role: 'original' }],
    assets: [
      {
        id: 'photo',
        ownerId: 'owner-1',
        fileIds: ['file-1'],
        ...(version === 1 ? {} : { primaryFileId: 'file-1' }),
        ...(version === 3
          ? {
              type: 'IMAGE',
              fileModifiedAt: '2020-01-02T03:04:05.123456Z',
              originalFileNames: { 'file-1': 'Manual original.jpg' },
            }
          : {}),
        visibility: 'timeline',
        metadata: {},
      },
    ],
    albums: [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
    source: plan.source,
  };
  const context = { binding, destinationId: plan.destinationId };
  await new LibraryImportJournal(wrap(db)).begin(binding);
  return { context, manifest, plan };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
beforeEach(async () => {
  await sql`TRUNCATE public.frameleaf_library_import_mapping,public.frameleaf_library_import,public.frameleaf_immich_import`.execute(
    db,
  );
});
afterAll(async () => db?.destroy());

it('retains complete reviewed inputs and reloads independently from the journal', async () => {
  const { context, manifest, plan } = await setup();
  await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
  expect(await loadReviewedImportInputs(wrap(db), context)).toEqual({ manifest, plan });
  await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  expect(await loadReviewedImportInputs(wrap(db), context)).toEqual({ manifest, plan });
});

it.each([1, 3] as const)('retains version %s without changing its fingerprint or sealed metadata', async (version) => {
  const { context, manifest, plan } = await setup(version);
  await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
  const recovered = await loadReviewedImportInputs(wrap(db), context);
  expect(recovered).toEqual({ manifest, plan });
  expect(manifestFingerprint(recovered.manifest)).toBe(context.binding.manifestSha256);
});

it('reloads after reconnect without disclosing inventories through ordinary status', async () => {
  const { context, manifest, plan } = await setup();
  await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
  const [{ name }] = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows;
  await db.destroy();
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/${name}`;
  db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.href }));
  expect(await loadReviewedImportInputs(wrap(db), context)).toEqual({ manifest, plan });
  const status = JSON.stringify(await new LibraryImportJournal(wrap(db)).status());
  expect(status).not.toContain('Synthetic owner');
  expect(status).not.toContain(plan.roots[0].path);
});

it('recovers a committed retention after a lost acknowledgement', async () => {
  const { context, manifest, plan } = await setup();
  const actual = wrap(db);
  const lost: ImportDatabase = {
    ...actual,
    transaction: async (body) => {
      await actual.transaction(body);
      throw new Error('synthetic lost acknowledgement');
    },
  };
  await expect(retainReviewedImportInputs(lost, context, { manifest, plan })).rejects.toThrow(
    'IMPORT_REVIEWED_INPUTS_UNAVAILABLE',
  );
  expect(await loadReviewedImportInputs(actual, context)).toEqual({ manifest, plan });
  await retainReviewedImportInputs(actual, context, { manifest, plan });
});

it('rolls retention back with an interrupted transaction', async () => {
  const { context, manifest, plan } = await setup();
  const actual = wrap(db);
  const interrupted: ImportDatabase = {
    ...actual,
    transaction: (body) =>
      actual.transaction(async (tx) => {
        await body(tx);
        throw new Error('synthetic private source detail');
      }),
  };
  await expect(retainReviewedImportInputs(interrupted, context, { manifest, plan })).rejects.toThrow(
    'IMPORT_REVIEWED_INPUTS_UNAVAILABLE',
  );
  await expect(loadReviewedImportInputs(actual, context)).rejects.toThrow('IMPORT_REVIEWED_INPUTS_MISSING');
  await retainReviewedImportInputs(actual, context, { manifest, plan });
});

it.each(['manifest', 'plan', 'credential', 'destination', 'binding'] as const)(
  'refuses changed %s without overwriting retained inputs',
  async (kind) => {
    const { context, manifest, plan } = await setup();
    await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
    const changed = structuredClone({ context, input: { manifest, plan } });
    switch (kind) {
      case 'manifest': {
        changed.input.manifest.users[0].name = 'Unreviewed name';
        break;
      }
      case 'plan': {
        changed.input.plan.roots[0].path = '/unreviewed-root';
        break;
      }
      case 'credential': {
        Object.assign(changed.input.manifest.users[0], { password: 'synthetic secret' });
        break;
      }
      case 'destination': {
        changed.context.destinationId = randomUUID();
        break;
      }
      case 'binding': {
        changed.context.binding.operationId = randomUUID();
        break;
      }
    }
    await expect(retainReviewedImportInputs(wrap(db), changed.context, changed.input)).rejects.toThrow();
    expect(await loadReviewedImportInputs(wrap(db), context)).toEqual({ manifest, plan });
  },
);

it.each(['manifest', 'plan'] as const)('rehashes retained %s instead of trusting its presence', async (kind) => {
  const { context, manifest, plan } = await setup();
  await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
  if (kind === 'manifest')
    await sql`UPDATE frameleaf_library_import SET reviewed_manifest=jsonb_set(reviewed_manifest,'{users,0,name}','"changed"'::jsonb)`.execute(
      db,
    );
  else
    await sql`UPDATE frameleaf_library_import SET reviewed_plan=jsonb_set(reviewed_plan,'{roots,0,path}','"/changed-root"'::jsonb)`.execute(
      db,
    );
  await expect(loadReviewedImportInputs(wrap(db), context)).rejects.toThrow('IMPORT_PLAN_BINDING_CHANGED');
  await expect(retainReviewedImportInputs(wrap(db), context, { manifest, plan })).rejects.toThrow(
    'IMPORT_PLAN_BINDING_CHANGED',
  );
});

it('retains readable recovery inputs after abandonment and refuses further writes', async () => {
  const { context, manifest, plan } = await setup();
  await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'abandoned');
  expect(await loadReviewedImportInputs(wrap(db), context)).toEqual({ manifest, plan });
  await expect(retainReviewedImportInputs(wrap(db), context, { manifest, plan })).rejects.toThrow(
    'IMPORT_REVIEWED_INPUTS_READ_ONLY',
  );
});

it('refuses retention after the destination starts writing, without deleting recovery inputs', async () => {
  const { context, manifest, plan } = await setup();
  await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
  await sql`UPDATE frameleaf_library_import SET status='activated'`.execute(db);
  await expect(retainReviewedImportInputs(wrap(db), context, { manifest, plan })).rejects.toThrow(
    'IMPORT_REVIEWED_INPUTS_READ_ONLY',
  );
  expect(await loadReviewedImportInputs(wrap(db), context)).toEqual({ manifest, plan });
});

it('requires the journal and exact binding before reading any retained inventory', async () => {
  const { context, manifest, plan } = await setup();
  await expect(loadReviewedImportInputs(wrap(db), context)).rejects.toThrow('IMPORT_REVIEWED_INPUTS_MISSING');
  await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
  await expect(
    loadReviewedImportInputs(wrap(db), { ...context, binding: { ...context.binding, manifestSha256: 'f'.repeat(64) } }),
  ).rejects.toThrow('IMPORT_BINDING_CHANGED');
  await expect(loadReviewedImportInputs(wrap(db), { ...context, destinationId: randomUUID() })).rejects.toThrow(
    'IMPORT_PLAN_DESTINATION_CHANGED',
  );
  await sql`TRUNCATE frameleaf_library_import_mapping,frameleaf_library_import`.execute(db);
  await expect(loadReviewedImportInputs(wrap(db), context)).rejects.toThrow('IMPORT_JOURNAL_MISSING');
});

it('refuses a concurrent importer before reading or writing the inventory', async () => {
  const { context, manifest, plan } = await setup();
  await db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(${LIBRARY_IMPORT_LOCK}::bigint)`.execute(tx);
    await expect(retainReviewedImportInputs(wrap(db), context, { manifest, plan })).rejects.toThrow(
      'IMPORT_ALREADY_RUNNING',
    );
    await expect(loadReviewedImportInputs(wrap(db), context)).rejects.toThrow('IMPORT_ALREADY_RUNNING');
  });
});

it('enforces paired object inputs in the database and refuses destructive downgrade', async () => {
  const { context, manifest, plan } = await setup();
  await expect(sql`UPDATE frameleaf_library_import SET reviewed_manifest='{}'::jsonb`.execute(db)).rejects.toThrow();
  await expect(
    sql`UPDATE frameleaf_library_import SET reviewed_manifest='[]'::jsonb,reviewed_plan='{}'::jsonb`.execute(db),
  ).rejects.toThrow();
  await retainReviewedImportInputs(wrap(db), context, { manifest, plan });
  await expect(down(db)).rejects.toThrow('Reviewed library import inputs must be retained');
  expect(await loadReviewedImportInputs(wrap(db), context)).toEqual({ manifest, plan });
});

it('supports downgrade and upgrade when no reviewed inventory would be lost', async () => {
  const { context } = await setup();
  await down(db);
  await up(db);
  await expect(loadReviewedImportInputs(wrap(db), context)).rejects.toThrow('IMPORT_REVIEWED_INPUTS_MISSING');
});
