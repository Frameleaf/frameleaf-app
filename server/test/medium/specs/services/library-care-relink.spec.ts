import { Kysely, sql } from 'kysely';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AssetFileType,
  ChecksumAlgorithm,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
} from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DB } from 'src/schema/index.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  StorageCore.setMediaLocation('/data');
});

const sha1 = Buffer.alloc(20, 1);
const sha256 = Buffer.alloc(32, 2);
const localDateTime = new Date('2026-07-01T12:00:00.000Z');

const setup = () => {
  const { sut, ctx } = newMediumService(MetadataService, {
    database: defaultDatabase,
    real: [AssetRepository, AssetJobRepository, PhysicalFileRepository],
    mock: [EventRepository, StorageRepository, LoggingRepository],
  });
  return { metadata: sut, ctx, repository: new MediaHealthRepository(defaultDatabase) };
};

/** Relink (or recover) the asset onto `to` through Library Care's commit, as the bulk worker does. */
const commit = async (
  repository: MediaHealthRepository,
  assetId: string,
  to: string,
  category: MediaHealthCategory,
) => {
  const asset = await defaultDatabase
    .selectFrom('asset')
    .selectAll()
    .where('id', '=', assetId)
    .executeTakeFirstOrThrow();
  const run = await repository.createRun(category, asset.ownerId);
  const finding = await repository.upsertFinding({
    assetId,
    runId: run.id,
    category,
    status: category === MediaHealthCategory.Missing ? MediaHealthStatus.Found : MediaHealthStatus.CorruptConfirmed,
    severity: MediaHealthSeverity.Critical,
    originalPath: asset.originalPath,
    originalFileName: asset.originalFileName,
    evidence: {},
    resolution: { autoRelinkable: true },
    checkedAt: new Date(),
  });
  assert.isDefined(finding);
  await repository.replaceCandidates(finding.id, [
    {
      healthId: finding.id,
      candidatePath: to,
      status: MediaHealthStatus.Found,
      visualMatchScore: 1,
      evidence: {},
      resolution: { autoRelinkable: true },
      checkedAt: new Date(),
    },
  ]);
  const [candidate] = await repository.getCandidatesByHealthIds([finding.id]);
  await expect(
    repository.relinkManagedAsset({
      assetId,
      candidateId: candidate.id,
      ownerId: asset.ownerId,
      healthId: finding.id,
      expectedUpdateId: asset.updateId,
      expectedChecksumAlgorithm: asset.checksumAlgorithm,
      expectedOriginalPath: asset.originalPath,
      originalPath: to,
      originalFileName: asset.originalFileName,
      expectedChecksum: asset.checksum,
      sha1,
      sha256,
      sizeInBytes: 100,
      fileModifiedAt: new Date(),
      category,
      ...(category === MediaHealthCategory.Corrupt && { candidatePath: to }),
      verifyCandidate: () => Promise.resolve({ sha1, sha256, sizeInBytes: 100 }),
    }),
  ).resolves.toBe(true);
};

describe('Library Care relink and recovery keep the asset whole', () => {
  // The first relink moves the asset off its first path and leaves that path's physical file without an
  // owner. The second lands back on that path, as a repeated take or a returned file does.
  it.each([MediaHealthCategory.Missing, MediaHealthCategory.Corrupt])(
    'keeps owner, canonical owner, sidecar, GPS, time zone and local time after %s',
    async (category) => {
      const { metadata, ctx, repository } = setup();
      const { user } = await ctx.newUser();
      const originalPath = `/data/upload/${user.id}/photo.jpg`;
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath,
        originalFileName: 'photo.jpg',
        checksum: sha256,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
        localDateTime,
      });
      await ctx.newExif({
        assetId: asset.id,
        fileSizeInByte: 100,
        latitude: 51.0447,
        longitude: -114.0719,
        timeZone: 'America/Edmonton',
      });
      await new PhysicalFileRepository(defaultDatabase).ensureOriginalPhysicalFile(asset.id);
      const sidecarPath = `${originalPath}.xmp`;
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: sidecarPath });

      await commit(repository, asset.id, `/data/upload/${user.id}/moved.jpg`, MediaHealthCategory.Missing);
      await commit(repository, asset.id, originalPath, category);

      // the follow-up sidecar discovery Library Care queues, with the sidecar still beside the original
      ctx
        .getMock(StorageRepository)
        .checkFileExists.mockImplementation((path) => Promise.resolve(path === sidecarPath));
      await metadata.handleSidecarCheck({ id: asset.id });

      const { rows } = await sql<{
        ownerId: string;
        originalPath: string;
        localDateTime: Date;
        canonicalAssetId: string | null;
        sidecarPath: string | null;
        latitude: number | null;
        longitude: number | null;
        timeZone: string | null;
        source: string;
      }>`
        SELECT a."ownerId", a."originalPath", a."localDateTime", p."canonicalAssetId",
          (SELECT path FROM asset_file f WHERE f."assetId" = a.id AND f.type = 'sidecar') AS "sidecarPath",
          e.latitude, e.longitude, e."timeZone", c.evidence ->> 'source' AS source
        FROM asset a
        JOIN physical_file p ON p.id = a."physicalOriginalFileId"
        JOIN asset_exif e ON e."assetId" = a.id
        JOIN asset_checksum c ON c."assetId" = a.id
        WHERE a.id = ${asset.id}::uuid
      `.execute(defaultDatabase);
      expect(rows).toEqual([
        {
          ownerId: user.id,
          originalPath,
          localDateTime,
          canonicalAssetId: asset.id,
          sidecarPath,
          latitude: 51.0447,
          longitude: -114.0719,
          timeZone: 'America/Edmonton',
          // checksum provenance: digests Library Care verified; who and from where is on the finding
          source: 'recovery',
        },
      ]);
    },
  );
});
