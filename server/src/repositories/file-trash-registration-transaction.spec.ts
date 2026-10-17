import { AssetRepository } from 'src/repositories/asset.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it('writes EXIF on the supplied restore transaction without using its ordinary pool', async () => {
  const ordinary = scriptedKysely();
  const restore = scriptedKysely();
  const assets = new AssetRepository(ordinary.db);
  await restore.db
    .transaction()
    .execute((trx) =>
      assets.upsertExif(
        { exif: { assetId: 'asset-id', fileSizeInByte: 1234 }, lockedPropertiesBehavior: 'override' },
        trx,
      ),
    );
  expect(ordinary.queries).toEqual([]);
  expect(restore.queries.map(({ sql }) => (sql === 'begin' || sql === 'commit' ? sql : 'write'))).toEqual([
    'begin',
    'write',
    'commit',
  ]);
  expect(restore.queries[1].sql).toContain('insert into "asset_exif"');
  expect(restore.queries[1].parameters).toContain(1234);
});

it('checks original linking on the supplied restore transaction without opening another transaction', async () => {
  const ordinary = scriptedKysely();
  const restore = scriptedKysely();
  const files = new PhysicalFileRepository(ordinary.db);
  await restore.db
    .transaction()
    .execute((trx) =>
      files.linkUploadedOriginal(
        '0195e2a0-0000-7000-8000-000000000001',
        { checksum: Buffer.alloc(32, 1), sizeInBytes: 1234 },
        { verify: vi.fn(), identify: vi.fn() },
        { transaction: trx, proof: undefined },
      ),
    );
  expect(ordinary.queries).toEqual([]);
  expect(restore.queries.filter(({ sql }) => sql === 'begin')).toHaveLength(1);
  expect(restore.queries.at(-1)?.sql).toBe('commit');
  expect(restore.queries.some(({ sql }) => sql.includes('from "asset"'))).toBe(true);
});

it('keeps the restored file when the candidate changes after its proof, without hashing inside the transaction', async () => {
  const assetId = '0195e2a0-0000-7000-8000-000000000001';
  const originalPath = '/data/upload/restored.jpg';
  const physicalFile = { id: 'physical-id', path: originalPath, canonicalAssetId: assetId };
  const ordinary = scriptedKysely();
  const restore = scriptedKysely(({ sql }) => {
    if (sql.startsWith('select') && sql.includes('from "asset"')) {
      return { rows: [{ id: assetId, originalPath, physicalOriginalFileId: null }] };
    }
    if (sql.startsWith('insert into "physical_file"')) return { rows: [physicalFile] };
    return {};
  });
  const files = new PhysicalFileRepository(ordinary.db);
  vi.spyOn(files, 'getServerOriginalCandidate').mockResolvedValue({
    id: 'candidate-id',
    originalPath: '/data/library/new-candidate.jpg',
    physicalOriginalFileId: null,
  } as never);
  const verify = vi.fn();
  const identify = vi.fn();
  const result = await restore.db
    .transaction()
    .execute((transaction) =>
      files.linkUploadedOriginal(
        assetId,
        { checksum: Buffer.alloc(32, 1), sizeInBytes: 1234 },
        { verify, identify },
        { transaction, proof: { path: '/data/library/old-candidate.jpg', identity: 'old-file' } },
      ),
    );
  expect(result).toEqual({ physicalFile, linked: false });
  expect(verify).not.toHaveBeenCalled();
  expect(identify).not.toHaveBeenCalled();
  expect(ordinary.queries).toEqual([]);
  expect(restore.queries.filter(({ sql }) => sql === 'begin')).toHaveLength(1);
  expect(restore.queries.at(-1)?.sql).toBe('commit');
});
