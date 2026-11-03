import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ImportDatabase } from 'src/immich-import/types.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { retainReviewedImportInputs } from 'src/library-import/reviewed-inputs.js';
import {
  EMPTY_SOURCE_ARCHIVE_HASH,
  SourceArchiveRecord,
  advanceSourceArchiveHash,
  encodeSourceArchiveRecord,
} from 'src/library-import/source-archive-codec.js';
import { LibrarySourceArchive } from 'src/library-import/source-archive.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const wrap = (connection: Kysely<any>): ImportDatabase => ({
  query: async (statement, parameters = []) =>
    (await connection.executeQuery(CompiledQuery.raw(statement, parameters))).rows as Record<string, unknown>[],
  transaction: (body) => connection.transaction().execute((tx) => body(wrap(tx))),
});
const setup = async (count = 3) => {
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.files = [];
  plan.owners = [];
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
    users: [],
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
  const records: SourceArchiveRecord[] = Array.from({ length: count }, (_, index) => ({
    table: 'photos',
    value: {
      id: BigInt(index) + 9_007_199_254_740_993n,
      caption: `Private manual caption ${index}\0`,
      binary: new Uint8Array([0, index % 256, 255]),
      ['__proto__']: `Private column ${index}`,
      constructor: 'Manual constructor',
      prototype: 'Manual prototype',
    },
  }));
  let sha256 = EMPTY_SOURCE_ARCHIVE_HASH;
  for (const record of records) sha256 = advanceSourceArchiveHash(sha256, encodeSourceArchiveRecord(record));
  const descriptor = { format: 'frameleaf-source-archive', version: 1, rows: String(count), sha256 };
  return { context, descriptor, records, store: new LibrarySourceArchive(wrap(db), context) };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
beforeEach(async () => {
  await sql`TRUNCATE frameleaf_library_import_mapping,frameleaf_library_import,frameleaf_immich_import CASCADE`.execute(
    db,
  );
});
afterAll(async () => db?.destroy());

it.each([0, 3, 1100])('retains and independently verifies exactly %s records in bounded pages', async (count) => {
  const { store, descriptor, records } = await setup(count);
  await store.begin(descriptor);
  for (let offset = 0; offset < count; offset += 600)
    await store.append(String(offset), records.slice(offset, offset + 600));
  const report = await store.seal();
  expect(report).toMatchObject({ records: String(count), sha256: descriptor.sha256, sealed: true });
  expect(await store.verify()).toEqual(report);
  await store.begin(descriptor);
  expect(await store.seal()).toEqual(report);
  const recovered: SourceArchiveRecord[] = [];
  let offset: string | null = '0';
  while (offset !== null) {
    const page = await store.page(offset);
    expect(page.records.length).toBeLessThanOrEqual(1000);
    recovered.push(...page.records);
    offset = page.next;
  }
  expect(recovered).toEqual(records);
  expect(JSON.stringify(await new LibraryImportJournal(wrap(db)).status())).not.toContain('Private manual caption');
});
it('accepts identical and overlapping replay without changing retained records', async () => {
  const { store, descriptor, records } = await setup();
  await store.begin(descriptor);
  await store.append('0', records.slice(0, 2));
  await store.append('0', records.slice(0, 2));
  await store.append('1', records.slice(1));
  await store.seal();
  await store.append('0', records);
  expect((await store.page()).records).toEqual(records);
});
it('refuses missing, changed and reordered input instead of silently repairing it', async () => {
  const { store, descriptor, records } = await setup();
  await store.begin(descriptor);
  await store.append('0', records.slice(0, 2));
  await expect(store.append('3', records.slice(2))).rejects.toThrow('SOURCE_ARCHIVE_GAP');
  await expect(store.append('0', [records[1]])).rejects.toThrow('SOURCE_ARCHIVE_RECORD_CHANGED');
  await expect(store.seal()).rejects.toThrow('SOURCE_ARCHIVE_INCOMPLETE');
  expect((await store.page()).records).toEqual(records.slice(0, 2));
});
it('pins expected inventory and refuses a changed destination or reviewed inputs', async () => {
  const { store, descriptor, context } = await setup();
  await store.begin(descriptor);
  await expect(store.begin({ ...descriptor, sha256: 'f'.repeat(64) })).rejects.toThrow(
    'SOURCE_ARCHIVE_DESCRIPTOR_CHANGED',
  );
  await expect(new LibrarySourceArchive(wrap(db), { ...context, destinationId: randomUUID() }).page()).rejects.toThrow(
    'SOURCE_ARCHIVE_DESTINATION_CHANGED',
  );
  await sql`UPDATE frameleaf_library_import SET reviewed_plan=jsonb_set(reviewed_plan,'{roots,0,path}','"/changed-root"')`.execute(
    db,
  );
  await expect(store.begin(descriptor)).rejects.toThrow('IMPORT_PLAN_BINDING_CHANGED');
});
it('refuses credential columns, gaps and out-of-inventory appends before they are retained', async () => {
  const { store, descriptor, records } = await setup(1);
  await store.begin(descriptor);
  await expect(store.append('0', [{ table: 'users', value: { password: 'synthetic credential' } }])).rejects.toThrow(
    'SOURCE_ARCHIVE_CREDENTIAL_COLUMN',
  );
  await expect(store.append('0', [...records, ...records])).rejects.toThrow('SOURCE_ARCHIVE_COUNT_MISMATCH');
  await expect(store.append('0', [])).rejects.toThrow('SOURCE_ARCHIVE_PAGE_INVALID');
  expect((await store.page()).records).toEqual([]);
});
it.each(['payload', 'checksum', 'gap', 'descriptor'] as const)(
  'detects retained %s corruption on readback',
  async (kind) => {
    const { store, descriptor, records } = await setup();
    await store.begin(descriptor);
    await store.append('0', records);
    await store.seal();
    switch (kind) {
      case 'payload': {
        await sql`UPDATE frameleaf_library_import_archive_record SET payload='{}'::jsonb WHERE ordinal=0`.execute(db);
        break;
      }
      case 'checksum': {
        await sql`UPDATE frameleaf_library_import_archive_record SET sha256=${'f'.repeat(64)} WHERE ordinal=0`.execute(
          db,
        );
        break;
      }
      case 'gap': {
        await sql`DELETE FROM frameleaf_library_import_archive_record WHERE ordinal=0`.execute(db);
        break;
      }
      case 'descriptor': {
        await sql`UPDATE frameleaf_library_import_archive SET expected_sha256=${'f'.repeat(64)}`.execute(db);
        break;
      }
    }
    await expect(store.verify()).rejects.toThrow('SOURCE_ARCHIVE_');
  },
);
it.each(['abandoned', 'activated'] as const)(
  'retains recovery data after %s and refuses further writes',
  async (phase) => {
    const { store, descriptor, records, context } = await setup();
    await store.begin(descriptor);
    await store.append('0', records);
    await store.seal();
    if (phase === 'abandoned') await new LibraryImportJournal(wrap(db)).phase(context.binding, phase);
    else await sql`UPDATE frameleaf_library_import SET status='activated'`.execute(db);
    expect((await store.page()).records).toEqual(records);
    expect((await store.verify()).sha256).toBe(descriptor.sha256);
    await expect(store.append('0', records)).rejects.toThrow('IMPORT_REVIEWED_INPUTS_READ_ONLY');
    await expect(store.seal()).rejects.toThrow('IMPORT_REVIEWED_INPUTS_READ_ONLY');
  },
);
it('does not seal a complete inventory with a different expected digest', async () => {
  const { store, descriptor, records } = await setup();
  await store.begin({ ...descriptor, sha256: 'f'.repeat(64) });
  await store.append('0', records);
  await expect(store.seal()).rejects.toThrow('SOURCE_ARCHIVE_HASH_MISMATCH');
  expect((await sql`SELECT sealed FROM frameleaf_library_import_archive`.execute(db)).rows).toEqual([
    { sealed: false },
  ]);
});
it('keeps its bound context when the caller changes the original object', async () => {
  const { store, descriptor, records, context } = await setup();
  const operationId = context.binding.operationId;
  await store.begin(descriptor);
  context.binding.operationId = randomUUID();
  context.destinationId = randomUUID();
  await store.append('0', records);
  expect((await store.seal()).operationId).toBe(operationId);
});
it('protects the parent recovery journal while any archive is retained', async () => {
  const { store, descriptor, context } = await setup(0);
  await store.begin(descriptor);
  await expect(sql`DELETE FROM frameleaf_library_import`.execute(db)).rejects.toThrow();
  expect((await new LibraryImportJournal(wrap(db)).status()).run?.binding).toEqual(context.binding);
});
it('rolls interrupted pages back and recovers a committed page after lost acknowledgement', async () => {
  const { store, descriptor, records, context } = await setup();
  await store.begin(descriptor);
  const actual = wrap(db);
  const interrupted: ImportDatabase = {
    ...actual,
    transaction: (body) =>
      actual.transaction(async (tx) => {
        await body(tx);
        throw new Error('synthetic interruption');
      }),
  };
  await expect(new LibrarySourceArchive(interrupted, context).append('0', records)).rejects.toThrow(
    'IMPORT_REVIEWED_INPUTS_UNAVAILABLE',
  );
  expect((await store.page()).records).toEqual([]);
  const lost: ImportDatabase = {
    ...actual,
    transaction: async (body) => {
      await actual.transaction(body);
      throw new Error('synthetic lost acknowledgement');
    },
  };
  await expect(new LibrarySourceArchive(lost, context).append('0', records)).rejects.toThrow(
    'IMPORT_REVIEWED_INPUTS_UNAVAILABLE',
  );
  await store.append('0', records);
  expect((await store.seal()).sha256).toBe(descriptor.sha256);
});
it('recovers after reconnect and keeps metadata outside ordinary status', async () => {
  const { store, descriptor, records, context } = await setup();
  await store.begin(descriptor);
  await store.append('0', records);
  await store.seal();
  const [{ name }] = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows;
  await db.destroy();
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/${name}`;
  db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.href }));
  const recovered = new LibrarySourceArchive(wrap(db), context);
  expect((await recovered.verify()).sha256).toBe(descriptor.sha256);
  expect((await recovered.page()).records).toEqual(records);
});
it('refuses a concurrent importer before reading or writing archive data', async () => {
  const { store, descriptor } = await setup();
  await store.begin(descriptor);
  await db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(${LIBRARY_IMPORT_LOCK}::bigint)`.execute(tx);
    await expect(store.page()).rejects.toThrow('IMPORT_ALREADY_RUNNING');
    await expect(store.verify()).rejects.toThrow('IMPORT_ALREADY_RUNNING');
  });
});
