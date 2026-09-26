import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ChecksumAlgorithm } from 'src/enum.js';
import { MediaHealthRepository, RelinkExternalAsset } from 'src/repositories/media-health.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

describe('Media health transactional relink audit', () => {
  let db: Kysely<DB>;
  let sut: MediaHealthRepository;
  beforeAll(async () => {
    db = await getKyselyDB();
    sut = new MediaHealthRepository(db);
  });
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`DROP SCHEMA IF EXISTS immich_fork CASCADE`.execute(db);
    for (const statement of [
      'CREATE SCHEMA public',
      'CREATE SCHEMA immich_fork',
      'CREATE TABLE public.user (id uuid PRIMARY KEY)',
      `CREATE TABLE public.asset (id uuid PRIMARY KEY, "ownerId" uuid REFERENCES public.user, "updateId" uuid DEFAULT gen_random_uuid(),
        "originalPath" text, "originalFileName" text, checksum bytea, "checksumAlgorithm" text, "isExternal" boolean,
        "libraryId" uuid, "deletedAt" timestamptz, status text DEFAULT 'active', "isOffline" boolean DEFAULT true,
        "physicalOriginalFileId" uuid, "fileModifiedAt" timestamptz)`,
      'CREATE TABLE public.physical_file (id uuid PRIMARY KEY, "canonicalAssetId" uuid, checksum bytea, path text UNIQUE, "sizeInBytes" bigint, type text)',
      "CREATE TABLE immich_fork.state (id integer PRIMARY KEY, phase text); INSERT INTO immich_fork.state VALUES (1, 'dual-write')",
      'CREATE TABLE immich_fork.migration_audit (name text, status text)',
      'CREATE TABLE immich_fork.backfill_progress (kind varchar(32) PRIMARY KEY, cursor text, "claimToken" text)',
      'CREATE TABLE immich_fork.asset_storage_reservation ("assetId" uuid, status text)',
      'CREATE TABLE immich_fork.asset_checksum ("assetId" uuid PRIMARY KEY, sha1 bytea, sha256 bytea, "sizeInBytes" bigint, "verifiedPaths" text[], "linkCount" integer, evidence jsonb, "verifiedAt" timestamptz, "updatedAt" timestamptz)',
      'CREATE TABLE immich_fork.physical_file (id uuid PRIMARY KEY, "canonicalAssetId" uuid, type text, checksum bytea, "sizeInBytes" bigint, "canonicalPath" text UNIQUE, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL)',
      'CREATE TABLE immich_fork.asset_physical_file ("assetId" uuid PRIMARY KEY, "physicalFileId" uuid, "upstreamPath" text, "verifiedAt" timestamptz, "updatedAt" timestamptz)',
      `CREATE TABLE public.asset_health (id uuid PRIMARY KEY, "assetId" uuid, "runId" uuid, category text, status text, severity text,
        "originalPath" text, "originalFileName" text, evidence jsonb DEFAULT '{}', resolution jsonb DEFAULT '{}', "checkedAt" timestamptz, "resolvedAt" timestamptz, "dismissedAt" timestamptz)`,
      'CREATE TABLE immich_fork.asset_health (LIKE public.asset_health INCLUDING ALL)',
      `CREATE TABLE public.asset_health_candidate (id uuid PRIMARY KEY, "healthId" uuid, "candidatePath" text, status text, resolution jsonb DEFAULT '{}')`,
      'CREATE TABLE immich_fork.asset_health_candidate (LIKE public.asset_health_candidate INCLUDING ALL)',
    ]) {
      await sql.raw(statement).execute(db);
    }
  });
  const arrange = async (external = true): Promise<RelinkExternalAsset> => {
    const input: RelinkExternalAsset = {
      assetId: randomUUID(),
      ownerId: randomUUID(),
      candidateId: randomUUID(),
      healthId: randomUUID(),
      expectedUpdateId: randomUUID(),
      expectedChecksumAlgorithm: ChecksumAlgorithm.sha1File,
      expectedLibraryId: randomUUID(),
      expectedOriginalPath: '/old/missing.jpg',
      originalPath: '/new/renamed.jpg',
      originalFileName: 'original.jpg',
      expectedChecksum: Buffer.alloc(20, 1),
      sha1: Buffer.alloc(20, 1),
      sha256: Buffer.alloc(32, 2),
      sizeInBytes: 100,
      fileModifiedAt: new Date(),
      verifyCandidate: vi
        .fn()
        .mockResolvedValue({ sha1: Buffer.alloc(20, 1), sha256: Buffer.alloc(32, 2), sizeInBytes: 100 }),
    };
    await sql`INSERT INTO public.user VALUES (${input.ownerId}::uuid)`.execute(db);
    await sql`INSERT INTO public.asset (id,"ownerId","updateId","originalPath","originalFileName",checksum,"checksumAlgorithm","isExternal","libraryId")
      VALUES (${input.assetId}::uuid,${input.ownerId}::uuid,${input.expectedUpdateId}::uuid,${input.expectedOriginalPath},'original.jpg',${input.sha1},'sha1',${external},${external ? input.expectedLibraryId : null}::uuid)`.execute(
      db,
    );
    for (const schema of ['public', 'immich_fork']) {
      await sql`INSERT INTO ${sql.id(schema, 'asset_health')} (id,"assetId",category,status,"originalPath",resolution)
        VALUES (${input.healthId}::uuid,${input.assetId}::uuid,'missing','found',${input.expectedOriginalPath},'{"autoRelinkable":true}')`.execute(
        db,
      );
      await sql`INSERT INTO ${sql.id(schema, 'asset_health_candidate')} (id,"healthId","candidatePath",status,resolution)
        VALUES (${input.candidateId}::uuid,${input.healthId}::uuid,${input.originalPath},'found','{"autoRelinkable":true}')`.execute(
        db,
      );
    }
    return input;
  };
  it('commits external path, content evidence, and resolution together', async () => {
    const input = await arrange();
    expect(await sut.relinkExternalAsset(input)).toBe(true);
    expect(
      await db
        .selectFrom('asset')
        .select(['originalPath', 'status', 'deletedAt'])
        .where('id', '=', input.assetId)
        .executeTakeFirst(),
    ).toEqual({ originalPath: input.originalPath, status: 'active', deletedAt: null });
    for (const schema of ['public', 'immich_fork']) {
      expect(
        (
          await sql<{
            status: string;
          }>`SELECT status FROM ${sql.id(schema, 'asset_health')} WHERE id=${input.healthId}::uuid`.execute(db)
        ).rows[0].status,
      ).toBe('relinked');
    }
    expect(
      (
        await sql<{
          sha256: Buffer;
        }>`SELECT sha256 FROM immich_fork.asset_checksum WHERE "assetId"=${input.assetId}::uuid`.execute(db)
      ).rows[0].sha256,
    ).toEqual(input.sha256);
  });
  it.each(['owner', 'generation', 'path', 'checksum', 'algorithm', 'library', 'trashed', 'finding', 'candidate'])(
    'rejects stale external %s',
    async (change) => {
      const input = await arrange();
      switch (change) {
        case 'owner': {
          input.ownerId = randomUUID();
          await sql`INSERT INTO public.user VALUES (${input.ownerId}::uuid)`.execute(db);

          break;
        }
        case 'generation': {
          await sql`UPDATE public.asset SET "updateId"=gen_random_uuid()`.execute(db);

          break;
        }
        case 'path': {
          await sql`UPDATE public.asset SET "originalPath"='/already/repaired.jpg'`.execute(db);

          break;
        }
        case 'checksum': {
          await sql`UPDATE public.asset SET checksum=${Buffer.alloc(20, 9)}`.execute(db);

          break;
        }
        case 'algorithm': {
          await sql`UPDATE public.asset SET "checksumAlgorithm"='sha1-path'`.execute(db);

          break;
        }
        case 'library': {
          await sql`UPDATE public.asset SET "libraryId"=gen_random_uuid()`.execute(db);

          break;
        }
        case 'trashed': {
          await sql`UPDATE public.asset SET status='trashed',"deletedAt"=now()`.execute(db);

          break;
        }
        case 'finding': {
          await sql`UPDATE public.asset_health SET status='dismissed',"dismissedAt"=now()`.execute(db);

          break;
        }
        case 'candidate': {
          await sql`UPDATE public.asset_health_candidate SET "candidatePath"='/different.jpg'`.execute(db);

          break;
        }
        // No default
      }
      expect(await sut.relinkExternalAsset(input)).toBe(false);
      expect(input.verifyCandidate).not.toHaveBeenCalled();
      expect(
        (await db.selectFrom('asset').select('originalPath').where('id', '=', input.assetId).executeTakeFirst())
          ?.originalPath,
      ).not.toBe(input.originalPath);
    },
  );
  it('rejects inconsistent dual sidecar evidence for a path-checksum asset', async () => {
    const input = await arrange();
    input.expectedChecksumAlgorithm = ChecksumAlgorithm.sha1Path;
    await sql`UPDATE public.asset SET "checksumAlgorithm" = 'sha1-path'`.execute(db);
    await sql`INSERT INTO immich_fork.asset_checksum ("assetId", sha1, sha256, "sizeInBytes")
      VALUES (${input.assetId}::uuid, ${Buffer.alloc(20, 9)}, ${input.sha256}, 100)`.execute(db);
    expect(await sut.relinkExternalAsset(input)).toBe(false);
    expect(input.verifyCandidate).not.toHaveBeenCalled();
  });
  it('waits for concurrent trash and never restores its lifecycle', async () => {
    const input = await arrange();
    const { promise: held, resolve: locked } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const trash = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM public.asset WHERE id = ${input.assetId}::uuid FOR UPDATE`.execute(trx);
      locked();
      await released;
      await sql`UPDATE public.asset SET status = 'trashed', "deletedAt" = now() WHERE id = ${input.assetId}::uuid`.execute(
        trx,
      );
    });
    await held;
    const relink = sut.relinkExternalAsset(input);
    release();
    await trash;
    expect(await relink).toBe(false);
    expect(
      (await db.selectFrom('asset').select('status').where('id', '=', input.assetId).executeTakeFirst())?.status,
    ).toBe('trashed');
  });
  it('declines a candidate whose bytes change under the final verification callback', async () => {
    const input = await arrange();
    input.verifyCandidate = vi.fn().mockResolvedValue(undefined);
    expect(await sut.relinkExternalAsset(input)).toBe(false);
    expect(input.verifyCandidate).toHaveBeenCalledOnce();
    expect((await sql`SELECT 1 FROM immich_fork.asset_checksum`.execute(db)).rows).toHaveLength(0);
  });
  it.each(['reserved', 'handoff'])('blocks managed relink during %s', async (kind) => {
    const { expectedLibraryId: _, ...input } = await arrange(false);
    if (kind === 'reserved') {
      await sql`INSERT INTO immich_fork.asset_storage_reservation VALUES (${input.assetId}::uuid,'reserved')`.execute(
        db,
      );
    } else {
      await sql`INSERT INTO immich_fork.migration_audit VALUES ('official-handoff-preparation','running')`.execute(db);
    }
    expect(await sut.relinkManagedAsset(input)).toBe(false);
  });
  it('relinks in active phase after public physical storage has been removed', async () => {
    const { expectedLibraryId: _, ...input } = await arrange(false);
    await sql`UPDATE immich_fork.state SET phase='active'`.execute(db);
    await sql`ALTER TABLE public.asset DROP COLUMN "physicalOriginalFileId"`.execute(db);
    await sql`DROP TABLE public.physical_file`.execute(db);
    expect(await sut.relinkManagedAsset(input)).toBe(true);
    expect(
      (
        await sql<{
          canonicalPath: string;
          createdAt: Date;
          updatedAt: Date;
        }>`SELECT p."canonicalPath", p."createdAt", p."updatedAt" FROM immich_fork.asset_physical_file m JOIN immich_fork.physical_file p ON p.id=m."physicalFileId" WHERE m."assetId"=${input.assetId}::uuid`.execute(
          db,
        )
      ).rows[0],
    ).toEqual({ canonicalPath: input.originalPath, createdAt: expect.any(Date), updatedAt: expect.any(Date) });
    expect((await sql<{ status: string }>`SELECT status FROM public.asset_health`.execute(db)).rows[0].status).toBe(
      'found',
    );
  });
  // FL-69: a new install stays in the legacy phase until the fork backfill runs; Library Care still relinks
  it('relinks an external original in the legacy phase, writing only the legacy finding', async () => {
    const input = await arrange();
    await sql`UPDATE immich_fork.state SET phase='legacy'`.execute(db);
    expect(await sut.relinkExternalAsset(input)).toBe(true);
    expect(
      await db.selectFrom('asset').select('originalPath').where('id', '=', input.assetId).executeTakeFirst(),
    ).toEqual({ originalPath: input.originalPath });
    const status = async (schema: string) =>
      (
        await sql<{
          status: string;
        }>`SELECT status FROM ${sql.id(schema, 'asset_health')} WHERE id=${input.healthId}::uuid`.execute(db)
      ).rows[0].status;
    expect(await status('public')).toBe('relinked');
    expect(await status('immich_fork')).toBe('found');
  });
  it('relinks a managed original in the legacy phase without writing the fork physical mapping', async () => {
    const { expectedLibraryId: _, ...input } = await arrange(false);
    await sql`UPDATE immich_fork.state SET phase='legacy'`.execute(db);
    expect(await sut.relinkManagedAsset(input)).toBe(true);
    const physical = await sql<{
      id: string;
      path: string;
    }>`SELECT id, path FROM public.physical_file WHERE path=${input.originalPath}`.execute(db);
    expect(physical.rows).toEqual([{ id: expect.any(String), path: input.originalPath }]);
    expect(
      await db
        .selectFrom('asset')
        .select(['originalPath', 'checksum', 'checksumAlgorithm', 'physicalOriginalFileId'])
        .where('id', '=', input.assetId)
        .executeTakeFirst(),
    ).toEqual({
      originalPath: input.originalPath,
      checksum: input.sha256,
      checksumAlgorithm: 'sha256',
      physicalOriginalFileId: physical.rows[0].id,
    });
    expect(
      (
        await sql<{
          sha1: Buffer;
          sha256: Buffer;
          evidence: { source: string };
        }>`SELECT sha1, sha256, evidence FROM immich_fork.asset_checksum WHERE "assetId"=${input.assetId}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ sha1: input.sha1, sha256: input.sha256, evidence: { source: 'recovery' } }]);
    for (const table of ['physical_file', 'asset_physical_file']) {
      expect((await sql`SELECT 1 FROM ${sql.id('immich_fork', table)}`.execute(db)).rows).toEqual([]);
    }
  });
  it('refuses a legacy-phase relink once a storage or checksum backfill has started', async () => {
    const { expectedLibraryId: _, ...input } = await arrange(false);
    // a paused backfill: its cursor would resume past this asset and never write its new mapping
    await sql`INSERT INTO immich_fork.backfill_progress (kind, cursor) VALUES ('storage', ${input.assetId})`.execute(
      db,
    );
    await sql`UPDATE immich_fork.state SET phase='legacy'`.execute(db);
    expect(await sut.relinkManagedAsset(input)).toBe(false);
    expect(
      await db.selectFrom('asset').select('originalPath').where('id', '=', input.assetId).executeTakeFirst(),
    ).toEqual({ originalPath: input.expectedOriginalPath });
  });
  it('refuses a relink when there is no fork schema', async () => {
    const input = await arrange();
    await sql`DROP TABLE immich_fork.state`.execute(db);
    expect(await sut.relinkExternalAsset(input)).toBe(false);
  });
  it.each(['inactive', 'failed'])('refuses a relink in the %s phase', async (phase) => {
    const input = await arrange();
    await sql`UPDATE immich_fork.state SET phase=${phase}`.execute(db);
    expect(await sut.relinkExternalAsset(input)).toBe(false);
  });
  it.each(['dual-write', 'active'])(
    'reuses a SHA-1 physical row without replacing its metadata in %s',
    async (phase) => {
      const { expectedLibraryId: _, ...input } = await arrange(false);
      const physicalId = randomUUID();
      const sharedId = randomUUID();
      await sql`INSERT INTO public.asset (id, "ownerId", "originalPath", checksum, "checksumAlgorithm", "isExternal", "libraryId", "physicalOriginalFileId")
      VALUES (${sharedId}::uuid, ${input.ownerId}::uuid, ${input.originalPath}, ${input.sha1}, 'sha1', false, NULL, ${physicalId}::uuid)`.execute(
        db,
      );
      await sql`INSERT INTO public.physical_file VALUES (${physicalId}::uuid, ${sharedId}::uuid, ${input.sha1}, ${input.originalPath}, 100, 'original')`.execute(
        db,
      );
      await sql`INSERT INTO immich_fork.physical_file VALUES (${physicalId}::uuid, ${sharedId}::uuid, 'original', ${input.sha1}, 100, ${input.originalPath}, now(), now())`.execute(
        db,
      );
      await sql`INSERT INTO immich_fork.asset_physical_file VALUES (${sharedId}::uuid, ${physicalId}::uuid, ${input.originalPath}, now(), now())`.execute(
        db,
      );
      await sql`UPDATE immich_fork.state SET phase = ${phase}`.execute(db);
      if (phase === 'active') {
        await sql`ALTER TABLE public.asset DROP COLUMN "physicalOriginalFileId"`.execute(db);
        await sql`DROP TABLE public.physical_file`.execute(db);
      }
      expect(await sut.relinkManagedAsset(input)).toBe(true);
      const rows = await sql<{ physicalFileId: string; canonicalAssetId: string; checksum: Buffer }>`
      SELECT m."physicalFileId", p."canonicalAssetId", p.checksum FROM immich_fork.asset_physical_file m
      JOIN immich_fork.physical_file p ON p.id=m."physicalFileId" WHERE m."assetId"=${input.assetId}::uuid`.execute(db);
      expect(rows.rows[0]).toEqual({ physicalFileId: physicalId, canonicalAssetId: sharedId, checksum: input.sha1 });
      if (phase === 'dual-write') {
        expect(
          (await db.selectFrom('physical_file').select('checksum').where('id', '=', physicalId).executeTakeFirst())
            ?.checksum,
        ).toEqual(input.sha1);
      }
    },
  );
  it('preserves shared physical bytes and transfers old canonical ownership', async () => {
    const { expectedLibraryId: _, ...input } = await arrange(false);
    const shared = randomUUID();
    const physical = randomUUID();
    await sql`INSERT INTO public.asset SELECT ${shared}::uuid,"ownerId",gen_random_uuid(),"originalPath","originalFileName",checksum,"checksumAlgorithm","isExternal","libraryId","deletedAt",status,"isOffline",${physical}::uuid,"fileModifiedAt" FROM public.asset WHERE id=${input.assetId}::uuid`.execute(
      db,
    );
    await sql`UPDATE public.asset SET "physicalOriginalFileId"=${physical}::uuid WHERE id=${input.assetId}::uuid`.execute(
      db,
    );
    await sql`INSERT INTO public.physical_file VALUES (${physical}::uuid,${input.assetId}::uuid,${input.sha256},${input.expectedOriginalPath},100,'original')`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.physical_file VALUES (${physical}::uuid,${input.assetId}::uuid,'original',${input.sha256},100,${input.expectedOriginalPath},now(),now())`.execute(
      db,
    );
    for (const id of [input.assetId, shared]) {
      await sql`INSERT INTO immich_fork.asset_physical_file VALUES (${id}::uuid,${physical}::uuid,${input.expectedOriginalPath},now(),now())`.execute(
        db,
      );
    }
    expect(await sut.relinkManagedAsset(input)).toBe(true);
    for (const schema of ['public', 'immich_fork']) {
      expect(
        (
          await sql<{
            canonicalAssetId: string;
            checksum: Buffer;
          }>`SELECT "canonicalAssetId",checksum FROM ${sql.id(schema, 'physical_file')} WHERE id=${physical}::uuid`.execute(
            db,
          )
        ).rows[0],
      ).toEqual({ canonicalAssetId: shared, checksum: input.sha256 });
    }
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', shared).executeTakeFirst())?.originalPath,
    ).toBe(input.expectedOriginalPath);
  });
});
