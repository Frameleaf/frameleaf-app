import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AssetStatus,
  AssetType,
  JobName,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
} from 'src/enum.js';
import * as migration from 'src/fork-schema/migrations/0000000000090-ICloudSync.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import {
  MediaRecoveryRepository,
  RecoveryAuthority,
  VerifiedMedia,
} from 'src/repositories/media-recovery.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DB } from 'src/schema/index.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaRecoveryService } from 'src/services/media-recovery.service.js';
import { getKyselyDB } from 'test/utils.js';

// Real PostgreSQL locks/constraints with a focused schema, independent of unrelated ML extensions.
describe(MediaRecoveryRepository.name, () => {
  let db: Kysely<DB>;
  let sut: MediaRecoveryRepository;
  let health: MediaHealthRepository;
  const bytes = Buffer.from('complete original');
  const verified: VerifiedMedia = {
    status: 'healthy',
    reason: 'verified',
    sha1: createHash('sha1').update(bytes).digest(),
    sha256: createHash('sha256').update(bytes).digest(),
    sizeInBytes: bytes.length,
    identity: { dev: 1, ino: 2, size: bytes.length, mtimeMs: 3, ctimeMs: 4 },
  };
  beforeAll(async () => {
    db = await getKyselyDB();
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`DROP SCHEMA IF EXISTS immich_fork CASCADE`.execute(db);
    const statements = [
      'CREATE SCHEMA public',
      'CREATE SCHEMA immich_fork',
      'CREATE TABLE public.migration_overrides (name text)',
      'CREATE TABLE public.user (id uuid PRIMARY KEY, "quotaUsageInBytes" bigint DEFAULT 0, "quotaSizeInBytes" bigint)',
      `CREATE TABLE public.asset (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid REFERENCES public.user,
        "updateId" uuid DEFAULT gen_random_uuid(), "originalPath" text, "originalFileName" text, checksum bytea,
        "checksumAlgorithm" text, type text, "isExternal" boolean DEFAULT false, "libraryId" uuid, "deletedAt" timestamptz,
        status text DEFAULT 'active', "isOffline" boolean DEFAULT false, visibility text DEFAULT 'timeline',
        is_nsfw boolean DEFAULT false, "physicalOriginalFileId" uuid, "fileCreatedAt" timestamptz DEFAULT now(),
        "fileModifiedAt" timestamptz DEFAULT now(), "localDateTime" timestamptz DEFAULT now(), "isFavorite" boolean DEFAULT false)`,
      'CREATE UNIQUE INDEX asset_checksum_idx ON public.asset ("ownerId", checksum) WHERE "libraryId" IS NULL',
      `CREATE FUNCTION public.bump_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."updateId" = gen_random_uuid(); RETURN NEW; END $$`,
      'CREATE TRIGGER generation BEFORE UPDATE ON public.asset FOR EACH ROW EXECUTE FUNCTION public.bump_generation()',
      'CREATE TABLE public.asset_exif ("assetId" uuid PRIMARY KEY REFERENCES public.asset, "fileSizeInByte" bigint)',
      `CREATE TABLE public.asset_lock ("assetId" uuid PRIMARY KEY REFERENCES public.asset ON DELETE CASCADE,
        reason text NOT NULL, "lockedAt" timestamptz NOT NULL DEFAULT now(), "lockedBy" uuid, "previousVisibility" text)`,
      'CREATE TABLE public.user_metadata ("userId" uuid, key text, value jsonb)',
      'CREATE TABLE public.asset_metadata ("assetId" uuid, key text, value jsonb)',
      'CREATE TABLE public.album_asset ("assetId" uuid, "albumId" uuid)',
      'CREATE TABLE public.physical_file (id uuid PRIMARY KEY, "canonicalAssetId" uuid REFERENCES public.asset, checksum bytea, path text UNIQUE, "sizeInBytes" bigint, type text)',
      'ALTER TABLE public.asset ADD FOREIGN KEY ("physicalOriginalFileId") REFERENCES public.physical_file',
      'CREATE TABLE immich_fork.state (id integer PRIMARY KEY, phase text)',
      "INSERT INTO immich_fork.state VALUES (1, 'dual-write')",
      'CREATE TABLE immich_fork.migration_audit (name text, status text)',
      'CREATE TABLE immich_fork.asset_storage_reservation ("assetId" uuid, status text)',
      'CREATE TABLE immich_fork.asset_privacy ("assetId" uuid PRIMARY KEY, "isNsfw" boolean, suppression jsonb, "updatedAt" timestamptz)',
      'CREATE TABLE immich_fork.asset_enrichment ("assetId" uuid PRIMARY KEY)',
      'CREATE TABLE immich_fork.asset_checksum ("assetId" uuid PRIMARY KEY, sha1 bytea, sha256 bytea, "sizeInBytes" bigint, "verifiedPaths" text[], "linkCount" integer, evidence jsonb, "verifiedAt" timestamptz, "updatedAt" timestamptz)',
      'CREATE TABLE immich_fork.physical_file (id uuid PRIMARY KEY, "canonicalAssetId" uuid, type text, checksum bytea, "sizeInBytes" bigint, "canonicalPath" text UNIQUE, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL)',
      'CREATE TABLE immich_fork.asset_physical_file ("assetId" uuid PRIMARY KEY, "physicalFileId" uuid, "upstreamPath" text, "verifiedAt" timestamptz, "updatedAt" timestamptz)',
      `CREATE TABLE public.asset_health (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "assetId" uuid, "runId" uuid, category text,
        status text, severity text, "originalPath" text, "originalFileName" text, evidence jsonb DEFAULT '{}', resolution jsonb DEFAULT '{}',
        "checkedAt" timestamptz, "resolvedAt" timestamptz, "dismissedAt" timestamptz, "createdAt" timestamptz DEFAULT now(),
        "updatedAt" timestamptz DEFAULT now(), UNIQUE("assetId", category))`,
      'CREATE TABLE immich_fork.asset_health (LIKE public.asset_health INCLUDING ALL)',
      'CREATE TABLE public.asset_health_candidate (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "healthId" uuid, status text, resolution jsonb DEFAULT \'{}\')',
      'CREATE TABLE immich_fork.asset_health_candidate (LIKE public.asset_health_candidate INCLUDING ALL)',
    ];
    for (const statement of statements) {
      await sql.raw(statement).execute(db);
    }
    await migration.up(db);
    sut = new MediaRecoveryRepository(db, new ForkPrivacyRepository(db), new ForkEnrichmentRepository(db));
    health = new MediaHealthRepository(db);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const arrange = async (existing = true) => {
    const ownerId = randomUUID();
    const assetId = randomUUID();
    const connectionId = randomUUID();
    const resourceId = randomUUID();
    const leaseToken = randomUUID();
    const albumId = randomUUID();
    await sql`INSERT INTO public.user (id, "quotaUsageInBytes") VALUES (${ownerId}::uuid, ${existing ? bytes.length : 0})`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.icloud_connection (id, "ownerId", label, state) VALUES (${connectionId}::uuid, ${ownerId}::uuid, 'Photos', 'connected')`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.icloud_resource (id, "connectionId", "ownerId", "libraryKey", library, "sourceAssetId", "recordId",
      "resourceKey", role, fingerprint, source, "expectedSize", "stagingPath", "leaseToken", "leaseExpiresAt")
      VALUES (${resourceId}::uuid, ${connectionId}::uuid, ${ownerId}::uuid, 'private', '{}', 'source', 'record', 'original', 'original', 'v1', '{}',
        ${bytes.length}, '/stage/good.jpg', ${leaseToken}::uuid, now() + interval '1 hour')`.execute(db);
    if (existing) {
      await sql`INSERT INTO public.asset (id, "ownerId", "originalPath", "originalFileName", checksum, "checksumAlgorithm", type, "isOffline", "isFavorite")
        VALUES (${assetId}::uuid, ${ownerId}::uuid, '/managed/missing.jpg', 'original.jpg', ${verified.sha1}, 'sha1', 'IMAGE', true, true)`.execute(
        db,
      );
      await sql`INSERT INTO public.asset_exif VALUES (${assetId}::uuid, ${bytes.length})`.execute(db);
      await sql`INSERT INTO public.album_asset VALUES (${assetId}::uuid, ${albumId}::uuid)`.execute(db);
      await sql`INSERT INTO immich_fork.asset_privacy ("assetId", "isNsfw") VALUES (${assetId}::uuid, false)`.execute(
        db,
      );
      for (const schema of ['public', 'immich_fork']) {
        await sql`INSERT INTO ${sql.id(schema, 'asset_health')} ("assetId", category, status, severity, "originalPath", "originalFileName", "dismissedAt", "checkedAt", evidence)
          VALUES (${assetId}::uuid, 'missing', 'dismissed', 'critical', '/managed/missing.jpg', 'original.jpg', now(), now(), '{"reason":"original_missing"}')`.execute(
          db,
        );
      }
    }
    const authority: RecoveryAuthority = {
      resourceId,
      leaseToken,
      ownerId,
      includeHidden: false,
    };
    const candidate = (await sut.findCandidates(ownerId, verified))[0];
    const reserveInput = {
      ...authority,
      verified,
      candidate,
      outcome: existing ? ('repaired-missing' as const) : ('imported' as const),
      proposedPath: `/managed/.icloud-recovery/${resourceId}.jpg`,
    };
    const reservation = await sut.reserve(reserveInput);
    if (!reservation) {
      throw new Error('fixture_reservation_failed');
    }
    expect((await sut.getResource(authority))?.expectedTarget).toEqual(reservation.target);
    const commitInput = {
      ...authority,
      reservation,
      verified,
      originalFileName: 'source.jpg',
      type: AssetType.Image,
      sourceCreatedAt: new Date('2020-02-03T04:05:06Z'),
      verifyFinal: vi.fn().mockResolvedValue(verified),
    };
    return { authority, candidate, reservation, commitInput, reserveInput, assetId, albumId };
  };

  it.each(['dual-write', 'active'])(
    'repairs same ID, associations, dismissed history and outbox in %s',
    async (phase) => {
      await sql`UPDATE immich_fork.state SET phase = ${phase}`.execute(db);
      const context = await arrange();
      expect(await sut.commit(context.commitInput)).toEqual({ outcome: 'repaired-missing', assetId: context.assetId });
      expect(
        (
          await sql`SELECT "createdAt", "updatedAt" FROM immich_fork.physical_file WHERE "canonicalAssetId" = ${context.assetId}::uuid`.execute(
            db,
          )
        ).rows,
      ).toEqual([{ createdAt: expect.any(Date), updatedAt: expect.any(Date) }]);
      expect(
        await db.selectFrom('asset').selectAll().where('id', '=', context.assetId).executeTakeFirst(),
      ).toMatchObject({
        id: context.assetId,
        originalPath: context.reservation.promotedPath,
        isFavorite: true,
        isOffline: false,
        checksum: verified.sha256,
        checksumAlgorithm: 'sha256',
      });
      expect(
        (
          await sql`SELECT 1 FROM public.album_asset WHERE "assetId" = ${context.assetId}::uuid AND "albumId" = ${context.albumId}::uuid`.execute(
            db,
          )
        ).rows,
      ).toHaveLength(1);
      const finding = (
        await sql<{
          status: string;
          resolvedAt: Date;
          resolution: object;
        }>`SELECT * FROM immich_fork.asset_health WHERE "assetId" = ${context.assetId}::uuid`.execute(db)
      ).rows[0];
      expect(finding).toMatchObject({
        status: 'resolved',
        resolution: { previousPath: '/managed/missing.jpg', previousEvidence: { reason: 'original_missing' } },
      });
      expect(finding.resolvedAt).not.toBeNull();
      const resource = (
        await sql<{
          status: string;
          pendingJobs: unknown[];
        }>`SELECT * FROM immich_fork.icloud_resource WHERE id = ${context.authority.resourceId}::uuid`.execute(db)
      ).rows[0];
      expect(resource.status).toBe('committed');
      expect(resource.pendingJobs).toEqual([
        { name: JobName.AssetExtractMetadata, data: { id: context.assetId, source: 'upload' } },
        { name: JobName.AssetGenerateThumbnails, data: { id: context.assetId, source: 'upload' } },
      ]);
      expect(await sut.commit(context.commitInput)).toMatchObject({ outcome: 'reused', assetId: context.assetId });
      expect(
        Number(
          (
            await db
              .selectFrom('user')
              .select('quotaUsageInBytes')
              .where('id', '=', context.authority.ownerId)
              .executeTakeFirstOrThrow()
          ).quotaUsageInBytes,
        ),
      ).toBe(bytes.length);
    },
  );
  it('imports once with canonical privacy/enrichment and quota bookkeeping', async () => {
    const { commitInput, authority } = await arrange(false);
    const result = await sut.commit(commitInput);
    expect(result.outcome).toBe('imported');
    expect(
      (await sql`SELECT 1 FROM immich_fork.asset_privacy WHERE "assetId" = ${result.assetId}::uuid`.execute(db)).rows,
    ).toHaveLength(1);
    expect(
      (await sql`SELECT 1 FROM immich_fork.asset_enrichment WHERE "assetId" = ${result.assetId}::uuid`.execute(db))
        .rows,
    ).toHaveLength(1);
    expect(await sut.commit(commitInput)).toMatchObject({ outcome: 'reused', assetId: result.assetId });
    expect(
      Number(
        (
          await db
            .selectFrom('user')
            .select('quotaUsageInBytes')
            .where('id', '=', authority.ownerId)
            .executeTakeFirstOrThrow()
        ).quotaUsageInBytes,
      ),
    ).toBe(bytes.length);
  });
  it('leaves findings and original state active when final verification fails', async () => {
    const { commitInput, assetId } = await arrange();
    expect(
      await sut.commit({
        ...commitInput,
        verifyFinal: vi.fn().mockResolvedValue({ status: 'corrupt', reason: 'expected_mismatch' }),
      }),
    ).toMatchObject({ outcome: 'retry' });
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', assetId).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe('/managed/missing.jpg');
    expect(
      (
        await sql<{
          status: string;
        }>`SELECT status FROM immich_fork.asset_health WHERE "assetId" = ${assetId}::uuid`.execute(db)
      ).rows[0].status,
    ).toBe('dismissed');
  });
  it('rejects stale generation and lease', async () => {
    const first = await arrange();
    await db.updateTable('asset').set({ isFavorite: false }).where('id', '=', first.assetId).execute();
    expect(await sut.commit(first.commitInput)).toMatchObject({ outcome: 'retry', reason: 'target_changed' });
    const second = await arrange();
    await sql`UPDATE immich_fork.icloud_resource SET "leaseToken" = ${randomUUID()}::uuid WHERE id = ${second.authority.resourceId}::uuid`.execute(
      db,
    );
    expect(await sut.commit(second.commitInput)).toMatchObject({ outcome: 'retry', reason: 'lease_changed' });
  });

  it('refreshes the reserved generation after an unrelated favorite change', async () => {
    const context = await arrange();
    await db.updateTable('asset').set({ isFavorite: false }).where('id', '=', context.assetId).execute();
    expect(await sut.commit(context.commitInput)).toMatchObject({ outcome: 'retry', reason: 'target_changed' });
    const fresh = (await sut.findCandidates(context.authority.ownerId, verified))[0];
    const next = await sut.reserve({ ...context.reserveInput, candidate: fresh });
    expect(next).toBeDefined();
    expect(next!.promotedPath).toBe(context.reservation.promotedPath);
    expect(await sut.commit({ ...context.commitInput, reservation: next! })).toMatchObject({
      outcome: 'repaired-missing',
      assetId: context.assetId,
    });
    expect(
      await db.selectFrom('asset').select('isFavorite').where('id', '=', context.assetId).executeTakeFirst(),
    ).toEqual({ isFavorite: false });
  });
  it.each(['sha1', 'sha256'])(
    'rejects sidecar bytes contradicting the saved %s content checksum',
    async (algorithm) => {
      const context = await arrange();
      await sql`UPDATE public.asset SET checksum = ${algorithm === 'sha1' ? verified.sha1 : verified.sha256}, "checksumAlgorithm" = ${algorithm} WHERE id = ${context.assetId}::uuid`.execute(
        db,
      );
      const wrong = Buffer.from('different complete original');
      const other = {
        ...verified,
        sha1: createHash('sha1').update(wrong).digest(),
        sha256: createHash('sha256').update(wrong).digest(),
        sizeInBytes: wrong.length,
      };
      await sql`INSERT INTO immich_fork.asset_checksum ("assetId", sha1, sha256) VALUES (${context.assetId}::uuid, ${other.sha1}, ${other.sha256})`.execute(
        db,
      );
      const candidate = (await sut.findCandidates(context.authority.ownerId, other))[0];
      expect(candidate).toBeDefined();
      expect(candidate.identityConflict).toBe(true);
      expect(candidate.matchesContent).toBe(false);
      const expected = (await sut.findCandidates(context.authority.ownerId, verified))[0];
      expect(expected).toMatchObject({ matchesContent: true, identityConflict: false });
    },
  );
  it('uses matching sidecar content digests for an external path checksum', async () => {
    const context = await arrange();
    await sql`UPDATE public.asset SET "checksumAlgorithm" = 'sha1-path', checksum = ${Buffer.alloc(20)} WHERE id = ${context.assetId}::uuid`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.asset_checksum ("assetId", sha1, sha256) VALUES (${context.assetId}::uuid, ${verified.sha1}, ${verified.sha256})`.execute(
      db,
    );
    expect((await sut.findCandidates(context.authority.ownerId, verified))[0]).toMatchObject({
      matchesContent: true,
      identityConflict: false,
    });
    await sql`UPDATE immich_fork.asset_checksum SET sha256 = ${Buffer.alloc(32)} WHERE "assetId" = ${context.assetId}::uuid`.execute(
      db,
    );
    expect((await sut.findCandidates(context.authority.ownerId, verified))[0]).toMatchObject({
      matchesContent: false,
      identityConflict: true,
    });
  });

  it('retains staged and promoted bytes for review when an upload wins an import reservation', async () => {
    const context = await arrange(false);
    const directory = await mkdtemp(join(tmpdir(), 'icloud-import-race-'));
    const stagedPath = join(directory, 'stage.jpg');
    const promotedPath = join(directory, 'promoted.jpg');
    try {
      await writeFile(stagedPath, bytes);
      await writeFile(promotedPath, bytes);
      await sql`UPDATE immich_fork.icloud_resource SET "stagingPath" = ${stagedPath}, "promotedPath" = ${promotedPath}
        WHERE id = ${context.authority.resourceId}::uuid`.execute(db);
      await sql`INSERT INTO public.asset (id, "ownerId", "originalPath", "originalFileName", checksum, "checksumAlgorithm", type)
        VALUES (${context.assetId}::uuid, ${context.authority.ownerId}::uuid, '/upload/winner.jpg', 'original.jpg', ${verified.sha256}, 'sha256', 'IMAGE')`.execute(
        db,
      );
      await sql`INSERT INTO immich_fork.asset_privacy ("assetId", "isNsfw") VALUES (${context.assetId}::uuid, false)`.execute(
        db,
      );
      const integrity = { validate: vi.fn().mockResolvedValue(verified) };
      const recovery = new MediaRecoveryService(sut, integrity as never);
      expect(
        await recovery.reconcile({
          ...context.authority,
          stagedPath,
          originalFileName: 'original.jpg',
          type: AssetType.Image,
        }),
      ).toEqual({
        outcome: 'needs-review',
        reason: 'reserved_import_content_match',
      });
      expect(
        await db.selectFrom('asset').select('id').where('ownerId', '=', context.authority.ownerId).execute(),
      ).toEqual([{ id: context.assetId }]);
      expect(await readFile(stagedPath)).toEqual(bytes);
      expect(await readFile(promotedPath)).toEqual(bytes);
      expect((await sut.getResource(context.authority))?.expectedTarget).toEqual(context.reservation.target);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects stale scans and queued trash after recovery', async () => {
    const context = await arrange();
    const stale = context.candidate;
    await sut.commit(context.commitInput);
    expect(
      await health.upsertFinding({
        assetId: stale.id,
        expectedUpdateId: stale.updateId,
        originalPath: stale.originalPath,
        originalFileName: stale.originalFileName,
        category: MediaHealthCategory.Corrupt,
        status: MediaHealthStatus.CorruptConfirmed,
        severity: MediaHealthSeverity.Critical,
        runId: null,
        evidence: {},
        resolution: {},
        checkedAt: new Date(),
      }),
    ).toBeUndefined();
    await health.markResolvedForAssets([MediaHealthCategory.Corrupt], [stale]);
    expect(await health.trashCorruptIfUnchanged({ healthId: randomUUID(), asset: stale })).toBe(false);
    expect(
      (await db.selectFrom('asset').select('status').where('id', '=', stale.id).executeTakeFirstOrThrow()).status,
    ).toBe(AssetStatus.Active);
  });
  it('never matches path checksums as content', async () => {
    const context = await arrange();
    await db
      .updateTable('asset')
      .set({ checksumAlgorithm: 'sha1-path' as never })
      .where('id', '=', context.assetId)
      .execute();
    expect(await sut.findCandidates(context.authority.ownerId, verified)).toEqual([]);
  });
  it('rejects removed tombstones and normalization reservations', async () => {
    const first = await arrange();
    await sql`UPDATE immich_fork.icloud_resource SET status = 'removed' WHERE id = ${first.authority.resourceId}::uuid`.execute(
      db,
    );
    expect(await sut.commit(first.commitInput)).toMatchObject({ outcome: 'retry', reason: 'lease_changed' });
    const second = await arrange();
    await sql`INSERT INTO immich_fork.asset_storage_reservation VALUES (${second.assetId}::uuid, 'reserved')`.execute(
      db,
    );
    expect(await sut.commit(second.commitInput)).toMatchObject({ outcome: 'retry', reason: 'target_changed' });
  });
  it('reuses a durable reservation after a promotion crash', async () => {
    const context = await arrange();
    expect(await sut.reserve({ ...context.reserveInput, proposedPath: '/different/proposal.jpg' })).toEqual(
      context.reservation,
    );
    expect(await sut.commit(context.commitInput)).toMatchObject({ outcome: 'repaired-missing' });
  });
  it('cannot both recover and commit queued corrupt trash from the same generation', async () => {
    const context = await arrange();
    const finding = await health.upsertFinding({
      assetId: context.assetId,
      originalPath: context.candidate.originalPath,
      originalFileName: 'original.jpg',
      category: MediaHealthCategory.Corrupt,
      status: MediaHealthStatus.TrashQueued,
      severity: MediaHealthSeverity.Critical,
      runId: null,
      evidence: {},
      resolution: {},
      checkedAt: new Date(),
    });
    assert.isDefined(finding);
    const [recovery, trashed] = await Promise.all([
      sut.commit(context.commitInput),
      health.trashCorruptIfUnchanged({ healthId: finding.id, asset: context.candidate }),
    ]);
    expect(recovery.outcome === 'repaired-missing' && trashed).toBe(false);
    expect(recovery.outcome === 'repaired-missing' || trashed).toBe(true);
  });
  it.each([{ pendingJobs: [] }, { pendingJobs: [{ name: 'metadataExtraction', data: { id: 'pending-asset' } }] }])(
    'commits verified reuse while retaining outbox %j for finalization',
    async ({ pendingJobs }) => {
      const context = await arrange();
      await db.updateTable('asset').set({ isOffline: false }).where('id', '=', context.assetId).execute();
      await sql`UPDATE immich_fork.icloud_resource SET "expectedTarget" = NULL, "promotedPath" = NULL WHERE id = ${context.authority.resourceId}::uuid`.execute(
        db,
      );
      const candidate = (await sut.findCandidates(context.authority.ownerId, verified))[0];
      const reservation = await sut.reserve({
        ...context.reserveInput,
        candidate,
        outcome: 'reused',
        proposedPath: candidate.originalPath,
      });
      expect(reservation).toBeDefined();
      expect(await sut.commit({ ...context.commitInput, reservation: reservation! })).toMatchObject({
        outcome: 'reused',
      });
      await sql`UPDATE immich_fork.icloud_resource SET "pendingJobs" = ${pendingJobs}::jsonb WHERE id = ${context.authority.resourceId}::uuid`.execute(
        db,
      );
      const current = (await sut.findCandidates(context.authority.ownerId, verified))[0];
      expect(
        await sut.commitVerifiedReuse({
          ...context.authority,
          candidate: current,
          verified,
          verifyFinal: vi.fn().mockResolvedValue(verified),
        }),
      ).toMatchObject({ outcome: 'reused' });
      expect(
        await db
          .selectFrom('asset')
          .select(['isExternal', 'libraryId', 'originalPath'])
          .where('id', '=', context.assetId)
          .executeTakeFirst(),
      ).toEqual({
        isExternal: false,
        libraryId: null,
        originalPath: candidate.originalPath,
      });
      expect(
        (
          await sql<{
            status: string;
            pendingJobs: unknown[];
            stagingPath: string;
          }>`SELECT status, "pendingJobs", "stagingPath" FROM immich_fork.icloud_resource WHERE id = ${context.authority.resourceId}::uuid`.execute(
            db,
          )
        ).rows[0],
      ).toEqual({ status: 'committed', pendingJobs, stagingPath: '/stage/good.jpg' });
    },
  );
  describe('an external original (owner decision, FL-69)', () => {
    const external = async () => {
      const context = await arrange();
      const libraryId = randomUUID();
      await db
        .updateTable('asset')
        .set({ isExternal: true, libraryId, isOffline: false })
        .where('id', '=', context.assetId)
        .execute();
      await sql`UPDATE immich_fork.icloud_resource SET "expectedTarget" = NULL, "promotedPath" = NULL WHERE id = ${context.authority.resourceId}::uuid`.execute(
        db,
      );
      const candidate = (await sut.findCandidates(context.authority.ownerId, verified))[0];
      const row = () => db.selectFrom('asset').selectAll().where('id', '=', context.assetId).executeTakeFirstOrThrow();
      return { context, candidate, before: await row(), row };
    };

    it('is never reused, repaired or converted', async () => {
      const { context, candidate, before, row } = await external();
      for (const outcome of ['reused', 'repaired-missing', 'imported'] as const) {
        expect(
          await sut.reserve({ ...context.reserveInput, candidate, outcome, proposedPath: candidate.originalPath }),
        ).toBeUndefined();
      }
      expect(await row()).toEqual(before);
    });

    it('stays untouched while the item is imported as a new managed asset beside it', async () => {
      const { context, candidate, before, row } = await external();
      const reservation = await sut.reserve({
        ...context.reserveInput,
        candidate: undefined,
        outcome: 'imported',
        matchedExternalAssetId: candidate.id,
      });
      expect(reservation?.target).toMatchObject({ updateId: null, matchedExternalAssetId: candidate.id });
      const result = await sut.commit({ ...context.commitInput, reservation: reservation! });
      expect(result).toEqual({ outcome: 'imported', assetId: reservation!.target.assetId });
      expect(result.assetId).not.toBe(context.assetId);

      expect(await row()).toEqual(before);
      expect(
        await db
          .selectFrom('asset')
          .select(['ownerId', 'isExternal', 'libraryId', 'originalPath', 'checksum', 'checksumAlgorithm'])
          .where('id', '=', result.assetId!)
          .executeTakeFirst(),
      ).toEqual({
        ownerId: context.authority.ownerId,
        isExternal: false,
        libraryId: null,
        originalPath: reservation!.promotedPath,
        checksum: verified.sha256,
        checksumAlgorithm: 'sha256',
      });
      const checksum = await sql<{
        evidence: { source: string };
      }>`SELECT evidence FROM immich_fork.asset_checksum WHERE "assetId" = ${result.assetId}::uuid`.execute(db);
      expect(checksum.rows[0].evidence.source).toBe('icloud-recovery');
      const resource = await sql<{
        assetId: string;
        verification: { outcome: string; matchedExternalAssetId: string };
      }>`SELECT "assetId", verification FROM immich_fork.icloud_resource WHERE id = ${context.authority.resourceId}::uuid`.execute(
        db,
      );
      expect(resource.rows[0]).toMatchObject({
        assetId: result.assetId,
        verification: { outcome: 'imported', matchedExternalAssetId: context.assetId },
      });
    });

    it('asks for consent before importing a copy of a Locked external original', async () => {
      const { context, before, row } = await external();
      await sql`INSERT INTO public.asset_lock ("assetId", reason) VALUES (${context.assetId}::uuid, 'detected')`.execute(
        db,
      );
      const directory = await mkdtemp(join(tmpdir(), 'icloud-locked-external-'));
      const stagedPath = join(directory, 'stage.jpg');
      try {
        await writeFile(stagedPath, bytes);
        await sql`UPDATE immich_fork.icloud_resource SET "stagingPath" = ${stagedPath} WHERE id = ${context.authority.resourceId}::uuid`.execute(
          db,
        );
        const integrity = { validate: vi.fn().mockResolvedValue(verified) };
        const recovery = new MediaRecoveryService(sut, integrity as never);
        expect(
          await recovery.reconcile({
            ...context.authority,
            stagedPath,
            originalFileName: 'original.jpg',
            type: AssetType.Image,
          }),
        ).toEqual({ outcome: 'needs-review', reason: 'hidden_match_requires_consent' });
        expect(
          await db.selectFrom('asset').select('id').where('ownerId', '=', context.authority.ownerId).execute(),
        ).toEqual([{ id: context.assetId }]);
        expect(await row()).toEqual(before);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it.each([
      ['Locked', 'detected'],
      ['sensitive', 'marked'],
    ])('locks the copy of a %s external original, with consent', async (kind, reason) => {
      const { context, candidate } = await external();
      if (kind === 'Locked') {
        await sql`INSERT INTO public.asset_lock ("assetId", reason) VALUES (${context.assetId}::uuid, 'detected')`.execute(
          db,
        );
      } else {
        await sql`UPDATE immich_fork.asset_privacy SET "isNsfw" = true WHERE "assetId" = ${context.assetId}::uuid`.execute(
          db,
        );
        await sql`UPDATE public.asset SET is_nsfw = true WHERE id = ${context.assetId}::uuid`.execute(db);
      }
      expect((await sut.findCandidates(context.authority.ownerId, verified))[0].hidden).toBe(true);
      const reservation = await sut.reserve({
        ...context.reserveInput,
        includeHidden: true,
        candidate: undefined,
        outcome: 'imported',
        matchedExternalAssetId: candidate.id,
      });
      const result = await sut.commit({ ...context.commitInput, includeHidden: true, reservation: reservation! });
      expect(result.outcome).toBe('imported');
      const lock = await sql<{ reason: string }>`
        SELECT reason FROM public.asset_lock WHERE "assetId" = ${result.assetId!}::uuid
      `.execute(db);
      expect(lock.rows).toEqual([{ reason }]);
    });
  });
  it('does not treat an earlier successful commit as proof that the file is still healthy', async () => {
    const context = await arrange();
    await sut.commit(context.commitInput);
    expect(
      await sut.commit({
        ...context.commitInput,
        verifyFinal: vi.fn().mockResolvedValue({ status: 'missing', reason: 'file_missing' }),
      }),
    ).toMatchObject({ outcome: 'retry', reason: 'final_verification_failed' });
  });
  it('imports source-hidden photos as locked instead of exposing them on the timeline', async () => {
    const context = await arrange(false);
    const result = await sut.commit({ ...context.commitInput, includeHidden: true, sourceHidden: true });
    expect(result.outcome).toBe('imported');
    // Locked is a lock record on a timeline asset, never a stored visibility (FL-34)
    expect(
      await db.selectFrom('asset').select('visibility').where('id', '=', result.assetId!).executeTakeFirst(),
    ).toEqual({ visibility: 'timeline' });
    const lock = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM public.asset_lock WHERE "assetId" = ${result.assetId!}::uuid
    `.execute(db);
    expect(lock.rows[0]!.count).toBe(1);
  });
  it.each(['hidden', 'locked'])(
    'distinguishes native motion visibility %s from private content',
    async (visibility) => {
      const context = await arrange();
      await sut.commit(context.commitInput);
      // Locked is a lock record (FL-34); hidden is the native motion part's visibility
      await sql`UPDATE public.asset SET visibility = ${visibility === 'locked' ? 'timeline' : visibility}, type = 'VIDEO',
        "originalFileName" = 'motion.mov' WHERE id = ${context.assetId}::uuid`.execute(db);
      if (visibility === 'locked') {
        await sql`INSERT INTO public.asset_lock ("assetId", reason) VALUES (${context.assetId}::uuid, 'marked')`.execute(
          db,
        );
      }
      const candidate = (await sut.findCandidates(context.authority.ownerId, verified))[0];
      expect(candidate.hidden).toBe(visibility === 'locked');
      const integrity = { validate: vi.fn().mockResolvedValue(verified) };
      const recovery = new MediaRecoveryService(sut, integrity as never);
      expect(await recovery.verifyMapped(context.authority)).toMatchObject(
        visibility === 'locked'
          ? { outcome: 'needs-review', reason: 'hidden_match_requires_consent' }
          : { outcome: 'reused', assetId: context.assetId },
      );
      if (visibility === 'hidden') {
        await sql`UPDATE public.asset SET "isOffline" = true WHERE id = ${context.assetId}::uuid`.execute(db);
        expect(await recovery.verifyMapped(context.authority)).toBeUndefined();
        await sql`UPDATE immich_fork.icloud_resource SET status = 'validated', "expectedTarget" = NULL, "promotedPath" = NULL
        WHERE id = ${context.authority.resourceId}::uuid`.execute(db);
        const damaged = (await sut.findCandidates(context.authority.ownerId, verified))[0];
        const reservation = await sut.reserve({
          ...context.reserveInput,
          candidate: damaged,
          proposedPath: `/managed/.icloud-recovery/${randomUUID()}.mov`,
        });
        expect(reservation).toBeDefined();
        expect(await sut.commit({ ...context.commitInput, reservation: reservation! })).toMatchObject({
          outcome: 'repaired-missing',
          assetId: context.assetId,
        });
        expect(
          await db.selectFrom('asset').select('visibility').where('id', '=', context.assetId).executeTakeFirst(),
        ).toEqual({ visibility: 'hidden' });
      } else {
        expect(integrity.validate).not.toHaveBeenCalled();
      }
    },
  );
  it('recovers a real PNG end to end and then verifies reuse without a transfer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'icloud-recovery-e2e-'));
    const paths = vi
      .spyOn(StorageCore, 'getNestedPath')
      .mockImplementation((_folder, _ownerId, filename) => join(directory, 'managed', filename));
    try {
      const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 20, g: 80, b: 160 } } })
        .png()
        .toBuffer();
      const stagedPath = join(directory, 'staged.png');
      const brokenPath = join(directory, 'broken.png');
      await writeFile(stagedPath, png);
      await writeFile(brokenPath, 'damaged PNG bytes');
      const logger = LoggingRepository.create();
      const integrity = new MediaIntegrityService(
        new StorageRepository(logger),
        new CryptoRepository(),
        new MediaRepository(logger),
      );
      const stage = await integrity.validate({
        path: stagedPath,
        originalFileName: 'original.png',
        type: AssetType.Image,
        deep: true,
      });
      expect(stage.status).toBe('healthy');
      if (stage.status !== 'healthy') {
        throw new Error('png_fixture_failed');
      }
      const context = await arrange();
      await db
        .updateTable('asset')
        .set({ checksum: stage.sha1, originalPath: brokenPath, originalFileName: 'original.png' })
        .where('id', '=', context.assetId)
        .execute();
      await db
        .updateTable('asset_exif')
        .set({ fileSizeInByte: png.length })
        .where('assetId', '=', context.assetId)
        .execute();
      await db
        .updateTable('user')
        .set({ quotaUsageInBytes: png.length })
        .where('id', '=', context.authority.ownerId)
        .execute();
      const before = await db
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', context.assetId)
        .executeTakeFirstOrThrow();
      await sql`CREATE TABLE IF NOT EXISTS public.asset_edit ("assetId" uuid PRIMARY KEY, actions jsonb)`.execute(db);
      await sql`INSERT INTO public.asset_edit VALUES (${context.assetId}::uuid, '[{"action":"rotate","parameters":{"angle":90}}]')`.execute(
        db,
      );
      await sql`UPDATE immich_fork.icloud_resource SET "expectedTarget" = NULL, "promotedPath" = NULL,
        "expectedSize" = ${png.length}, "stagingPath" = ${stagedPath}, sha1 = NULL, sha256 = NULL
        WHERE id = ${context.authority.resourceId}::uuid`.execute(db);
      for (const schema of ['public', 'immich_fork']) {
        await sql`UPDATE ${sql.id(schema, 'asset_health')} SET "originalPath" = ${brokenPath} WHERE "assetId" = ${context.assetId}::uuid`.execute(
          db,
        );
      }
      const service = new MediaRecoveryService(sut, integrity);
      const result = await service.reconcile({
        ...context.authority,
        stagedPath,
        originalFileName: 'original.png',
        type: AssetType.Image,
      });
      expect(result).toEqual({ outcome: 'repaired-corrupt', assetId: context.assetId });
      const after = await db
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', context.assetId)
        .executeTakeFirstOrThrow();
      expect(after.originalPath).not.toBe(brokenPath);
      expect(after).toMatchObject({
        isFavorite: true,
        fileCreatedAt: before.fileCreatedAt,
        fileModifiedAt: before.fileModifiedAt,
      });
      expect(await readFile(after.originalPath)).toEqual(png);
      expect(await readFile(stagedPath)).toEqual(png);
      expect(await readFile(brokenPath, 'utf8')).toBe('damaged PNG bytes');
      expect(
        await integrity.validate({
          path: after.originalPath,
          originalFileName: 'original.png',
          type: AssetType.Image,
          expected: stage,
          deep: true,
        }),
      ).toMatchObject({ status: 'healthy' });
      expect(
        (
          await sql`SELECT 1 FROM public.album_asset WHERE "assetId" = ${context.assetId}::uuid AND "albumId" = ${context.albumId}::uuid`.execute(
            db,
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await sql<{
            actions: unknown;
          }>`SELECT actions FROM public.asset_edit WHERE "assetId" = ${context.assetId}::uuid`.execute(db)
        ).rows[0].actions,
      ).toEqual([{ action: 'rotate', parameters: { angle: 90 } }]);
      expect(
        (
          await sql<{
            status: string;
          }>`SELECT status FROM immich_fork.asset_health WHERE "assetId" = ${context.assetId}::uuid`.execute(db)
        ).rows[0].status,
      ).toBe('resolved');
      expect(await service.verifyMapped(context.authority)).toEqual({ outcome: 'reused', assetId: context.assetId });
    } finally {
      paths.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('uses fork physical associations when the active schema has no public physical pointer', async () => {
    await sql`UPDATE immich_fork.state SET phase = 'active'`.execute(db);
    await sql`ALTER TABLE public.asset DROP COLUMN "physicalOriginalFileId" CASCADE`.execute(db);
    const context = await arrange();
    expect(await sut.commit(context.commitInput)).toMatchObject({ outcome: 'repaired-missing' });
    expect(
      (await sql`SELECT 1 FROM immich_fork.asset_physical_file WHERE "assetId" = ${context.assetId}::uuid`.execute(db))
        .rows,
    ).toHaveLength(1);
  });
});
