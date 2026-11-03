import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { type ImportDatabase } from 'src/immich-import/types.js';
import { readLibraryImportActivation, sealLibraryImportActivation } from 'src/library-import/activation-proof.js';
import { LibraryImportController } from 'src/library-import/controller.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import photoFixture from 'src/library-import/fixtures/photoprism/261029-files.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import {
  EMPTY_SOURCE_ARCHIVE_HASH,
  advanceSourceArchiveHash,
  encodeSourceArchiveRecord,
} from 'src/library-import/source-archive-codec.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { type DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let connection: ReturnType<typeof connectImportDatabase>;
const records = Array.from({ length: 1001 }, (_, id) => ({ table: 'photos', value: { id: BigInt(id) } }));
let archiveHash = EMPTY_SOURCE_ARCHIVE_HASH;
for (const row of records) archiveHash = advanceSourceArchiveHash(archiveHash, encodeSourceArchiveRecord(row));
const descriptor = { format: 'frameleaf-source-archive', version: 1, rows: '1001', sha256: archiveHash };
function* stream() {
  yield* records;
}
const setup = () => {
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.files = [];
  plan.owners = [{ sourceId: 'owner', destinationId: randomUUID() }];
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
    users: [{ id: 'owner', name: 'Imported owner' }],
    files: [],
    assets: [],
    albums: [],
    losses: [],
  });
  const context = {
    manifest,
    plan,
    destinationId: plan.destinationId,
    binding: {
      operationId: randomUUID(),
      source: plan.source,
      manifestSha256: manifestFingerprint(manifest),
      planSha256: destinationPlanFingerprint(plan),
    },
  };
  const owners = [
    {
      intent: {
        sourceUserId: 'owner',
        email: 'owner@example.test',
        login: {
          revision: plan.source.revision,
          snapshotSha256: 'e'.repeat(64),
          accountEnabled: true,
          passwordLoginEnabled: true,
          secondFactorRequired: false,
          externalIdentityRequired: false,
          ownedLibraryAccess: 'full',
          otherRestrictions: 'none',
        },
        disposition: { kind: 'claim', reason: 'no-local-verifier', claimPermitted: true },
      },
    },
  ];
  return { context, owners };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
beforeEach(async () => {
  await sql`TRUNCATE public.frameleaf_library_import_mapping,public.frameleaf_library_import,public.frameleaf_immich_import,public."user",public.cluster_group CASCADE`.execute(
    db,
  );
  await sql`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO public."user"(email,"clusterGroupId","isAdmin") SELECT 'bootstrap@example.test',id,true FROM g`.execute(
    db,
  );
  const [{ name }] = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows;
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = '/' + name;
  connection = connectImportDatabase(url.href, false);
});
afterEach(async () => {
  await connection?.close();
});
afterAll(async () => {
  await db?.destroy();
});

it('coordinates protected source retention, canonical owners and independent readback without activating writers', async () => {
  const { context, owners } = setup();
  const controller = new LibraryImportController(connection.db, context);
  expect((await controller.preflight(owners)).status).toBe('fresh');
  expect((await controller.run(owners, descriptor, stream())).run?.status).toBe('verifying');
  expect(await controller.verify()).toMatchObject({
    owners: { owners: 1, claimPending: 1 },
    assets: { assets: 0 },
    albums: { albums: 0 },
    stacks: { stacks: 0 },
    archive: { records: '1001', sealed: true },
  });
  const [owner] = await connection.db.query('SELECT email,"importClaimPending" FROM public."user" WHERE NOT "isAdmin"');
  expect(owner).toEqual({ email: 'owner@example.test', importClaimPending: true });
  expect(JSON.stringify(await controller.status())).not.toContain('owner@example.test');
  expect((await controller.resume(owners, descriptor, stream())).run?.status).toBe('verifying');
});

