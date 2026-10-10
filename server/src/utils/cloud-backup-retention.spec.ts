import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  CLOUD_BACKUP_VERIFY_SLICES,
  inVerifySlice,
  isoWeekOf,
  manifestReferences,
  manifestTime,
  readManifest,
  retentionPlan,
  unreferencedDumps,
  unreferencedObjects,
  verificationDue,
  verifySliceOf,
} from 'src/utils/cloud-backup-retention.js';

const hex = (text: string) => createHash('sha256').update(text).digest('hex');

/** A manifest made every night at 03:00 UTC for `days` days, ending on 2026-09-26. */
const nightly = (days: number) =>
  Array.from({ length: days }, (_, index) => {
    const createdAt = new Date(Date.UTC(2026, 8, 26 - index, 3));
    const key = `m/${createdAt.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+/, '')}.json.gz`;
    return { key, createdAt };
  });

const manifestBody = (overrides: Record<string, unknown> = {}) =>
  gzipSync(
    JSON.stringify({
      format: 'frameleaf-backup-manifest',
      version: 1,
      instanceId: 'instance-1',
      createdAt: '2026-09-26T03:00:00.000Z',
      database: { key: 'db/cloud-backup-immich-db-backup-1.sql.gz', sha256: hex('dump'), size: 10 },
      assets: {
        'asset-1': {
          owner: 'owner-1',
          files: [
            { role: 'original', path: '/data/a.jpg', sha256: hex('a'), size: 100, mtime: null },
            { role: 'sidecar', path: '/data/a.jpg.xmp', sha256: hex('x'), size: 5, mtime: null },
          ],
        },
      },
      profiles: { 'owner-1': { role: 'profile', path: '/data/p.jpg', sha256: hex('p'), size: 7, mtime: null } },
      ...overrides,
    }),
  );

