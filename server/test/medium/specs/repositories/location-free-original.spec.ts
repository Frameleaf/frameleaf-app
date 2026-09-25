import { ExifTool } from 'exiftool-vendored';
import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService, testAssetsDir } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-54: a partner the owner hides locations from receives originals through
 * `MetadataRepository.acquireLocationFreeOriginal`. These specs run the real exiftool and check the bytes
 * that would be served: no location tag in any group, the rest of the file intact, the source untouched.
 */

let database: Kysely<DB>;
// an independent reader, so the check does not rely on the code under test
const reader = new ExifTool({ maxProcs: 1 });

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database,
    real: [],
    mock: [LoggingRepository],
  });
  return { sut: ctx.get(MetadataRepository) };
};

const sha1 = (path: string) => createHash('sha1').update(readFileSync(path)).digest('hex');

// Canon's TimeZoneCity is the camera's home time zone setting ("London"), not where the photo was taken
const NOT_LOCATION = new Set(['TimeZoneCity']);

/** every tag, in any group, whose name says it places the file */
const readGps = async (path: string) => {
  const tags = await reader.readRaw(path, { readArgs: ['-a', '-G1', '-ee', '-n'], useMWG: false });
  return Object.keys(tags).filter((key) => {
    const name = key.split(':').at(-1) ?? key;
    return (
      !NOT_LOCATION.has(name) && /^gps|^location|city$|country|province|sub-?location|^state$|coordinates/i.test(name)
    );
  });
};

const newGpsJpeg = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'location-free-original-'));
  const path = join(dir, 'with-gps.jpg');
  await sharp({ create: { width: 16, height: 8, channels: 3, background: '#3366aa' } })
    .jpeg()
    .toFile(path);
  await reader.write(
    path,
    {
      Make: 'Canon',
      Model: 'EOS 70D',
      GPSLatitude: 39.115,
      GPSLatitudeRef: 'N',
      GPSLongitude: -108.4009,
      GPSLongitudeRef: 'W',
      GPSAltitude: 1483.9,
      'XMP:GPSLatitude': 39.115,
      'XMP:GPSLongitude': -108.4009,
      City: 'Thompson Springs',
      Country: 'United States',
    } as never,
    { writeArgs: ['-overwrite_original'] },
  );
  return path;
};

beforeAll(async () => {
  database = await getKyselyDB();
});

afterAll(async () => {
  await reader.end();
});

describe('MetadataRepository.acquireLocationFreeOriginal', () => {
  it('serves a copy without any location tag and leaves the original untouched', async () => {
    const { sut } = setup();
    const source = await newGpsJpeg();
    const before = sha1(source);

    expect(await readGps(source)).toEqual(
      expect.arrayContaining(['GPS:GPSLatitude', 'GPS:GPSLongitude', 'XMP-exif:GPSLatitude']),
    );

    const lease = await sut.acquireLocationFreeOriginal(source);

    expect(lease.path).not.toBe(source);
    expect(await readGps(lease.path)).toEqual([]);
    expect(await sut.readLocationTags(lease.path)).toEqual([]);
    // the rest of the metadata and the image itself survive
    const copy = await reader.readRaw(lease.path, { readArgs: ['-G1'], useMWG: false });
    expect(copy).toMatchObject({ 'IFD0:Make': 'Canon', 'IFD0:Model': 'EOS 70D' });
    await expect(sharp(lease.path).metadata()).resolves.toMatchObject({ width: 16, height: 8 });
    // the original keeps its bytes (and its location) for the owner
    expect(sha1(source)).toBe(before);

    lease.release();
    await sut.teardown();
    expect(existsSync(lease.path)).toBe(false);
  });

  it('hands out the original itself when it carries no location', async () => {
    const { sut } = setup();
    const dir = mkdtempSync(join(tmpdir(), 'location-free-original-'));
    const source = join(dir, 'plain.jpg');
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
      .jpeg()
      .toFile(source);

    const lease = await sut.acquireLocationFreeOriginal(source);

    expect(lease.path).toBe(source);
    lease.release();
    await sut.teardown();
    expect(existsSync(source)).toBe(true);
  });

  it('shares one copy between concurrent readers', async () => {
    const { sut } = setup();
    const source = await newGpsJpeg();

    const [first, second] = await Promise.all([
      sut.acquireLocationFreeOriginal(source),
      sut.acquireLocationFreeOriginal(source),
    ]);

    expect(first.path).toBe(second.path);
    first.release();
    second.release();
    await sut.teardown();
  });

  it('fails closed on a damaged file whose location exiftool cannot rewrite', async () => {
    const { sut } = setup();
    const source = await newGpsJpeg();
    // cut the file inside its metadata segments: exiftool can no longer vouch for it
    writeFileSync(source, readFileSync(source).subarray(0, 400));

    await expect(sut.acquireLocationFreeOriginal(source)).rejects.toBeDefined();
    await sut.teardown();
  });

  it('refuses a copy that still carries a location', async () => {
    const { sut } = setup();
    const source = await newGpsJpeg();
    // simulate exiftool reporting success while leaving the location in place
    const write = vi
      .spyOn(sut, 'writeLocationFreeCopy')
      .mockImplementation((from, to) => Promise.resolve(copyFileSync(from, to)));

    await expect(sut.acquireLocationFreeOriginal(source)).rejects.toThrow(/Location tags remain/);
    expect(write).toHaveBeenCalledTimes(1);
    const [, destination] = write.mock.calls[0];
    expect(existsSync(destination)).toBe(false);
    await sut.teardown();
  });

  const fixtures = [
    'metadata/gps-position/thompson-springs.jpg',
    'formats/heic/IMG_2682.heic',
    'formats/raw/Canon/EOS_70D.CR2',
    'formats/raw/Ricoh/GR3/Ricoh_GR3-450.DNG',
    'formats/motionphoto/pixel-8a.jpg',
    'videos/waterfall.mp4',
    'videos/train.mov',
  ];

  describe.each(fixtures)('%s', (fixture) => {
    const source = resolve(testAssetsDir, fixture);

    it.skipIf(!existsSync(source))('has no location left in the served copy', async () => {
      const { sut } = setup();
      const before = sha1(source);
      expect((await readGps(source)).length).toBeGreaterThan(0);

      const lease = await sut.acquireLocationFreeOriginal(source);

      expect(lease.path).not.toBe(source);
      expect(await readGps(lease.path)).toEqual([]);
      expect(sha1(source)).toBe(before);
      lease.release();
      await sut.teardown();
    });
  });
});