it('retains the actual canonical verification report through PostgreSQL JSONB without exposing private inventory', async () => {
  const { context, owners } = setup();
  const controller = new LibraryImportController(connection.db, context);
  await controller.run(owners, descriptor, stream());
  const report = await controller.verify();
  const sealed = sealLibraryImportActivation(context, report, undefined, new Date().toISOString());
  const [row] = await connection.db.query('SELECT $1::text::jsonb AS payload', [JSON.stringify(sealed.payload)]);
  const restored = readLibraryImportActivation({ payload: row.payload, sha256: sealed.sha256 }, context);
  expect(restored.report).toEqual(report);
  expect(restored.manager).toBeNull();
  expect(JSON.stringify(restored.report)).not.toMatch(/owner@example|Imported owner|photos/);
  expect((await controller.status()).run?.status).toBe('verifying');
});
it('requires retained activation evidence at startup and rejects destination replay', async () => {
  const { context, owners } = setup();
  const controller = new LibraryImportController(connection.db, context);
  await controller.run(owners, descriptor, stream());
  const sealed = sealLibraryImportActivation(context, await controller.verify(), undefined, new Date().toISOString());
  const gate = new DatabaseRepository(db, { setContext: () => {} } as never, {} as never);
  await connection.db.query("UPDATE public.frameleaf_library_import SET status='activated'");
  await expect(gate.assertImportActivated()).rejects.toThrow('DESTINATION_IMPORT_NOT_ACTIVATED');
  await connection.db.query(
    'UPDATE public.frameleaf_library_import SET activation=$1::text::jsonb,activation_sha256=$2',
    [JSON.stringify(sealed.payload), sealed.sha256],
  );
  await expect(gate.assertImportActivated()).resolves.toBeUndefined();
  await connection.db.query(
    "UPDATE public.frameleaf_library_import SET reviewed_plan=jsonb_set(reviewed_plan,'{destinationId}',$1::text::jsonb)",
    [JSON.stringify(randomUUID())],
  );
  await expect(gate.assertImportActivated()).rejects.toThrow('DESTINATION_IMPORT_NOT_ACTIVATED');
});

