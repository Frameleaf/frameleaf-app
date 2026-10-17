import { randomUUID } from 'node:crypto';
import { PhysicalFileType } from 'src/enum.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('physical original ingestion authority', () => {
  const fixture = (linked: boolean, live: boolean) => {
    const id = randomUUID();
    const physicalId = randomUUID();
    const file = { checksum: Buffer.alloc(32, 4), sizeInBytes: 1000 };
    const physical = {
      id: physicalId,
      path: '/data/upload/fixture.jpg',
      canonicalAssetId: linked ? randomUUID() : id,
      type: PhysicalFileType.Original,
      ...file,
    };
    const ingestion = { resourceId: randomUUID(), token: randomUUID(), ownerId: randomUUID() };
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.includes('from "asset_upload_resource"')) return { rows: live ? [{ id: ingestion.resourceId }] : [] };
      if (sql.includes('from "asset"'))
        return { rows: [{ id, originalPath: physical.path, physicalOriginalFileId: linked ? physicalId : null }] };
      if (sql.includes('into "physical_file"') || sql.includes('from "physical_file"')) return { rows: [physical] };
      return { numAffectedRows: 1n };
    });
    const sut = new PhysicalFileRepository(db);
    vi.spyOn(sut, 'getServerOriginalCandidate').mockResolvedValue(undefined);
    return { sut, queries, id, file, ingestion, checks: { verify: vi.fn(), identify: vi.fn() } };
  };

  it.each([false, true])('refuses expired ingestion on the already-linked=%s path', async (linked) => {
    const f = fixture(linked, false);
    await expect(f.sut.linkUploadedOriginal(f.id, f.file, { ...f.checks, ingestion: f.ingestion })).rejects.toThrow(
      'Upload ingestion claim expired',
    );
    expect(f.queries.at(-1)?.sql).toBe('rollback');
    expect(f.queries.some(({ sql }) => sql.includes('insert into "physical_file"'))).toBe(false);
  });

  it.each([false, true])('accepts current ingestion on the already-linked=%s path', async (linked) => {
    const f = fixture(linked, true);
    await expect(
      f.sut.linkUploadedOriginal(f.id, f.file, { ...f.checks, ingestion: f.ingestion }),
    ).resolves.toMatchObject({ linked });
    const guard = f.queries.find(({ sql }) => sql.includes('from "asset_upload_resource"'));
    expect(guard?.sql).toContain('"ingestionLeaseExpiresAt" > clock_timestamp()');
    expect(guard?.parameters).toEqual(
      expect.arrayContaining([f.ingestion.resourceId, f.ingestion.ownerId, f.id, f.file.checksum, f.ingestion.token]),
    );
    expect(f.queries.at(-1)?.sql).toBe('commit');
  });

  it('retains ordinary uploads without an ingestion claim', async () => {
    const f = fixture(false, false);
    await expect(f.sut.linkUploadedOriginal(f.id, f.file, f.checks)).resolves.toMatchObject({ linked: false });
    expect(f.queries.some(({ sql }) => sql.includes('from "asset_upload_resource"'))).toBe(false);
  });
});
