import { Kysely } from 'kysely';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newDate } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(MetadataRepository) };
};

beforeAll(async () => {
  database = await getKyselyDB();
});

describe(MetadataRepository.name, () => {
  describe('writeTags', () => {
    it('should write an empty description', async () => {
      const { sut } = setup();
      const dir = mkdtempSync(join(tmpdir(), 'metadata-medium-write-tags'));
      const sidecarFile = join(dir, 'sidecar.xmp');

      await sut.writeTags(sidecarFile, { Description: '' });
      expect(readFileSync(sidecarFile).toString()).toEqual(expect.stringContaining('rdf:Description'));
    });

    it('should write an empty tags list', async () => {
      const { sut } = setup();
      const dir = mkdtempSync(join(tmpdir(), 'metadata-medium-write-tags'));
      const sidecarFile = join(dir, 'sidecar.xmp');

      await sut.writeTags(sidecarFile, { TagsList: [] });
      const fileContent = readFileSync(sidecarFile).toString();
      expect(fileContent).toEqual(expect.stringContaining('digiKam:TagsList'));
      expect(fileContent).toEqual(expect.stringContaining('<rdf:li/>'));
    });

    it('fails when the sidecar could not be written (FL-195)', async () => {
      const { sut } = setup();
      const dir = mkdtempSync(join(tmpdir(), 'metadata-medium-write-tags'));
      // exiftool cannot create the file, as when a concurrent rewrite of the same sidecar lost it
      const sidecarFile = join(dir, 'missing', 'sidecar.xmp');

      await expect(sut.writeTags(sidecarFile, { Description: 'lost' })).rejects.toThrow();
    });
  });

  describe('sidecar writes (FL-195)', () => {
    it('run one at a time per asset, and side by side for different assets', async () => {
      const { ctx } = newMediumService(BaseService, {
        database,
        real: [DatabaseRepository],
        mock: [LoggingRepository],
      });
      const db = ctx.get(DatabaseRepository);
      const events: string[] = [];
      const write = (assetId: string, name: string) =>
        db.withAssetSidecarLock(assetId, async () => {
          events.push(`${name} start`);
          await new Promise((resolve) => setTimeout(resolve, 200));
          events.push(`${name} end`);
        });

      const one = '00000000-0000-4000-8000-000000000001';
      const two = '00000000-0000-4000-8000-000000000002';
      await Promise.all([write(one, 'a'), write(one, 'b')]);
      expect(
        events.indexOf('a end') < events.indexOf('b start') || events.indexOf('b end') < events.indexOf('a start'),
      ).toBe(true);

      events.length = 0;
      await Promise.all([write(one, 'c'), write(two, 'd')]);
      expect(events.slice(0, 2).toSorted()).toEqual(['c start', 'd start']);
    });
  });

  it('should write tags', async () => {
    const { sut } = setup();
    const dir = mkdtempSync(join(tmpdir(), 'metadata-medium-write-tags'));
    const sidecarFile = join(dir, 'sidecar.xmp');

    await sut.writeTags(sidecarFile, {
      Description: 'my-description',
      ImageDescription: 'my-image-description',
      DateTimeOriginal: newDate().toISOString(),
      GPSLatitude: 42,
      GPSLongitude: 69,
      Rating: 3,
      TagsList: ['tagA'],
    });

    const fileContent = readFileSync(sidecarFile).toString();
    expect(fileContent).toEqual(expect.stringContaining('my-description'));
    expect(fileContent).toEqual(expect.stringContaining('my-image-description'));
    expect(fileContent).toEqual(expect.stringContaining('exif:DateTimeOriginal'));
    expect(fileContent).toEqual(expect.stringContaining('<exif:GPSLatitude>42,0.0N</exif:GPSLatitude>'));
    expect(fileContent).toEqual(expect.stringContaining('<exif:GPSLongitude>69,0.0E</exif:GPSLongitude>'));
    expect(fileContent).toEqual(expect.stringContaining('<xmp:Rating>3</xmp:Rating>'));
    expect(fileContent).toEqual(expect.stringContaining('tagA'));
  });
});