it('refuses an empty destination before retaining a journal that would block administrator setup', async () => {
  await sql`TRUNCATE public."user",public.cluster_group CASCADE`.execute(db);
  const { context, owners } = setup();
  const controller = new LibraryImportController(connection.db, context);
  await expect(controller.run(owners, descriptor, stream())).rejects.toThrow('DESTINATION_ADMIN_REQUIRED');
  expect(await connection.db.query('SELECT 1 FROM public.frameleaf_library_import')).toEqual([]);
  expect(await connection.db.query('SELECT 1 FROM public.frameleaf_library_import_archive')).toEqual([]);
});
it.each(['email', 'identity'])(
  'refuses a bootstrap administrator %s collision before retaining a journal',
  async (field) => {
    const { context, owners } = setup();
    if (field === 'email') owners[0].intent.email = 'bootstrap@example.test';
    else {
      const [admin] = await connection.db.query('SELECT id::text FROM public."user" WHERE "isAdmin"');
      context.plan.owners[0].destinationId = String(admin.id);
      context.binding.planSha256 = destinationPlanFingerprint(context.plan);
    }
    const controller = new LibraryImportController(connection.db, context);
    await expect(controller.run(owners, descriptor, stream())).rejects.toThrow(
      field === 'email' ? 'OWNER_EMAIL_COLLISION' : 'OWNER_DESTINATION_COLLISION',
    );
    expect(await connection.db.query('SELECT 1 FROM public.frameleaf_library_import')).toEqual([]);
  },
);
it('refuses changed private owners or archive descriptors after copying has completed', async () => {
  const { context, owners } = setup();
  const controller = new LibraryImportController(connection.db, context);
  await controller.run(owners, descriptor, stream());
  const changed = structuredClone(owners);
  changed[0].intent.email = 'changed@example.test';
  await expect(controller.resume(changed, descriptor, stream())).rejects.toThrow('IMPORT_PRIVATE_OWNERS_CHANGED');
  await expect(controller.resume(owners, { ...descriptor, sha256: 'd'.repeat(64) }, stream())).rejects.toThrow(
    'SOURCE_ARCHIVE_DESCRIPTOR_CHANGED',
  );
  expect((await controller.status()).run?.status).toBe('verifying');
});
it('keeps canonical accounts absent when the source archive is incomplete or mismatched', async () => {
  const { context, owners } = setup();
  const controller = new LibraryImportController(connection.db, context);
  await expect(controller.run(owners, { ...descriptor, sha256: 'd'.repeat(64) }, stream())).rejects.toThrow(
    'SOURCE_ARCHIVE_HASH_MISMATCH',
  );
  expect((await connection.db.query('SELECT 1 FROM public."user" WHERE NOT "isAdmin"')).length).toBe(0);
  expect((await controller.status()).run?.status).toBe('copying');
  await controller.abandon();
  expect(
    (await connection.db.query('SELECT count(*)::text AS count FROM public.frameleaf_library_import_archive_record'))[0]
      .count,
  ).toBe('1001');
});
it('resumes a durably retained archive prefix after a source interruption', async () => {
  const { context, owners } = setup();
  const controller = new LibraryImportController(connection.db, context);
  function* interrupted() {
    yield* records.slice(0, 1000);
    throw new Error('private source failure');
  }
  await expect(controller.run(owners, descriptor, interrupted())).rejects.toThrow('IMPORT_CONTROLLER_UNAVAILABLE');
  expect(
    (await connection.db.query('SELECT written_count::text FROM public.frameleaf_library_import_archive'))[0]
      .written_count,
  ).toBe('1000');
  expect((await connection.db.query('SELECT 1 FROM public."user" WHERE NOT "isAdmin"')).length).toBe(0);
  await controller.resume(owners, descriptor, stream());
  expect((await controller.verify()).archive.records).toBe('1001');
});
it('recovers a committed owner mapping after its acknowledgement is lost', async () => {
  const { context, owners } = setup();
  const base = connection.db;
  let lose = true;
  const interrupted: ImportDatabase = {
    ...base,
    transaction: async (body) => {
      const value = await base.transaction(body);
      if (lose && value === context.plan.owners[0].destinationId) {
        lose = false;
        throw new Error('lost private acknowledgement');
      }
      return value;
    },
  };
  const controller = new LibraryImportController(interrupted, context);
  await expect(controller.run(owners, descriptor, stream())).rejects.toThrow('OWNER_WRITE_FAILED');
  expect((await connection.db.query('SELECT 1 FROM public."user" WHERE NOT "isAdmin"')).length).toBe(1);
  await controller.resume(owners, descriptor, stream());
  expect((await controller.verify()).owners.owners).toBe(1);
  expect(
    (await connection.db.query("SELECT 1 FROM public.frameleaf_library_import_mapping WHERE entity_kind='owner'"))
      .length,
  ).toBe(1);
});

