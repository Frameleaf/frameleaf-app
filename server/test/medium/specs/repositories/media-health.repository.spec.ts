import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AssetLockReason,
  AssetStatus,
  AssetVisibility,
  ChecksumAlgorithm,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository, UpsertMediaHealthFinding } from 'src/repositories/media-health.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: new MediaHealthRepository(defaultDatabase) };
};

const findingDto = (assetId: string, originalPath: string, runId: string | null): UpsertMediaHealthFinding => ({
  assetId,
  runId,
  category: MediaHealthCategory.Missing,
  status: MediaHealthStatus.Missing,
  severity: MediaHealthSeverity.Critical,
  originalPath,
  originalFileName: 'photo.jpg',
  evidence: { reason: 'stat failed' },
  resolution: {},
  checkedAt: new Date(),
});

const arrangeManagedRelink = async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const sha1 = Buffer.alloc(20, 1);
  const sha256 = Buffer.alloc(32, 2);
  const { result: asset } = await ctx.newAsset({ ownerId: user.id, checksum: sha1 });
  const run = await sut.createRun(MediaHealthCategory.Missing, user.id);
  const finding = await sut.upsertFinding({
    ...findingDto(asset.id, asset.originalPath, run.id),
    status: MediaHealthStatus.Found,
    resolution: { autoRelinkable: true },
  });
  assert.isDefined(finding);
  const recoveredPath = `/data/upload/${user.id}/recovered.jpg`;
  await sut.replaceCandidates(finding.id, [
    {
      healthId: finding.id,
      candidatePath: recoveredPath,
      status: MediaHealthStatus.Found,
      visualMatchScore: 1,
      evidence: { reason: 'checksum_match' },
      resolution: { autoRelinkable: true },
      checkedAt: new Date(),
    },
  ]);
  const [candidate] = await sut.getCandidatesByHealthIds([finding.id]);
  return { asset, candidate, finding, recoveredPath, sha1, sha256, sut, user };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(MediaHealthRepository.name, () => {
  describe('scan bookkeeping', () => {
    it('admits only one concurrent owner lookup during the cooldown, then permits another after expiry', async () => {
      const { ctx, sut } = setup();
      const [{ user }, { user: other }] = await Promise.all([ctx.newUser(), ctx.newUser()]);
      const runs = await Promise.all([
        sut.createRun(MediaHealthCategory.Missing, user.id, 60_000),
        sut.createRun(MediaHealthCategory.Missing, user.id, 60_000),
      ]);
      const admitted = runs.filter((run) => !!run);
      expect(admitted).toHaveLength(1);
      await expect(sut.createRun(MediaHealthCategory.Missing, other.id, 60_000)).resolves.toBeDefined();
      for (const schema of ['public']) {
        await defaultDatabase
          .withSchema(schema)
          .updateTable('asset_health_run')
          .set({ startedAt: new Date(Date.now() - 61_000) })
          .where('id', '=', admitted[0]!.id)
          .execute();
      }
      await expect(sut.createRun(MediaHealthCategory.Missing, user.id, 60_000)).resolves.toBeUndefined();
      await sut.finishRun(admitted[0]!.id, { status: 'completed' });
      await expect(sut.createRun(MediaHealthCategory.Missing, user.id, 60_000)).resolves.toBeDefined();
    });

    it('records continuation progress without marking a running lookup finished', async () => {
      const { sut } = setup();
      const run = await sut.createRun(MediaHealthCategory.Missing);
      await sut.finishRun(run.id, { status: 'running', finishedAt: null, checkedAssets: 1000 });
      await expect(sut.getLatestRun(MediaHealthCategory.Missing)).resolves.toMatchObject({
        id: run.id,
        status: 'running',
        finishedAt: null,
        checkedAssets: 1000,
      });
    });

    it('creates a running run and finishes it with counts and a finish time', async () => {
      const { sut } = setup();

      const run = await sut.createRun(MediaHealthCategory.Corrupt);
      await expect(sut.getLatestRun(MediaHealthCategory.Corrupt)).resolves.toMatchObject({
        id: run.id,
        status: 'running',
        finishedAt: null,
      });

      const finished = await sut.finishRun(run.id, {
        status: 'completed',
        totalAssets: 10,
        checkedAssets: 10,
        foundAssets: 2,
      });
      expect(finished).toMatchObject({ id: run.id, status: 'completed', totalAssets: 10, foundAssets: 2 });
      expect(finished?.finishedAt).not.toBeNull();
    });

    it('getLatestRun returns the most recent run per category', async () => {
      const { sut } = setup();

      const older = await sut.createRun(MediaHealthCategory.Missing);
      await sut.finishRun(older.id, { status: 'completed' });
      const newer = await sut.createRun(MediaHealthCategory.Missing);

      await expect(sut.getLatestRun(MediaHealthCategory.Missing)).resolves.toMatchObject({ id: newer.id });
    });

    it('returns an owner run even before it has findings and never substitutes an ownerless run', async () => {
      const { ctx, sut } = setup();
      const [{ user: firstUser }, { user: secondUser }] = await Promise.all([ctx.newUser(), ctx.newUser()]);
      const firstRun = await sut.createRun(MediaHealthCategory.Missing, firstUser.id);
      await sut.createRun(MediaHealthCategory.Missing, secondUser.id);
      await sut.createRun(MediaHealthCategory.Missing);

      await expect(sut.getLatestRun(MediaHealthCategory.Missing, firstUser.id)).resolves.toMatchObject({
        id: firstRun.id,
        ownerId: firstUser.id,
      });
    });
  });

  describe('finding state transitions', () => {
    it('rescans the same canonical finding without duplicating or losing its run', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const run = await sut.createRun(MediaHealthCategory.Missing, user.id);
      const first = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, run.id));
      const next = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, run.id),
        status: MediaHealthStatus.Found,
      });
      expect(next).toMatchObject({ id: first!.id, status: MediaHealthStatus.Found, runId: run.id });
      expect(await sut.getByIds([first!.id], user.id)).toHaveLength(1);
    });

    it('scopes finding reads and dismissals to one owner', async () => {
      const { ctx, sut } = setup();
      const [{ user: firstUser }, { user: secondUser }] = await Promise.all([ctx.newUser(), ctx.newUser()]);
      const [{ asset: firstAsset }, { asset: secondAsset }] = await Promise.all([
        ctx.newAsset({ ownerId: firstUser.id }),
        ctx.newAsset({ ownerId: secondUser.id }),
      ]);
      const run = await sut.createRun(MediaHealthCategory.Missing, firstUser.id);
      const [first, second] = await Promise.all([
        sut.upsertFinding(findingDto(firstAsset.id, firstAsset.originalPath, run.id)),
        sut.upsertFinding(findingDto(secondAsset.id, secondAsset.originalPath, run.id)),
      ]);

      assert.isDefined(first);
      assert.isDefined(second);

      await expect(sut.list({ ownerId: firstUser.id, size: 10 })).resolves.toEqual([
        expect.objectContaining({ id: first.id }),
      ]);
      await expect(sut.getLatestRun(MediaHealthCategory.Missing, firstUser.id)).resolves.toEqual(
        expect.objectContaining({ id: run.id }),
      );
      await expect(sut.getByIds([first.id, second.id], firstUser.id)).resolves.toEqual([
        expect.objectContaining({ id: first.id }),
      ]);
      await sut.markDismissed([first.id, second.id], firstUser.id);

      await expect(sut.getByIds([second.id])).resolves.toEqual([
        expect.objectContaining({ id: second.id, status: MediaHealthStatus.Missing }),
      ]);
    });

    it('upserts on (assetId, category) instead of duplicating findings', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const run = await sut.createRun(MediaHealthCategory.Missing);

      const first = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, run.id));
      assert.isDefined(first);
      const second = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, run.id),
        status: MediaHealthStatus.Candidate,
        severity: MediaHealthSeverity.Warning,
      });
      assert.isDefined(second);

      expect(second.id).toBe(first.id);
      expect(second.status).toBe(MediaHealthStatus.Candidate);
      await expect(sut.getByIds([first.id])).resolves.toHaveLength(1);
    });

    it('filters hidden assets from finding and asset reads', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const [{ asset: visible }, { asset: hidden }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, is_nsfw: false }),
        ctx.newAsset({ ownerId: user.id, is_nsfw: true }),
      ]);
      const run = await sut.createRun(MediaHealthCategory.Missing, user.id);
      const [visibleFinding, hiddenFinding] = await Promise.all([
        sut.upsertFinding(findingDto(visible.id, visible.originalPath, run.id)),
        sut.upsertFinding(findingDto(hidden.id, hidden.originalPath, run.id)),
      ]);

      assert.isDefined(visibleFinding);
      assert.isDefined(hiddenFinding);

      await expect(sut.list({ ownerId: user.id, privacy: { excludeNsfw: true }, size: 10 })).resolves.toEqual([
        expect.objectContaining({ id: visibleFinding.id }),
      ]);
      await expect(
        sut.getByIds([visibleFinding.id, hiddenFinding.id], user.id, { excludeNsfw: true }),
      ).resolves.toEqual([expect.objectContaining({ id: visibleFinding.id })]);
      await expect(sut.getAssets([visible.id, hidden.id], user.id, { excludeNsfw: true })).resolves.toEqual([
        expect.objectContaining({ id: visible.id }),
      ]);
    });

    it('rolls back every managed relink write when the asset checksum conflicts', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      const { result: asset } = await ctx.newAsset({ ownerId: user.id, checksum: sha1 });
      await ctx.newAsset({ ownerId: user.id, checksum: sha256 });
      const run = await sut.createRun(MediaHealthCategory.Missing, user.id);
      const finding = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, run.id),
        status: MediaHealthStatus.Found,
        resolution: { autoRelinkable: true },
      });
      assert.isDefined(finding);
      const recoveredPath = `/data/upload/${user.id}/recovered.jpg`;
      await sut.replaceCandidates(finding.id, [
        {
          healthId: finding.id,
          candidatePath: recoveredPath,
          status: MediaHealthStatus.Found,
          visualMatchScore: 1,
          evidence: { reason: 'checksum_match' },
          resolution: { autoRelinkable: true },
          checkedAt: new Date(),
        },
      ]);
      const [candidate] = await sut.getCandidatesByHealthIds([finding.id]);

      await expect(
        sut.relinkManagedAsset({
          expectedUpdateId: asset.updateId,
          expectedChecksumAlgorithm: asset.checksumAlgorithm,
          verifyCandidate: () => Promise.resolve({ sha1, sha256, sizeInBytes: 100 }),
          assetId: asset.id,
          candidateId: candidate.id,
          ownerId: user.id,
          healthId: finding.id,
          expectedOriginalPath: asset.originalPath,
          originalPath: recoveredPath,
          originalFileName: asset.originalFileName,
          expectedChecksum: sha1,
          sha1,
          sha256,
          sizeInBytes: 100,
          fileModifiedAt: new Date(),
        }),
      ).rejects.toThrow();

      await expect(
        defaultDatabase
          .selectFrom('asset')
          .select(['originalPath', 'checksum'])
          .where('id', '=', asset.id!)
          .executeTakeFirst(),
      ).resolves.toMatchObject({ originalPath: asset.originalPath, checksum: sha1 });
      await expect(
        defaultDatabase.selectFrom('physical_file').select('id').where('path', '=', recoveredPath).executeTakeFirst(),
      ).resolves.toBeUndefined();
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({ status: MediaHealthStatus.Found, originalFileName: 'photo.jpg' }),
      ]);
    });

    it('rejects a relink when the target asset is no longer active', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      const { result: asset } = await ctx.newAsset({ ownerId: user.id, checksum: sha1 });
      const run = await sut.createRun(MediaHealthCategory.Missing, user.id);
      const finding = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, run.id));
      assert.isDefined(finding);
      await defaultDatabase
        .updateTable('asset')
        .set({ status: AssetStatus.Trashed })
        .where('id', '=', asset.id!)
        .execute();

      await expect(
        sut.relinkManagedAsset({
          expectedUpdateId: asset.updateId,
          expectedChecksumAlgorithm: asset.checksumAlgorithm,
          verifyCandidate: () => Promise.resolve({ sha1, sha256, sizeInBytes: 100 }),
          assetId: asset.id,
          candidateId: 'candidate-1',
          ownerId: user.id,
          healthId: finding.id,
          expectedOriginalPath: asset.originalPath,
          originalPath: `/data/upload/${user.id}/recovered.jpg`,
          originalFileName: asset.originalFileName,
          expectedChecksum: sha1,
          sha1,
          sha256,
          sizeInBytes: 100,
          fileModifiedAt: new Date(),
        }),
      ).resolves.toBe(false);
    });

    it('rejects a relink when the asset path changed after candidate selection', async () => {
      const { asset, candidate, finding, recoveredPath, sha1, sha256, sut, user } = await arrangeManagedRelink();
      await defaultDatabase
        .updateTable('asset')
        .set({ originalPath: `/data/upload/${user.id}/already-repaired.jpg` })
        .where('id', '=', asset.id!)
        .execute();

      await expect(
        sut.relinkManagedAsset({
          expectedUpdateId: asset.updateId,
          expectedChecksumAlgorithm: asset.checksumAlgorithm,
          verifyCandidate: () => Promise.resolve({ sha1, sha256, sizeInBytes: 100 }),
          assetId: asset.id,
          candidateId: candidate.id,
          ownerId: user.id,
          healthId: finding.id,
          expectedOriginalPath: asset.originalPath,
          originalPath: recoveredPath,
          originalFileName: asset.originalFileName,
          expectedChecksum: sha1,
          sha1,
          sha256,
          sizeInBytes: 100,
          fileModifiedAt: new Date(),
        }),
      ).resolves.toBe(false);
    });

    it('rejects a relink when the finding was dismissed after candidate selection', async () => {
      const { asset, candidate, finding, recoveredPath, sha1, sha256, sut, user } = await arrangeManagedRelink();
      await sut.markDismissed([finding.id], user.id);

      await expect(
        sut.relinkManagedAsset({
          expectedUpdateId: asset.updateId,
          expectedChecksumAlgorithm: asset.checksumAlgorithm,
          verifyCandidate: () => Promise.resolve({ sha1, sha256, sizeInBytes: 100 }),
          assetId: asset.id,
          candidateId: candidate.id,
          ownerId: user.id,
          healthId: finding.id,
          expectedOriginalPath: asset.originalPath,
          originalPath: recoveredPath,
          originalFileName: asset.originalFileName,
          expectedChecksum: sha1,
          sha1,
          sha256,
          sizeInBytes: 100,
          fileModifiedAt: new Date(),
        }),
      ).resolves.toBe(false);
    });

    it('rejects a relink when the finding has multiple validated candidates', async () => {
      const { asset, finding, recoveredPath, sha1, sha256, sut, user } = await arrangeManagedRelink();
      await sut.replaceCandidates(finding.id, [
        {
          healthId: finding.id,
          candidatePath: recoveredPath,
          status: MediaHealthStatus.Found,
          visualMatchScore: 1,
          evidence: { reason: 'checksum_match' },
          resolution: { autoRelinkable: true },
          checkedAt: new Date(),
        },
        {
          healthId: finding.id,
          candidatePath: `/data/upload/${user.id}/another.jpg`,
          status: MediaHealthStatus.Found,
          visualMatchScore: 1,
          evidence: { reason: 'checksum_match' },
          resolution: { autoRelinkable: true },
          checkedAt: new Date(),
        },
      ]);
      const candidates = await sut.getCandidatesByHealthIds([finding.id]);
      const candidate = candidates.find(({ candidatePath }) => candidatePath === recoveredPath)!;

      await expect(
        sut.relinkManagedAsset({
          expectedUpdateId: asset.updateId,
          expectedChecksumAlgorithm: asset.checksumAlgorithm,
          verifyCandidate: () => Promise.resolve({ sha1, sha256, sizeInBytes: 100 }),
          assetId: asset.id,
          candidateId: candidate.id,
          ownerId: user.id,
          healthId: finding.id,
          expectedOriginalPath: asset.originalPath,
          originalPath: recoveredPath,
          originalFileName: asset.originalFileName,
          expectedChecksum: sha1,
          sha1,
          sha256,
          sizeInBytes: 100,
          fileModifiedAt: new Date(),
        }),
      ).resolves.toBe(false);
    });

    it('commits the asset, physical file, digest evidence, and finding together', async () => {
      const { ctx, sut } = setup();
      const [{ user: owner }, { user: candidateOwner }] = await Promise.all([ctx.newUser(), ctx.newUser()]);
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      const { result: asset } = await ctx.newAsset({
        ownerId: owner.id,
        checksum: sha1,
        originalFileName: 'photo.jpg',
      });
      const recoveredPath = `/data/upload/${candidateOwner.id}/recovered.jpg`;
      const { asset: candidateAsset } = await ctx.newAsset({
        ownerId: candidateOwner.id,
        checksum: sha256,
        originalPath: recoveredPath,
      });
      const run = await sut.createRun(MediaHealthCategory.Missing, owner.id);
      const finding = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, run.id),
        status: MediaHealthStatus.Found,
        resolution: { autoRelinkable: true },
      });
      assert.isDefined(finding);
      await sut.replaceCandidates(finding.id, [
        {
          healthId: finding.id,
          candidatePath: recoveredPath,
          status: MediaHealthStatus.Found,
          visualMatchScore: 1,
          evidence: { reason: 'checksum_match' },
          resolution: { autoRelinkable: true },
          checkedAt: new Date(),
        },
      ]);
      const [candidate] = await sut.getCandidatesByHealthIds([finding.id]);
      const modifiedAt = new Date('2026-09-04T00:00:00Z');

      await expect(
        sut.relinkManagedAsset({
          expectedUpdateId: asset.updateId,
          expectedChecksumAlgorithm: asset.checksumAlgorithm,
          verifyCandidate: () => Promise.resolve({ sha1, sha256, sizeInBytes: 100 }),
          assetId: asset.id,
          candidateId: candidate.id,
          ownerId: owner.id,
          healthId: finding.id,
          expectedOriginalPath: asset.originalPath,
          originalPath: recoveredPath,
          originalFileName: asset.originalFileName,
          expectedChecksum: sha1,
          sha1,
          sha256,
          sizeInBytes: 100,
          fileModifiedAt: modifiedAt,
        }),
      ).resolves.toBe(true);

      const relinkedRows = await sql<{
        originalPath: string;
        checksum: Buffer;
        fileModifiedAt: Date;
        canonicalAssetId: string;
      }>`
        SELECT a."originalPath", a.checksum, a."fileModifiedAt", p."canonicalAssetId"
        FROM public.asset a JOIN public.physical_file p ON p.id = a."physicalOriginalFileId" WHERE a.id = ${asset.id}::uuid
      `.execute(defaultDatabase);
      const relinked = relinkedRows.rows[0];
      expect(relinked).toMatchObject({
        originalPath: recoveredPath,
        checksum: sha256,
        fileModifiedAt: modifiedAt,
        canonicalAssetId: candidateAsset.id,
      });
      await expect(sut.getAssetChecksums([asset.id])).resolves.toEqual([
        expect.objectContaining({ assetId: asset.id, sha1, sha256, sizeInBytes: 100 }),
      ]);
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({
          status: MediaHealthStatus.Relinked,
          originalPath: recoveredPath,
          originalFileName: 'photo.jpg',
        }),
      ]);
    });

    it('replaces a damaged original with its repaired file, keeping the damaged path', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const damagedSha1 = Buffer.alloc(20, 7);
      const { result: asset } = await ctx.newAsset({ ownerId: user.id, checksum: damagedSha1 });
      const finding = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, null),
        category: MediaHealthCategory.Corrupt,
        status: MediaHealthStatus.CorruptSuspect,
      });
      assert.isDefined(finding);
      const repairedPath = `/data/upload/${user.id}/.library-care/${asset.id}-repaired.jpg`;
      const sha1 = Buffer.alloc(20, 8);
      const sha256 = Buffer.alloc(32, 9);
      const input = {
        expectedUpdateId: asset.updateId,
        expectedChecksumAlgorithm: asset.checksumAlgorithm,
        verifyCandidate: () => Promise.resolve({ sha1, sha256, sizeInBytes: 50 }),
        assetId: asset.id,
        ownerId: user.id,
        healthId: finding.id,
        expectedOriginalPath: asset.originalPath,
        originalPath: repairedPath,
        originalFileName: asset.originalFileName,
        sha1,
        sha256,
        sizeInBytes: 50,
        fileModifiedAt: new Date(),
      };

      // the asset is no longer the damaged file that was repaired
      await expect(sut.replaceRepairedOriginal({ ...input, expectedChecksum: Buffer.alloc(20, 1) })).resolves.toBe(
        false,
      );
      await expect(sut.replaceRepairedOriginal({ ...input, expectedChecksum: damagedSha1 })).resolves.toBe(true);

      const rows = await sql<{ originalPath: string; checksum: Buffer }>`
        SELECT "originalPath", checksum FROM public.asset WHERE id = ${asset.id}::uuid`.execute(defaultDatabase);
      expect(rows.rows[0]).toEqual({ originalPath: repairedPath, checksum: sha256 });
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({
          status: MediaHealthStatus.Resolved,
          originalPath: repairedPath,
          evidence: expect.objectContaining({ reason: 'repaired_damaged_file', retainedPath: asset.originalPath }),
          resolution: { healthId: finding.id, repaired: true },
        }),
      ]);
    });

    it('markResolved moves the finding to resolved/info and stamps resolvedAt', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const run = await sut.createRun(MediaHealthCategory.Missing);
      const finding = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, run.id));
      assert.isDefined(finding);

      await sut.markResolved(MediaHealthCategory.Missing, asset.id);

      const [resolved] = await sut.getByIds([finding.id]);
      expect(resolved).toMatchObject({ status: MediaHealthStatus.Resolved, severity: MediaHealthSeverity.Info });
      expect(resolved.resolvedAt).not.toBeNull();
    });

    it('markDismissed stamps dismissedAt; markStatus flips status only', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const run = await sut.createRun(MediaHealthCategory.Missing);
      const finding = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, run.id));
      assert.isDefined(finding);

      await sut.markDismissed([finding.id]);
      let [row] = await sut.getByIds([finding.id]);
      expect(row.status).toBe(MediaHealthStatus.Dismissed);
      expect(row.dismissedAt).not.toBeNull();

      await sut.markStatus([finding.id], MediaHealthStatus.Relinked);
      [row] = await sut.getByIds([finding.id]);
      expect(row.status).toBe(MediaHealthStatus.Relinked);
    });

    it('records the status a dismissal replaced and reopens to it only while still dismissed (FL-69, UT-2)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const run = await sut.createRun(MediaHealthCategory.Missing);
      const finding = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, run.id),
        resolution: { autoRelinkable: false },
      });
      assert.isDefined(finding);

      await sut.markDismissed([finding.id]);
      await sut.markDismissed([finding.id]);
      let [row] = await sut.getByIds([finding.id]);
      expect(row.resolution).toEqual({ autoRelinkable: false, dismissedFrom: MediaHealthStatus.Missing });

      await expect(sut.reopenFinding(finding.id, MediaHealthStatus.Trashed, MediaHealthStatus.Missing)).resolves.toBe(
        false,
      );
      await expect(sut.reopenFinding(finding.id, MediaHealthStatus.Dismissed, MediaHealthStatus.Missing)).resolves.toBe(
        true,
      );
      [row] = await sut.getByIds([finding.id]);
      expect(row).toMatchObject({
        status: MediaHealthStatus.Missing,
        dismissedAt: null,
        resolution: { autoRelinkable: false },
      });
      expect(row.resolution).not.toHaveProperty('dismissedFrom');
    });
  });

  describe('replaceCandidates', () => {
    it('replaces the candidate set and orders by visual match score', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const run = await sut.createRun(MediaHealthCategory.Missing);
      const finding = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, run.id));
      assert.isDefined(finding);
      const candidate = (candidatePath: string, visualMatchScore: number) => ({
        healthId: finding.id,
        candidatePath,
        status: MediaHealthStatus.Candidate,
        visualMatchScore,
        evidence: {},
        resolution: {},
        checkedAt: new Date(),
      });

      await sut.replaceCandidates(finding.id, [candidate('/old/a.jpg', 0.5)]);
      await sut.replaceCandidates(finding.id, [candidate('/new/low.jpg', 0.4), candidate('/new/high.jpg', 0.9)]);

      const candidates = await sut.getCandidatesByHealthIds([finding.id]);
      expect(candidates.map(({ candidatePath }) => candidatePath)).toEqual(['/new/high.jpg', '/new/low.jpg']);
    });

    it('rejects candidates that belong to a different finding', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const run = await sut.createRun(MediaHealthCategory.Missing);
      const finding = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, run.id));
      assert.isDefined(finding);

      await expect(
        sut.replaceCandidates(finding.id, [
          {
            healthId: '00000000-0000-4000-a000-000000000009',
            candidatePath: '/x.jpg',
            status: MediaHealthStatus.Candidate,
            visualMatchScore: 0.5,
            evidence: {},
            resolution: {},
            checkedAt: new Date(),
          },
        ]),
      ).rejects.toThrow('Cannot replace media-health candidates for multiple findings');
    });
  });

  describe('Locked media (FL-34)', () => {
    it("lists Locked media to an interactive read only for its owner's elevated session", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: timeline } = await ctx.newAsset({ ownerId: user.id });
      const { result: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await sut.upsertFinding(findingDto(timeline.id, timeline.originalPath, null));
      const lockedFinding = await sut.upsertFinding(findingDto(locked.id, locked.originalPath, null));
      assert.isDefined(lockedFinding);

      const ordinary = {};
      const elevated = { lockedOwnerId: user.id };
      const listed = async (privacy?: { lockedOwnerId?: string }) =>
        (await sut.list({ ownerId: user.id, privacy, size: 10 })).map(({ assetId }) => assetId).sort();

      await expect(listed(ordinary)).resolves.toEqual([timeline.id]);
      await expect(listed(elevated)).resolves.toEqual([timeline.id, locked.id].sort());
      await expect(sut.count({ ownerId: user.id, privacy: ordinary })).resolves.toBe(1);
      await expect(sut.getByIds([lockedFinding.id], user.id, ordinary)).resolves.toEqual([]);
      await expect(sut.getAssets([locked.id], user.id, ordinary)).resolves.toEqual([]);
      // the row carries the lock, so the response reports it as `locked`
      await expect(sut.getAssets([locked.id], user.id, elevated)).resolves.toEqual([
        expect.objectContaining({ id: locked.id, isLocked: true }),
      ]);
      await expect(sut.getAssets([timeline.id], user.id, elevated)).resolves.toEqual([
        expect.objectContaining({ id: timeline.id, isLocked: false }),
      ]);

      // a background job passes no privacy and still sees the Locked finding
      await expect(listed()).resolves.toEqual([timeline.id, locked.id].sort());
      await expect(sut.getByIds([lockedFinding.id], user.id)).resolves.toEqual([
        expect.objectContaining({ id: lockedFinding.id }),
      ]);
    });
  });
  describe('steps', () => {
    it('appends and lists steps in order', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const finding = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, null));
      assert.isDefined(finding);
      const at = new Date('2026-11-01T10:00:00.000Z');
      const later = new Date('2026-11-01T10:05:00.000Z');
      const base = { healthId: finding.id, assetId: asset.id };

      await sut.appendSteps([]);
      await sut.appendSteps([
        { ...base, step: 'checked', outcome: 'ok', at },
        { ...base, step: 'searched-copy', outcome: 'not-found', facts: { looked: 2 }, at },
        { ...base, step: 'repaired', outcome: 'ok', undo: { restore: '/a' }, at: later },
      ]);

      const steps = await sut.listSteps(finding.id);
      // the two sharing `at` come first, ordered by id (a v7 uuid is not strictly monotonic within a millisecond)
      const [first, second, third] = steps;
      expect(first.id < second.id).toBe(true);
      expect([first.step, second.step].sort()).toEqual(['checked', 'searched-copy']);
      expect(third).toMatchObject({ step: 'repaired', undo: { restore: '/a' }, at: later });
      const byStep = Object.fromEntries(steps.map((row) => [row.step, row]));
      expect(byStep['checked']).toMatchObject({ outcome: 'ok', facts: {}, undo: null, at });
      expect(byStep['searched-copy']).toMatchObject({ outcome: 'not-found', facts: { looked: 2 } });
    });

    it('lists steps appended without `at` in insertion order', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const finding = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, null));
      assert.isDefined(finding);
      const base = { healthId: finding.id, assetId: asset.id };

      // one multi-row call: the rows must not share a timestamp
      await sut.appendSteps([
        { ...base, step: 'repaired', outcome: 'ok' },
        { ...base, step: 'kept-damaged', outcome: 'info' },
        { ...base, step: 'checked', outcome: 'ok' },
      ]);
      await expect(sut.listSteps(finding.id)).resolves.toMatchObject([
        { step: 'repaired' },
        { step: 'kept-damaged' },
        { step: 'checked' },
      ]);

      // separate calls inside one transaction keep call order
      const { result: other } = await ctx.newAsset({ ownerId: user.id });
      const second = await sut.upsertFinding(findingDto(other.id, other.originalPath, null));
      assert.isDefined(second);
      const otherBase = { healthId: second.id, assetId: other.id };
      await defaultDatabase.transaction().execute(async (trx) => {
        await sut.appendSteps([{ ...otherBase, step: 'moved', outcome: 'ok' }], trx);
        await sut.appendSteps([{ ...otherBase, step: 'undone', outcome: 'ok' }], trx);
        await sut.appendSteps([{ ...otherBase, step: 'removed', outcome: 'ok' }], trx);
      });
      await expect(sut.listSteps(second.id)).resolves.toMatchObject([
        { step: 'moved' },
        { step: 'undone' },
        { step: 'removed' },
      ]);
    });

    it('writes in the caller transaction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const finding = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, null));
      assert.isDefined(finding);

      await expect(
        defaultDatabase.transaction().execute(async (trx) => {
          await sut.appendSteps([{ healthId: finding.id, assetId: asset.id, step: 'checked', outcome: 'ok' }], trx);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      await expect(sut.listSteps(finding.id)).resolves.toEqual([]);
    });

    it('steps go with their finding', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const finding = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, null));
      assert.isDefined(finding);
      await sut.appendSteps([{ healthId: finding.id, assetId: asset.id, step: 'not-on-drive', outcome: 'info' }]);
      await expect(sut.listSteps(finding.id)).resolves.toHaveLength(1);

      await defaultDatabase.deleteFrom('asset').where('id', '=', asset.id).execute();

      await expect(sut.listSteps(finding.id)).resolves.toEqual([]);
    });
  });

  describe('fix writes (FL-1337)', () => {
    it("claims an owner's waiting findings for one search, which a retry and a stopped search's successor claim again", async () => {
      const { ctx, sut } = setup();
      const [{ user }, { user: other }] = await Promise.all([ctx.newUser(), ctx.newUser()]);
      const waitingFor = async (ownerId: string, searchPending: unknown, settled = false) => {
        const { result: asset } = await ctx.newAsset({ ownerId });
        const finding = await sut.upsertFinding({
          ...findingDto(asset.id, asset.originalPath, null),
          evidence: { reason: 'stat failed', searchPending },
          ...(settled && { resolvedAt: new Date() }),
        });
        assert.isDefined(finding);
        return finding.id;
      };
      // live searches: one is the step that started it (its id), the other carries on (its `searchId`)
      const search = randomUUID();
      const live = randomUUID();
      const liveJob = randomUUID();
      const step = (id: string, data: Record<string, unknown>, queue = 'mediaHealth') =>
        sql`INSERT INTO job (id, queue, name, data, "safeToRetry", "deadlineMs")
          VALUES (${id}::uuid, ${queue}, 'MediaHealthLocateMissing', ${JSON.stringify(data)}::text::jsonb, true, 60000)`.execute(
          defaultDatabase,
        );
      await sql`INSERT INTO job_queue (name) VALUES ('mediaHealth'), ('elsewhere') ON CONFLICT DO NOTHING`.execute(
        defaultDatabase,
      );
      await step(search, { userId: user.id, pending: true });
      await step(liveJob, { userId: user.id, pending: true, searchId: live, ids: [] });
      // a job of that name in another queue is not Library care's search: it carries no claim
      const stray = randomUUID();
      const strayJob = randomUUID();
      await step(strayJob, { userId: user.id, pending: true, searchId: stray, ids: [] }, 'elsewhere');
      const waiting = await waitingFor(user.id, true);
      const walking = await waitingFor(user.id, { search: live });
      const stopped = await waitingFor(user.id, { search: randomUUID() });
      const strayed = await waitingFor(user.id, { search: stray });
      // a claim that does not name a search by its id is never mistaken for one, and fails nothing
      const unnamed = await waitingFor(user.id, { search: 'not-a-job-id' });
      await waitingFor(user.id, false);
      await waitingFor(user.id, true, true);
      await waitingFor(other.id, true);

      try {
        await expect(sut.claimSearchPending(user.id, search).then((ids) => ids.sort())).resolves.toEqual(
          [waiting, stopped, strayed, unnamed].sort(),
        );
        const [claimed] = await sut.getByIds([waiting]);
        expect(claimed.evidence).toEqual({ reason: 'stat failed', searchPending: { search } });
        // a search asked for meanwhile leaves them to this one, and to the live one its own
        await expect(sut.claimSearchPending(user.id, randomUUID())).resolves.toEqual([]);
        await expect(sut.getByIds([walking])).resolves.toEqual([
          expect.objectContaining({ evidence: expect.objectContaining({ searchPending: { search: live } }) }),
        ]);
        // a retried step claims the same findings again
        await expect(sut.claimSearchPending(user.id, search).then((ids) => ids.sort())).resolves.toEqual(
          [waiting, stopped, strayed, unnamed].sort(),
        );
        // once no step of the live search is live (it failed or was stopped), the next search claims its findings
        await sql`UPDATE job SET state = 'failed', "finishedAt" = now() WHERE id = ${liveJob}::uuid`.execute(
          defaultDatabase,
        );
        await expect(sut.claimSearchPending(user.id, randomUUID())).resolves.toEqual([walking]);
      } finally {
        await sql`DELETE FROM job WHERE id IN (${search}::uuid, ${liveJob}::uuid, ${strayJob}::uuid)`.execute(
          defaultDatabase,
        );
      }
    });

    it('keeps the search a finding waits for when a check records it again', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const missing = findingDto(asset.id, asset.originalPath, null);
      const finding = await sut.upsertFinding(missing);
      assert.isDefined(finding);
      await sut.settleFinding({ healthId: finding.id, evidence: { searchPending: true } });

      // the nightly check, or the viewer, records the same open problem again
      await sut.upsertFinding({ ...missing, evidence: { reason: 'source_file_missing_or_unreadable' } });
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({ evidence: { reason: 'source_file_missing_or_unreadable', searchPending: true } }),
      ]);
    });

    it("writes a new finding's first step with that finding's id, in the same transaction", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });

      const finding = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, null),
        steps: [{ step: 'not-on-drive', outcome: 'failed', facts: { folder: '2020/08', name: 'IMG_3310.jpg' } }],
      });
      assert.isDefined(finding);
      await expect(sut.listSteps(finding.id)).resolves.toEqual([
        expect.objectContaining({
          healthId: finding.id,
          assetId: asset.id,
          step: 'not-on-drive',
          outcome: 'failed',
          facts: { folder: '2020/08', name: 'IMG_3310.jpg' },
        }),
      ]);

      // a step that cannot be written takes its finding with it
      const { result: other } = await ctx.newAsset({ ownerId: user.id });
      await expect(
        sut.upsertFinding({
          ...findingDto(other.id, other.originalPath, null),
          steps: [{ step: 'not-on-drive', outcome: 'failed', assetId: '00000000-0000-4000-8000-000000000000' }],
        }),
      ).rejects.toThrow();
      await expect(sut.getFindingsForAsset(other.id)).resolves.toEqual([]);

      // a refused finding (the asset's file is another now) writes no step either
      await expect(
        sut.upsertFinding({
          ...findingDto(other.id, '/somewhere/else.jpg', null),
          steps: [{ step: 'not-on-drive', outcome: 'failed' }],
        }),
      ).resolves.toBeUndefined();
      await expect(sut.getFindingsForAsset(other.id)).resolves.toEqual([]);
    });

    it('keeps a declined repair, and the fix state of the same open problem, when a check records it again', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const damaged = {
        ...findingDto(asset.id, asset.originalPath, null),
        category: MediaHealthCategory.Corrupt,
        status: MediaHealthStatus.CorruptConfirmed,
      };
      const finding = await sut.upsertFinding(damaged);
      assert.isDefined(finding);
      await expect(
        sut.settleFinding({ healthId: finding.id, evidence: { fixState: 'cant-repair', autoRepairDeclined: true } }),
      ).resolves.toBe(true);

      // the nightly check finds the same damage
      await sut.upsertFinding({ ...damaged, evidence: { reason: 'decode_failed' } });
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({
          evidence: { reason: 'decode_failed', fixState: 'cant-repair', autoRepairDeclined: true },
        }),
      ]);

      // F6: another status while it stays open is the same problem, and keeps how the fix left it
      await sut.upsertFinding({ ...damaged, status: MediaHealthStatus.CorruptSuspect, evidence: { reason: 'x' } });
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({ evidence: { reason: 'x', fixState: 'cant-repair', autoRepairDeclined: true } }),
      ]);

      // a closed problem that comes back starts the fix state afresh, but never forgets "don't repair this again"
      await sut.markResolved(MediaHealthCategory.Corrupt, asset.id);
      await sut.upsertFinding({ ...damaged, evidence: { reason: 'y' } });
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({ evidence: { reason: 'y', autoRepairDeclined: true }, resolvedAt: null }),
      ]);
    });

    it('keeps a missing file’s Keep and search while its copies come and go, and starts afresh once dismissed (F6)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const missing = findingDto(asset.id, asset.originalPath, null);
      const finding = await sut.upsertFinding(missing);
      assert.isDefined(finding);
      await sut.settleFinding({ healthId: finding.id, evidence: { fixState: 'left-as-is', searchPending: false } });
      const evidence = async () => (await sut.getByIds([finding.id]))[0].evidence;

      // a search found copies Frameleaf may not use by itself, then the weekly check finds it missing again
      for (const status of [MediaHealthStatus.Found, MediaHealthStatus.Candidate, MediaHealthStatus.Missing]) {
        await sut.upsertFinding({ ...missing, status, evidence: { reason: 'source_file_missing_or_unreadable' } });
        await expect(evidence()).resolves.toEqual({
          reason: 'source_file_missing_or_unreadable',
          fixState: 'left-as-is',
          searchPending: false,
        });
      }

      // dismissed, then found again by a check: a new problem, for the fix to look at afresh
      await sut.markDismissed([finding.id]);
      await sut.upsertFinding({ ...missing, evidence: { reason: 'source_file_missing_or_unreadable' } });
      const [reopened] = await sut.getByIds([finding.id]);
      expect(reopened).toMatchObject({ dismissedAt: null, evidence: { reason: 'source_file_missing_or_unreadable' } });
      expect(reopened.evidence).not.toHaveProperty('fixState');
    });

    it('writes what a search found onto the finding as it is now, and never onto a closed one (F7)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const [current] = await sut.getAssets([asset.id]);
      const run = await sut.createRun(MediaHealthCategory.Missing, user.id);
      const finding = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, null),
        evidence: { reason: 'source_file_missing_or_unreadable', source: 'import' },
        resolution: { chosenCandidateId: randomUUID(), note: 'kept' },
      });
      assert.isDefined(finding);
      // the search claimed it and walked; meanwhile the person kept it as it is
      await sut.settleFinding({ healthId: finding.id, evidence: { searchPending: { search: 'walk' } } });
      await sut.settleFinding({ healthId: finding.id, evidence: { fixState: 'left-as-is', searchPending: false } });
      const result = {
        healthId: finding.id,
        assetId: asset.id,
        expectedUpdateId: current.updateId,
        originalPath: asset.originalPath,
        evidence: { candidateCount: 2, validatedCandidateCount: 2, searchTruncated: false },
        resolution: { autoRelinkable: false },
      };

      await expect(
        sut.recordSearchResult({
          ...result,
          found: { status: MediaHealthStatus.Found, severity: MediaHealthSeverity.Warning, runId: run.id },
        }),
      ).resolves.toBe(true);
      const [written] = await sut.getByIds([finding.id]);
      expect(written).toMatchObject({
        status: MediaHealthStatus.Found,
        severity: MediaHealthSeverity.Warning,
        runId: run.id,
        dismissedAt: null,
        resolvedAt: null,
        // the Keep made during the walk stays; only the search's own keys are added
        evidence: {
          reason: 'source_file_missing_or_unreadable',
          source: 'import',
          fixState: 'left-as-is',
          searchPending: false,
          candidateCount: 2,
          validatedCandidateCount: 2,
          searchTruncated: false,
        },
        // a choice from the old candidate list no longer applies
        resolution: { note: 'kept', autoRelinkable: false },
      });

      // damage the search looked behind keeps its status and the time it was confirmed
      const confirmedAt = written.checkedAt;
      await sut.recordSearchResult({ ...result, evidence: { candidateCount: 0 }, resolution: {} });
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({ status: MediaHealthStatus.Found, checkedAt: confirmedAt }),
      ]);

      // dismissed during the walk: left as it is
      await sut.markDismissed([finding.id]);
      await expect(sut.recordSearchResult(result)).resolves.toBe(false);
      const [dismissed] = await sut.getByIds([finding.id]);
      expect(dismissed.dismissedAt).not.toBeNull();
      expect(dismissed.evidence).toMatchObject({ candidateCount: 0 });

      // put back by an upload during the walk (resolved): left as it is too
      await sut.reopenFinding(finding.id, MediaHealthStatus.Dismissed, MediaHealthStatus.Found);
      await sut.settleFinding({
        healthId: finding.id,
        evidence: { fixState: 'found-again' },
        status: MediaHealthStatus.Relinked,
      });
      await expect(
        sut.recordSearchResult({
          ...result,
          found: { status: MediaHealthStatus.Missing, severity: MediaHealthSeverity.Critical, runId: null },
        }),
      ).resolves.toBe(false);
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({
          status: MediaHealthStatus.Relinked,
          evidence: expect.objectContaining({ fixState: 'found-again' }),
        }),
      ]);
    });

    it('writes no search result once the photo has another file than the one searched for', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const [current] = await sut.getAssets([asset.id]);
      const finding = await sut.upsertFinding(findingDto(asset.id, asset.originalPath, null));
      assert.isDefined(finding);
      const result = {
        healthId: finding.id,
        assetId: asset.id,
        originalPath: asset.originalPath,
        evidence: { candidateCount: 1 },
        resolution: {},
      };

      await expect(sut.recordSearchResult({ ...result, expectedUpdateId: randomUUID() })).resolves.toBe(false);
      await expect(
        sut.recordSearchResult({ ...result, expectedUpdateId: current.updateId, originalPath: '/elsewhere.jpg' }),
      ).resolves.toBe(false);
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({ evidence: { reason: 'stat failed' } }),
      ]);
    });

    it('settles a finding with its steps, keeping what the patch leaves out, and never a dismissed one', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const finding = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, null),
        evidence: { reason: 'stat failed', autoRepairDeclined: true },
      });
      assert.isDefined(finding);

      await expect(
        sut.settleFinding({
          healthId: finding.id,
          evidence: { fixState: 'waiting-phone' },
          steps: [{ step: 'asked-phones', outcome: 'waiting' }],
        }),
      ).resolves.toBe(true);
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({
          evidence: { reason: 'stat failed', autoRepairDeclined: true, fixState: 'waiting-phone' },
          resolvedAt: null,
        }),
      ]);
      await expect(sut.listSteps(finding.id)).resolves.toMatchObject([{ step: 'asked-phones', outcome: 'waiting' }]);

      // settled as fixed: resolved now
      await sut.settleFinding({
        healthId: finding.id,
        evidence: { fixState: 'restored' },
        status: MediaHealthStatus.Relinked,
      });
      const [fixed] = await sut.getByIds([finding.id]);
      expect(fixed).toMatchObject({ status: MediaHealthStatus.Relinked, evidence: { fixState: 'restored' } });
      expect(fixed.resolvedAt).toBeInstanceOf(Date);

      // the person dismissed it meanwhile: the fix leaves it as it is
      await sut.markDismissed([finding.id]);
      await expect(
        sut.settleFinding({
          healthId: finding.id,
          evidence: { fixState: 'missing' },
          steps: [{ step: 'asked-phones', outcome: 'not-found' }],
        }),
      ).resolves.toBe(false);
      await expect(sut.listSteps(finding.id)).resolves.toHaveLength(1);
    });

    it('keeps the fix state a repair is given, and writes its steps with it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const damagedSha1 = Buffer.alloc(20, 7);
      const { result: asset } = await ctx.newAsset({ ownerId: user.id, checksum: damagedSha1 });
      const finding = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, null),
        category: MediaHealthCategory.Corrupt,
        status: MediaHealthStatus.CorruptConfirmed,
      });
      assert.isDefined(finding);
      const repairedPath = `/data/upload/${user.id}/.library-care/${asset.id}-repaired.jpg`;
      const sha1 = Buffer.alloc(20, 8);
      const sha256 = Buffer.alloc(32, 9);

      await expect(
        sut.replaceRepairedOriginal({
          expectedUpdateId: asset.updateId,
          expectedChecksumAlgorithm: asset.checksumAlgorithm,
          verifyCandidate: () => Promise.resolve({ sha1, sha256, sizeInBytes: 50 }),
          assetId: asset.id,
          ownerId: user.id,
          healthId: finding.id,
          expectedOriginalPath: asset.originalPath,
          expectedChecksum: damagedSha1,
          originalPath: repairedPath,
          originalFileName: asset.originalFileName,
          sha1,
          sha256,
          sizeInBytes: 50,
          fileModifiedAt: new Date(),
          provenance: { recoveredBy: user.id, automatic: true, repairMethod: 'rebuilt' },
          evidence: { fixState: 'part-saved', partSaved: true },
          steps: [{ step: 'repaired', outcome: 'ok', facts: { method: 'rebuilt', percentSaved: 92 } }],
        }),
      ).resolves.toBe(true);

      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({
          status: MediaHealthStatus.Resolved,
          evidence: expect.objectContaining({
            fixState: 'part-saved',
            partSaved: true,
            reason: 'repaired_damaged_file',
            retainedPath: asset.originalPath,
          }),
        }),
      ]);
      await expect(sut.listSteps(finding.id)).resolves.toMatchObject([
        { step: 'repaired', outcome: 'ok', facts: { method: 'rebuilt', percentSaved: 92 }, assetId: asset.id },
      ]);

      // where the damaged file is kept now, with the step Undo reads
      const keptPath = `/data/upload/${user.id}/.library-care/${asset.id}-${finding.id}.damaged.jpg`;
      await sut.setRetainedPath(finding.id, keptPath, [
        { step: 'kept-damaged', outcome: 'info', undo: { kind: 'repair', previousPath: keptPath } },
      ]);
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({
          evidence: expect.objectContaining({ retainedPath: keptPath, fixState: 'part-saved' }),
        }),
      ]);
      await expect(sut.listSteps(finding.id)).resolves.toMatchObject([
        { step: 'repaired' },
        { step: 'kept-damaged', undo: { kind: 'repair', previousPath: keptPath } },
      ]);
    });

    it("keeps the fix state a relink is given, and completes its Undo with the asset's new file", async () => {
      const { asset, candidate, finding, recoveredPath, sha1, sha256, sut, user } = await arrangeManagedRelink();
      await sut.settleFinding({ healthId: finding.id, evidence: { autoRepairDeclined: true } });

      await expect(
        sut.relinkManagedAsset({
          expectedUpdateId: asset.updateId,
          expectedChecksumAlgorithm: asset.checksumAlgorithm,
          verifyCandidate: () => Promise.resolve({ sha1, sha256, sizeInBytes: 100 }),
          assetId: asset.id,
          candidateId: candidate.id,
          ownerId: user.id,
          healthId: finding.id,
          expectedOriginalPath: asset.originalPath,
          originalPath: recoveredPath,
          originalFileName: asset.originalFileName,
          expectedChecksum: sha1,
          sha1,
          sha256,
          sizeInBytes: 100,
          fileModifiedAt: new Date(),
          evidence: { fixState: 'found-again' },
          steps: [
            { step: 'searched-copy', outcome: 'ok', facts: { copies: 1 } },
            { step: 'put-back', outcome: 'ok', undo: { kind: 'relink', previousPath: asset.originalPath } },
          ],
        }),
      ).resolves.toBe(true);

      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({
          status: MediaHealthStatus.Relinked,
          evidence: expect.objectContaining({
            fixState: 'found-again',
            autoRepairDeclined: true,
            reason: 'candidate_relinked',
          }),
        }),
      ]);
      await expect(sut.listSteps(finding.id)).resolves.toMatchObject([
        { step: 'searched-copy', undo: null },
        {
          step: 'put-back',
          undo: {
            kind: 'relink',
            previousPath: asset.originalPath,
            originalPath: recoveredPath,
            checksum: sha256.toString('hex'),
          },
        },
      ]);
    });
  });

  describe('file problems (FL-1337)', () => {
    const days = (count: number) => new Date(Date.now() - count * 24 * 60 * 60 * 1000);
    /** One finding as a fix left it: its fix state, and when it was resolved or dismissed. */
    const arrangeProblem = async (
      sut: MediaHealthRepository,
      asset: { id: string; originalPath: string },
      state: {
        category?: MediaHealthCategory;
        evidence?: Record<string, unknown>;
        resolvedAt?: Date | null;
        dismissedAt?: Date | null;
        updatedAt?: Date;
      } = {},
    ) => {
      const finding = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, null),
        ...(state.category && { category: state.category }),
        evidence: state.evidence ?? {},
      });
      assert.isDefined(finding);
      await defaultDatabase
        .updateTable('asset_health')
        .set({ resolvedAt: state.resolvedAt ?? null, dismissedAt: state.dismissedAt ?? null })
        .where('id', '=', finding.id)
        .execute();
      if (state.updatedAt) {
        // the update trigger stamps updatedAt; a test sets the order it wants afterwards
        await sql`ALTER TABLE asset_health DISABLE TRIGGER "asset_health_updatedAt"`.execute(defaultDatabase);
        await defaultDatabase
          .updateTable('asset_health')
          .set({ updatedAt: state.updatedAt })
          .where('id', '=', finding.id)
          .execute();
        await sql`ALTER TABLE asset_health ENABLE TRIGGER "asset_health_updatedAt"`.execute(defaultDatabase);
      }
      return finding;
    };
    const listed = async (
      sut: MediaHealthRepository,
      tab: 'needs' | 'fixed' | 'kept',
      ownerId?: string,
      privacy: { lockedOwnerId?: string } = {},
    ) => (await sut.listFileProblems({ tab, ownerId, privacy, take: 50, skip: 0 })).map(({ id }) => id);

    it('flags a photo by its open problem only, the missing one first (viewer)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const damaged = await arrangeProblem(sut, asset, {
        category: MediaHealthCategory.Corrupt,
        evidence: { fixState: 'cant-repair' },
      });
      await expect(sut.getOpenFileProblem(asset.id)).resolves.toEqual({
        id: damaged.id,
        category: MediaHealthCategory.Corrupt,
      });

      const missing = await arrangeProblem(sut, asset, { category: MediaHealthCategory.Missing });
      await expect(sut.getOpenFileProblem(asset.id)).resolves.toEqual({
        id: missing.id,
        category: MediaHealthCategory.Missing,
      });

      // fixed and kept as it is flag nothing
      await defaultDatabase
        .updateTable('asset_health')
        .set({ resolvedAt: new Date(), evidence: sql`'{"fixState":"repaired"}'::jsonb` })
        .where('id', '=', missing.id)
        .execute();
      await defaultDatabase
        .updateTable('asset_health')
        .set({ evidence: sql`'{"fixState":"left-as-is"}'::jsonb` })
        .where('id', '=', damaged.id)
        .execute();
      await expect(sut.getOpenFileProblem(asset.id)).resolves.toBeUndefined();
    });

    it('counts what was fixed in the last 7 days, from the earliest to the newest, and what needs the reader', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const photo = async (ownerId = user.id) => (await ctx.newAsset({ ownerId })).result;
      // the database is shared with the other specs: an unscoped count is read as a change
      const before = await sut.fileProblemCounts({ privacy: {}, days: 7 });
      const earliest = days(5);
      const newest = days(1);
      await arrangeProblem(sut, await photo(), { evidence: { fixState: 'repaired' }, resolvedAt: newest });
      await arrangeProblem(sut, await photo(), { evidence: { fixState: 'part-saved' }, resolvedAt: earliest });
      await arrangeProblem(sut, await photo(), { evidence: { fixState: 'found-again' }, resolvedAt: days(20) });
      await arrangeProblem(sut, await photo(), { evidence: { fixState: 'cant-repair' } });
      await arrangeProblem(sut, await photo(other.id), { evidence: { fixState: 'missing' } });
      await arrangeProblem(sut, await photo(), { evidence: { fixState: 'left-as-is' } });

      const mine = await sut.fileProblemCounts({ ownerId: user.id, privacy: {}, days: 7 });
      expect(mine).toMatchObject({ fixed: 2, needsYou: 1 });
      expect(Math.abs((mine.since?.getTime() ?? 0) - earliest.getTime())).toBeLessThan(5000);
      // the newest fix in the window, never the one 20 days ago or a problem still open
      expect(Math.abs((mine.latest?.getTime() ?? 0) - newest.getTime())).toBeLessThan(5000);
      const all = await sut.fileProblemCounts({ privacy: {}, days: 7 });
      expect([all.fixed - before.fixed, all.needsYou - before.needsYou]).toEqual([2, 2]);
      await expect(sut.fileProblemCounts({ ownerId: other.id, privacy: {}, days: 7 })).resolves.toEqual({
        fixed: 0,
        needsYou: 1,
        since: null,
        latest: null,
      });
    });

    it('puts each problem in its tab, newest first, part-saved first among the fixed', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const photo = async () => (await ctx.newAsset({ ownerId: user.id })).result;
      const fresh = await arrangeProblem(sut, await photo(), { updatedAt: days(3) });
      const waiting = await arrangeProblem(sut, await photo(), {
        evidence: { fixState: 'waiting-phone' },
        updatedAt: days(1),
      });
      const cantRepair = await arrangeProblem(sut, await photo(), {
        category: MediaHealthCategory.Corrupt,
        evidence: { fixState: 'cant-repair' },
        updatedAt: days(2),
      });
      const repaired = await arrangeProblem(sut, await photo(), {
        category: MediaHealthCategory.Corrupt,
        evidence: { fixState: 'repaired' },
        resolvedAt: days(1),
      });
      const partSaved = await arrangeProblem(sut, await photo(), {
        category: MediaHealthCategory.Corrupt,
        evidence: { fixState: 'part-saved', partSaved: true },
        resolvedAt: days(5),
      });
      const restored = await arrangeProblem(sut, await photo(), {
        evidence: { fixState: 'restored' },
        resolvedAt: days(3),
      });
      // fixed too long ago, dismissed, or in the trash: in no tab
      await arrangeProblem(sut, await photo(), { evidence: { fixState: 'found-again' }, resolvedAt: days(31) });
      await arrangeProblem(sut, await photo(), { dismissedAt: days(1) });
      await arrangeProblem(sut, await photo(), {
        evidence: { fixState: 'repaired' },
        resolvedAt: days(1),
        dismissedAt: days(1),
      });
      const { result: trashed } = await ctx.newAsset({
        ownerId: user.id,
        deletedAt: new Date(),
        status: AssetStatus.Trashed,
      });
      await arrangeProblem(sut, trashed);
      const kept = await arrangeProblem(sut, await photo(), {
        category: MediaHealthCategory.Corrupt,
        evidence: { fixState: 'left-as-is' },
      });
      const keptSettled = await arrangeProblem(sut, await photo(), {
        category: MediaHealthCategory.Corrupt,
        evidence: { fixState: 'left-as-is' },
        resolvedAt: days(40),
        updatedAt: days(40),
      });

      await expect(listed(sut, 'needs', user.id)).resolves.toEqual([waiting.id, cantRepair.id, fresh.id]);
      await expect(listed(sut, 'fixed', user.id)).resolves.toEqual([partSaved.id, repaired.id, restored.id]);
      await expect(listed(sut, 'kept', user.id)).resolves.toEqual([kept.id, keptSettled.id]);
      await expect(sut.countFileProblems({ tab: 'needs', ownerId: user.id, privacy: {} })).resolves.toBe(3);
      await expect(sut.countFileProblems({ tab: 'fixed', ownerId: user.id, privacy: {} })).resolves.toBe(3);
      await expect(sut.countFileProblems({ tab: 'kept', ownerId: user.id, privacy: {} })).resolves.toBe(2);
      // a page at a time
      await expect(
        sut.listFileProblems({ tab: 'needs', ownerId: user.id, privacy: {}, take: 1, skip: 1 }),
      ).resolves.toEqual([expect.objectContaining({ id: cantRepair.id })]);
    });

    it('tells each row’s story from its newest step, apart from the damaged file kept beside a repair', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser({ name: 'Taylor' });
      const { result: asset } = await ctx.newAsset({ ownerId: user.id });
      const finding = await arrangeProblem(sut, asset, {
        category: MediaHealthCategory.Corrupt,
        evidence: { fixState: 'part-saved', partSaved: true },
        resolvedAt: days(1),
      });
      const { result: quiet } = await ctx.newAsset({ ownerId: user.id });
      const untold = await arrangeProblem(sut, quiet);
      await sut.appendSteps([
        {
          healthId: finding.id,
          assetId: asset.id,
          step: 'wont-open',
          outcome: 'failed',
          facts: { cause: 'cut-short' },
        },
        {
          healthId: finding.id,
          assetId: asset.id,
          step: 'repaired',
          outcome: 'ok',
          facts: { method: 'rebuilt', percentSaved: 92 },
        },
        {
          healthId: finding.id,
          assetId: asset.id,
          step: 'kept-damaged',
          outcome: 'info',
          undo: { kind: 'repair', previousPath: '/x' },
        },
      ]);

      const [row] = await sut.listFileProblems({ tab: 'fixed', ownerId: user.id, privacy: {}, take: 50, skip: 0 });
      expect(row).toMatchObject({
        id: finding.id,
        assetId: asset.id,
        ownerId: user.id,
        ownerName: 'Taylor',
        category: MediaHealthCategory.Corrupt,
        evidence: { fixState: 'part-saved', partSaved: true },
        line: { step: 'repaired', outcome: 'ok', facts: { method: 'rebuilt', percentSaved: 92 } },
      });
      await expect(sut.getFileProblem(untold.id, user.id, {})).resolves.toMatchObject({ id: untold.id, line: null });
    });

    it('lists a member’s own problems only, and never another account’s Locked photo to anyone', async () => {
      const { ctx, sut } = setup();
      const [{ user: member }, { user: other }, { user: admin }] = await Promise.all([
        ctx.newUser(),
        ctx.newUser(),
        ctx.newUser({ isAdmin: true }),
      ]);
      const { result: own } = await ctx.newAsset({ ownerId: member.id });
      const { result: theirs } = await ctx.newAsset({ ownerId: other.id });
      const { result: theirsLocked } = await ctx.newAsset({ ownerId: other.id, visibility: AssetVisibility.Locked });
      const { result: adminLocked } = await ctx.newAsset({ ownerId: admin.id, visibility: AssetVisibility.Locked });
      const ownProblem = await arrangeProblem(sut, own);
      const theirProblem = await arrangeProblem(sut, theirs);
      const theirLockedProblem = await arrangeProblem(sut, theirsLocked);
      const adminLockedProblem = await arrangeProblem(sut, adminLocked);

      await expect(listed(sut, 'needs', member.id)).resolves.toEqual([ownProblem.id]);
      await expect(sut.getFileProblem(theirProblem.id, member.id, {})).resolves.toBeUndefined();

      // an administrator reads every account, but Locked photos only their own, in their unlocked session
      const everyone = await listed(sut, 'needs', undefined, {});
      expect(everyone).toEqual(expect.arrayContaining([ownProblem.id, theirProblem.id]));
      expect(everyone).not.toContain(theirLockedProblem.id);
      expect(everyone).not.toContain(adminLockedProblem.id);
      const unlocked = await listed(sut, 'needs', undefined, { lockedOwnerId: admin.id });
      expect(unlocked).toContain(adminLockedProblem.id);
      expect(unlocked).not.toContain(theirLockedProblem.id);
      await expect(sut.getFileProblem(theirLockedProblem.id, undefined, { lockedOwnerId: admin.id })).resolves.toBe(
        undefined,
      );
      await expect(sut.countFileProblems({ tab: 'needs', ownerId: other.id, privacy: {} })).resolves.toBe(1);
    });

    /** A repaired photo, as a fix leaves it: the repaired file in use, the damaged one kept, and the step Undo reads. */
    const arrangeRepaired = async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const damagedSha1 = Buffer.alloc(20, 7);
      const { result: asset } = await ctx.newAsset({ ownerId: user.id, checksum: damagedSha1 });
      const finding = await sut.upsertFinding({
        ...findingDto(asset.id, asset.originalPath, null),
        category: MediaHealthCategory.Corrupt,
        status: MediaHealthStatus.CorruptConfirmed,
      });
      assert.isDefined(finding);
      const repairedPath = `/data/upload/${user.id}/.library-care/${asset.id}-${finding.id}-01234567.jpg`;
      const keptPath = `/data/upload/${user.id}/.library-care/${asset.id}-${finding.id}.damaged.jpg`;
      const repaired = { sha1: Buffer.alloc(20, 8), sha256: Buffer.alloc(32, 9), sizeInBytes: 50 };
      await expect(
        sut.replaceRepairedOriginal({
          expectedUpdateId: asset.updateId,
          expectedChecksumAlgorithm: asset.checksumAlgorithm,
          verifyCandidate: () => Promise.resolve(repaired),
          assetId: asset.id,
          ownerId: user.id,
          healthId: finding.id,
          expectedOriginalPath: asset.originalPath,
          expectedChecksum: damagedSha1,
          originalPath: repairedPath,
          originalFileName: asset.originalFileName,
          ...repaired,
          fileModifiedAt: new Date(),
          evidence: { fixState: 'part-saved', partSaved: true },
          steps: [{ step: 'repaired', outcome: 'ok', facts: { method: 'rebuilt', percentSaved: 92 } }],
        }),
      ).resolves.toBe(true);
      await sut.setRetainedPath(finding.id, keptPath, [
        {
          step: 'kept-damaged',
          outcome: 'info',
          undo: {
            kind: 'repair',
            previousPath: keptPath,
            originalPath: repairedPath,
            checksum: repaired.sha256.toString('hex'),
          },
        },
      ]);
      const fixStep = (await sut.listSteps(finding.id)).find(({ step }) => step === 'kept-damaged')!;
      const damaged = { sha1: damagedSha1, sha256: Buffer.alloc(32, 7), sizeInBytes: 40 };
      const undo = {
        healthId: finding.id,
        assetId: asset.id,
        ownerId: user.id,
        stepId: fixStep.id,
        expectedOriginalPath: repairedPath,
        expectedChecksum: repaired.sha256,
        relinkTo: { path: keptPath, digests: damaged, takeChecksum: true },
        status: MediaHealthStatus.CorruptConfirmed,
        evidence: { fixState: 'cant-repair', partSaved: false, autoRepairDeclined: true },
        steps: [{ step: 'undone' as const, outcome: 'info' as const, facts: { by: user.name } }],
      };
      const assetRow = async () =>
        defaultDatabase
          .selectFrom('asset')
          .select(['originalPath', 'checksum', 'checksumAlgorithm', 'physicalOriginalFileId'])
          .where('id', '=', asset.id)
          .executeTakeFirstOrThrow();
      return { ctx, sut, user, asset, finding, repairedPath, keptPath, damaged, undo, assetRow };
    };

    it('undoFix relinks and records the step in one transaction', async () => {
      const { ctx, sut, user, asset, finding, repairedPath, keptPath, damaged, undo, assetRow } =
        await arrangeRepaired();

      // another photo of the same account already has the damaged file's checksum: the relink fails, and
      // with it every other write of the undo
      const { result: twin } = await ctx.newAsset({ ownerId: user.id, checksum: damaged.sha256 });
      await expect(sut.undoFix(undo)).rejects.toThrow();
      await expect(assetRow()).resolves.toMatchObject({ originalPath: repairedPath });
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({ status: MediaHealthStatus.Resolved, resolvedAt: expect.any(Date) }),
      ]);
      expect((await sut.listSteps(finding.id)).map(({ step }) => step)).toEqual(['repaired', 'kept-damaged']);

      await defaultDatabase.deleteFrom('asset').where('id', '=', twin.id).execute();
      await expect(sut.undoFix(undo)).resolves.toBe('undone');

      const relinked = await assetRow();
      expect(relinked).toMatchObject({
        originalPath: keptPath,
        checksum: damaged.sha256,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      });
      const physical = await defaultDatabase
        .selectFrom('physical_file')
        .selectAll()
        .where('id', '=', relinked.physicalOriginalFileId!)
        .executeTakeFirstOrThrow();
      expect(physical).toMatchObject({ path: keptPath, checksum: damaged.sha256, canonicalAssetId: asset.id });
      await expect(sut.getAssetChecksums([asset.id])).resolves.toEqual([
        expect.objectContaining({ sha1: damaged.sha1, sha256: damaged.sha256, sizeInBytes: 40 }),
      ]);
      // reopened in Needs you, never repaired again by itself
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({
          status: MediaHealthStatus.CorruptConfirmed,
          originalPath: keptPath,
          resolvedAt: null,
          evidence: expect.objectContaining({ fixState: 'cant-repair', partSaved: false, autoRepairDeclined: true }),
        }),
      ]);
      await expect(listed(sut, 'needs', user.id)).resolves.toEqual([finding.id]);
      await expect(sut.listSteps(finding.id)).resolves.toMatchObject([
        { step: 'repaired' },
        { step: 'kept-damaged' },
        { step: 'undone', outcome: 'info', facts: { by: user.name }, undo: null },
      ]);
      // the repaired file keeps its record: it is still there, and nothing deleted it
      await expect(
        defaultDatabase.selectFrom('physical_file').select('path').where('path', '=', repairedPath).execute(),
      ).resolves.toHaveLength(1);

      // undone once: a second undo finds the photo changed
      await expect(sut.undoFix(undo)).resolves.toBe('changed');
    });

    it('undoFix changes nothing once the photo changed since the fix', async () => {
      const { sut, asset, finding, repairedPath, undo, assetRow } = await arrangeRepaired();
      const unchanged = async () => {
        await expect(assetRow()).resolves.toMatchObject({ originalPath: repairedPath });
        await expect(sut.getByIds([finding.id])).resolves.toEqual([
          expect.objectContaining({ status: MediaHealthStatus.Resolved }),
        ]);
        expect((await sut.listSteps(finding.id)).map(({ step }) => step)).not.toContain('undone');
      };

      // re-uploaded or replaced: not the file or the checksum the repair left
      await expect(sut.undoFix({ ...undo, expectedOriginalPath: '/data/upload/elsewhere.jpg' })).resolves.toBe(
        'changed',
      );
      await expect(sut.undoFix({ ...undo, expectedChecksum: Buffer.alloc(32, 1) })).resolves.toBe('changed');
      await unchanged();

      // an edit saved after the repair
      await sql`INSERT INTO asset_edit ("assetId", action, parameters, sequence)
        VALUES (${asset.id}::uuid, 'rotate', '{"angle":90}'::jsonb, 0)`.execute(defaultDatabase);
      await expect(sut.undoFix(undo)).resolves.toBe('changed');
      await unchanged();

      // an edit removed after it counts too
      await defaultDatabase.deleteFrom('asset_edit').where('assetId', '=', asset.id).execute();
      await expect(sut.undoFix(undo)).resolves.toBe('changed');
      await unchanged();
    });

    it('undoFix moves and relinks nothing for a photo locked meanwhile (Task 11b)', async () => {
      const { sut, asset, finding, repairedPath, undo, assetRow } = await arrangeRepaired();
      // the photo was put in Locked after the service looked, before the undo took its lock
      await defaultDatabase
        .insertInto('asset_lock')
        .values({ assetId: asset.id, reason: AssetLockReason.Marked })
        .execute();
      const moveFiles = vi.fn();

      await expect(sut.undoFix({ ...undo, moveFiles })).resolves.toBe('locked');

      expect(moveFiles).not.toHaveBeenCalled();
      await expect(assetRow()).resolves.toMatchObject({ originalPath: repairedPath });
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({ status: MediaHealthStatus.Resolved, resolvedAt: expect.any(Date) }),
      ]);
      expect((await sut.listSteps(finding.id)).map(({ step }) => step)).toEqual(['repaired', 'kept-damaged']);

      // unlocked again, the same undo goes through
      await defaultDatabase.deleteFrom('asset_lock').where('assetId', '=', asset.id).execute();
      await expect(sut.undoFix(undo)).resolves.toBe('undone');
    });

    it('undoFix leaves a fix that a later fix or an undo replaced', async () => {
      const { sut, asset, finding, undo } = await arrangeRepaired();
      await sut.appendSteps([
        { healthId: finding.id, assetId: asset.id, step: 'undone', outcome: 'info', facts: { by: 'someone' } },
      ]);

      await expect(sut.undoFix(undo)).resolves.toBe('changed');
    });

    it('undoFix of a restore moves its files under the lock, and reopens the problem', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: asset } = await ctx.newAsset({ ownerId: user.id, checksum: Buffer.alloc(20, 3) });
      const finding = await arrangeProblem(sut, asset, { evidence: { fixState: 'restored' }, resolvedAt: days(1) });
      await sut.appendSteps([
        {
          healthId: finding.id,
          assetId: asset.id,
          step: 'restored',
          outcome: 'ok',
          undo: { kind: 'restore', previousPath: asset.originalPath },
        },
      ]);
      const [fixStep] = await sut.listSteps(finding.id);
      const restore = {
        healthId: finding.id,
        assetId: asset.id,
        ownerId: user.id,
        stepId: fixStep.id,
        expectedOriginalPath: asset.originalPath,
        expectedChecksum: Buffer.alloc(20, 3),
        status: MediaHealthStatus.Missing,
        evidence: { fixState: 'missing', partSaved: false },
        steps: [{ step: 'undone' as const, outcome: 'info' as const, facts: { by: user.name } }],
      };

      // the files could not be moved: nothing is recorded
      await expect(
        sut.undoFix({ ...restore, moveFiles: () => Promise.reject(new Error('the drive went away')) }),
      ).rejects.toThrow('the drive went away');
      expect(await sut.listSteps(finding.id)).toHaveLength(1);

      const moveFiles = vi.fn().mockResolvedValue(undefined);
      await expect(sut.undoFix({ ...restore, moveFiles })).resolves.toBe('undone');

      expect(moveFiles).toHaveBeenCalledTimes(1);
      await expect(
        defaultDatabase.selectFrom('asset').select(['originalPath', 'checksum']).where('id', '=', asset.id).execute(),
      ).resolves.toEqual([{ originalPath: asset.originalPath, checksum: Buffer.alloc(20, 3) }]);
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({
          status: MediaHealthStatus.Missing,
          resolvedAt: null,
          evidence: expect.objectContaining({ fixState: 'missing' }),
        }),
      ]);
      await expect(listed(sut, 'needs', user.id)).resolves.toEqual([finding.id]);
    });

    it('goes by a photo’s open problem: its fixed one is in no tab, its history still readable, and kept as it is', async () => {
      const { sut, asset, finding, undo } = await arrangeRepaired();
      await expect(listed(sut, 'fixed', undo.ownerId)).resolves.toEqual([finding.id]);

      // the same photo goes missing afterwards
      const missing = await sut.upsertFinding(
        findingDto(asset.id, (await sut.getByIds([finding.id]))[0].originalPath, null),
      );
      assert.isDefined(missing);

      await expect(listed(sut, 'fixed', undo.ownerId)).resolves.toEqual([]);
      await expect(listed(sut, 'needs', undo.ownerId)).resolves.toEqual([missing.id]);
      await expect(sut.getFileProblem(finding.id, undo.ownerId, {})).resolves.toMatchObject({
        id: finding.id,
        line: { step: 'repaired' },
      });
      await expect(sut.undoFix(undo)).resolves.toBe('open');
      await expect(sut.getByIds([finding.id])).resolves.toEqual([
        expect.objectContaining({ status: MediaHealthStatus.Resolved, resolvedAt: expect.any(Date) }),
      ]);

      // once that one is settled, the fix is back in Fixed for you and can be undone
      await sut.markDismissed([missing.id]);
      await expect(listed(sut, 'fixed', undo.ownerId)).resolves.toEqual([finding.id]);
      await expect(sut.undoFix(undo)).resolves.toBe('undone');
    });

    it('records that a photo with an open problem was removed', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { result: open } = await ctx.newAsset({ ownerId: user.id });
      const { result: fixed } = await ctx.newAsset({ ownerId: user.id });
      const openProblem = await arrangeProblem(sut, open);
      const fixedProblem = await arrangeProblem(sut, fixed, {
        evidence: { fixState: 'repaired' },
        resolvedAt: days(1),
      });

      await sut.recordRemoved([open.id, fixed.id], { by: user.name });

      await expect(sut.listSteps(openProblem.id)).resolves.toMatchObject([
        { step: 'removed', outcome: 'info', facts: { by: user.name }, assetId: open.id },
      ]);
      await expect(sut.listSteps(fixedProblem.id)).resolves.toEqual([]);
    });
  });
});
