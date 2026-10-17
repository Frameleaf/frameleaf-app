import { Kysely, sql } from 'kysely';
import { AssetStatus, AssetVisibility, MediaHealthCategory, MediaHealthSeverity, MediaHealthStatus } from 'src/enum.js';
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
});