it.skipIf(process.platform !== 'linux')(
  'writes actual independent originals and private album relationships, then independently reconciles them',
  async () => {
    const { context, owners } = setup();
    const plan = context.plan;
    if (plan.version !== 1) throw new Error('Expected the legacy fixture plan');
    const temporary = await mkdtemp(join(tmpdir(), 'frameleaf-controller-'));
    try {
      const base = await realpath(temporary);
      const source = join(base, 'source'),
        destination = join(base, 'destination');
      await mkdir(source);
      await mkdir(destination);
      const roots = [];
      for (const [id, path] of [
        ['source', source],
        ['destination', destination],
      ]) {
        const info = await stat(path, { bigint: true });
        roots.push({ id, path, device: String(info.dev), inode: String(info.ino) });
      }
      plan.roots = roots;
      plan.files = [];
      const files = [];
      for (const [index, fixture] of photoFixture.files.entries()) {
        const id = 'original-' + index,
          path = index === 0 ? 'blue.png' : 'green.png';
        const bytes = Buffer.from(fixture.originalBase64, 'base64');
        await writeFile(join(source, path), bytes, { mode: 0o600 });
        await writeFile(join(destination, path), bytes, { mode: 0o600 });
        const info = await stat(join(source, path), { bigint: true });
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        files.push({ id, path, bytes: String(bytes.length), sha256, role: 'original' });
        plan.files.push({
          id,
          mode: 'copy',
          sourceRoot: 'source',
          sourcePath: path,
          destinationRoot: 'destination',
          destinationPath: path,
          sha256,
          bytes: String(bytes.length),
          sourceIdentity: {
            device: String(info.dev),
            inode: String(info.ino),
            bytes: String(info.size),
            mtimeNs: String(info.mtimeNs),
            ctimeNs: String(info.ctimeNs),
            links: String(info.nlink),
          },
          destinationDevice: roots[1].device,
        });
      }
      context.manifest = parseImportManifest({
        ...context.manifest,
        files,
        assets: [
          {
            id: 'photo',
            ownerId: 'owner',
            fileIds: files.map((file) => file.id),
            primaryFileId: files[0].id,
            type: 'IMAGE',
            fileModifiedAt: '2020-01-01T00:00:00Z',
            originalFileNames: Object.fromEntries(files.map((file) => [file.id, file.path])),
            visibility: 'archive',
            metadata: {
              takenAt: '2020-01-01T00:00:00Z',
              timeZone: 'UTC',
              description: 'Manual caption',
              favorite: true,
              tags: ['manual tag'],
            },
          },
        ],
        albums: [{ id: 'album', ownerId: 'owner', name: 'Private album', assetIds: ['photo'], members: [] }],
      });
      context.binding.manifestSha256 = manifestFingerprint(context.manifest);
      context.binding.planSha256 = destinationPlanFingerprint(plan);
      const controller = new LibraryImportController(connection.db, context);
      await controller.run(
        owners,
        { format: 'frameleaf-source-archive', version: 1, rows: '0', sha256: EMPTY_SOURCE_ARCHIVE_HASH },
        [],
      );
      expect(await controller.verify()).toMatchObject({
        assets: { assets: 1, originals: 2 },
        albums: { albums: 1, memberships: 1, grants: 1 },
      });
      expect((await connection.db.query('SELECT count(*)::text AS count FROM public.asset_original'))[0].count).toBe(
        '1',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it('checks the complete report in one native read-only repeatable-read snapshot', async () => {
  const { context, owners } = setup();
  await new LibraryImportController(connection.db, context).run(owners, descriptor, stream());
  const snapshots: { id: string; readOnly: string; isolation: string }[] = [];
  const observe = (target: ImportDatabase): ImportDatabase => ({
    ...target,
    query: async (statement, parameters) => {
      const rows = await target.query(statement, parameters);
      if (statement.includes('SELECT pg_try_advisory_xact_lock')) {
        const [snapshot] = await target.query(`SELECT txid_current()::text AS id,
          current_setting('transaction_read_only') AS "readOnly",
          current_setting('transaction_isolation') AS isolation`);
        snapshots.push(snapshot as (typeof snapshots)[number]);
      }
      return rows;
    },
    transaction: (body) => target.transaction((tx) => body(observe(tx))),
  });
  expect(await new LibraryImportController(observe(connection.db), context).verify()).toMatchObject({
    owners: { owners: 1 },
    archive: { sealed: true },
  });
  expect(snapshots.length).toBeGreaterThan(0);
  expect(new Set(snapshots.map((snapshot) => snapshot.id)).size).toBe(1);
  expect(snapshots.every((snapshot) => snapshot.readOnly === 'on' && snapshot.isolation === 'repeatable read')).toBe(
    true,
  );
});

it('refuses duplicate normalized owner emails without retaining a partial import journal', async () => {
  const { context, owners } = setup();
  const second = structuredClone(owners[0]);
  second.intent.sourceUserId = 'second-owner';
  second.intent.email = 'OWNER@EXAMPLE.TEST';
  context.manifest.users.push({ id: 'second-owner', name: 'Second owner' });
  context.plan.owners.push({ sourceId: 'second-owner', destinationId: randomUUID() });
  context.binding.manifestSha256 = manifestFingerprint(context.manifest);
  context.binding.planSha256 = destinationPlanFingerprint(context.plan);
  await expect(
    new LibraryImportController(connection.db, context).run([...owners, second], descriptor, stream()),
  ).rejects.toThrow('OWNER_EMAIL_COLLISION');
  expect(await connection.db.query('SELECT 1 FROM public.frameleaf_library_import')).toEqual([]);
  expect(await connection.db.query('SELECT 1 FROM public.frameleaf_library_import_archive')).toEqual([]);
});