describe('cloud backup retention (FL-164)', () => {
  describe(manifestTime.name, () => {
    it('reads the time from a manifest name and refuses any other name', () => {
      expect(manifestTime('m/20260926T030000Z.json.gz')).toEqual(new Date('2026-09-26T03:00:00.000Z'));
      expect(manifestTime('m/latest.json.gz')).toBeNull();
      expect(manifestTime('o/20260926T030000Z.json.gz')).toBeNull();
    });
  });

  describe(retentionPlan.name, () => {
    it('keeps 7 daily, 4 weekly and 12 monthly runs and removes the rest', () => {
      const manifests = nightly(400);
      const { keep, remove } = retentionPlan(manifests, { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 });

      // the last 7 nights, the newest run of 4 ISO weeks (3 of them older than the 7 nights) and the newest
      // run of 12 months (11 of them older than the weeks)
      expect(keep.map(({ key }) => key).slice(0, 7)).toEqual(manifests.slice(0, 7).map(({ key }) => key));
      expect(new Set(keep.map(({ createdAt }) => isoWeekOf(createdAt))).size).toBeGreaterThanOrEqual(4);
      expect(new Set(keep.map(({ createdAt }) => createdAt.toISOString().slice(0, 7))).size).toBe(12);
      expect(keep.length + remove.length).toBe(400);
      expect(keep.length).toBeLessThanOrEqual(7 + 4 + 12);
      // nothing is both kept and removed
      const kept = new Set(keep.map(({ key }) => key));
      expect(remove.some(({ key }) => kept.has(key))).toBe(false);
    });

    it('always keeps the newest run, whatever the settings say', () => {
      const { keep } = retentionPlan(nightly(3), { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 });

      expect(keep.map(({ key }) => key)).toEqual(['m/20260926T030000Z.json.gz']);
    });

    it('gives the same answer however the list is ordered', () => {
      const manifests = nightly(60);
      const settings = { keepDaily: 3, keepWeekly: 2, keepMonthly: 2 };

      expect(retentionPlan(manifests.toReversed(), settings)).toEqual(retentionPlan(manifests, settings));
    });
  });

  describe(unreferencedObjects.name, () => {
    it('offers only content-addressed objects no kept manifest names', () => {
      const objects = [
        { key: `o/${hex('a')}`, size: 1 },
        { key: `o/${hex('b')}`, size: 2 },
        { key: 'o/not-a-hash', size: 3 },
        { key: 'frameleaf-backup.json', size: 4 },
        { key: 'm/20260926T030000Z.json.gz', size: 5 },
      ];

      expect(unreferencedObjects(objects, new Set([hex('a')]))).toEqual([{ key: `o/${hex('b')}`, size: 2 }]);
    });

    it('offers only dumps no kept manifest names', () => {
      const dumps = [{ key: 'db/one.sql.gz' }, { key: 'db/two.sql.gz' }, { key: 'o/x' }];

      expect(unreferencedDumps(dumps, new Set(['db/one.sql.gz']))).toEqual([{ key: 'db/two.sql.gz' }]);
    });
  });

  describe('verification slices', () => {
    it('checks every object exactly once over 52 weeks', () => {
      const hashes = Array.from({ length: 500 }, (_, index) => hex(`file-${index}`));
      const counts = hashes.map(
        (sha256) =>
          Array.from({ length: CLOUD_BACKUP_VERIFY_SLICES }, (_, slice) => slice).filter((slice) =>
            inVerifySlice(sha256, slice),
          ).length,
      );

      expect(counts.every((count) => count === 1)).toBe(true);
      // about 1/52 of the objects fall in one week's slice
      const week = hashes.filter((sha256) => inVerifySlice(sha256, 0)).length;
      expect(week).toBeGreaterThan(0);
      expect(week).toBeLessThan(40);
    });

    it('moves to the next slice every week', () => {
      const now = new Date('2026-09-26T03:00:00.000Z');
      const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      expect(verifySliceOf(nextWeek)).toBe((verifySliceOf(now) + 1) % CLOUD_BACKUP_VERIFY_SLICES);
    });

    it('is due monthly in full, weekly as a sample, and never when turned off', () => {
      const now = new Date('2026-09-26T04:00:00.000Z');
      const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

      expect(verificationDue({ verifyWeekly: true }, now)).toBe('full');
      expect(verificationDue({ verifyWeekly: true, lastFullAt: daysAgo(31) }, now)).toBe('full');
      expect(verificationDue({ verifyWeekly: true, lastFullAt: daysAgo(10), lastSampleAt: daysAgo(8) }, now)).toBe(
        'sample',
      );
      expect(
        verificationDue({ verifyWeekly: true, lastFullAt: daysAgo(10), lastSampleAt: daysAgo(2) }, now),
      ).toBeNull();
      expect(verificationDue({ verifyWeekly: false }, now)).toBeNull();
    });
  });

  describe(readManifest.name, () => {
    it('reads a manifest and names every object and the dump it references', () => {
      const references = manifestReferences(readManifest(manifestBody()));

      expect(references.objects.keys().toArray().toSorted()).toEqual([hex('a'), hex('p'), hex('x')].toSorted());
      expect(references.database).toBe('db/cloud-backup-immich-db-backup-1.sql.gz');
    });

    it('reads a version 2 manifest with each item’s details, the albums and the people (FL-164)', () => {
      const details = {
        isFavorite: true,
        visibility: 'archive',
        rating: 4,
        description: 'Lake',
        dateTimeOriginal: '2026-08-14T09:12:00.000Z',
        timeZone: 'UTC+2',
        latitude: 46.5,
        longitude: 7.9,
        tags: ['Trips/Lake'],
        albums: [{ id: 'album-1', name: 'Lake house' }],
        faces: [{ personId: 'person-1', box: [1, 2, 3, 4], imageWidth: 10, imageHeight: 10, isHidden: false }],
        stack: { id: 'stack-1', isPrimary: true },
        edits: [{ action: 'crop', parameters: { x: 0, y: 0, width: 5, height: 5 } }],
      };
      const manifest = readManifest(
        manifestBody({
          version: 2,
          assets: {
            'asset-1': {
              owner: 'owner-1',
              files: [{ role: 'original', path: '/data/a.jpg', sha256: hex('a'), size: 100, mtime: null }],
              type: 'IMAGE',
              originalFileName: 'a.jpg',
              fileCreatedAt: '2026-08-14T07:12:00.000Z',
              fileModifiedAt: '2026-08-14T07:12:00.000Z',
              localDateTime: '2026-08-14T09:12:00.000Z',
              duration: null,
              details,
            },
          },
          albums: {
            'album-1': {
              name: 'Lake house',
              description: '',
              ownerId: 'owner-1',
              coverAssetId: 'asset-1',
              order: 'desc',
              sharedUsers: [{ userId: 'user-2', role: 'viewer' }],
            },
          },
          people: {
            'person-1': { ownerId: 'owner-1', name: 'Jamie', birthDate: null, isHidden: false, isFavorite: false },
          },
        }),
      );

      expect(manifest.version).toBe(2);
      expect(manifest.assets['asset-1'].details).toEqual(details);
      expect(manifest.assets['asset-1'].type).toBe('IMAGE');
      expect(manifest.albums['album-1']).toMatchObject({ name: 'Lake house', ownerId: 'owner-1' });
      expect(manifest.people['person-1']).toMatchObject({ name: 'Jamie' });
    });

    it('reads a version 1 manifest as one without details, albums or people', () => {
      const manifest = readManifest(manifestBody());
      expect(manifest.version).toBe(1);
      expect(manifest.assets['asset-1'].details).toBeUndefined();
      expect(manifest.albums).toEqual({});
      expect(manifest.people).toEqual({});
    });

    it('drops malformed details instead of failing the manifest, so its files can still come back', () => {
      const manifest = readManifest(
        manifestBody({
          version: 2,
          assets: {
            'asset-1': {
              owner: 'owner-1',
              files: [{ role: 'original', path: '/data/a.jpg', sha256: hex('a'), size: 100, mtime: null }],
              details: { isFavorite: 'yes', tags: 'none' },
            },
          },
          albums: { 'album-1': { name: 3 } },
        }),
      );
      expect(manifest.assets['asset-1'].details).toBeUndefined();
      expect(manifest.albums).toEqual({});
    });

    it('refuses anything it could not read in full', () => {
      expect(() => readManifest(Buffer.from('not gzip'))).toThrow('could not be read');
      expect(() => readManifest(manifestBody({ format: 'other' }))).toThrow('not a Frameleaf backup manifest');
      expect(() => readManifest(manifestBody({ version: 3 }))).toThrow('not a Frameleaf backup manifest');
      expect(() =>
        readManifest(
          manifestBody({
            assets: { 'asset-1': { owner: null, files: [{ role: 'original', path: '/a', sha256: 'abc', size: 1 }] } },
          }),
        ),
      ).toThrow('without a valid checksum');
    });
  });
});
