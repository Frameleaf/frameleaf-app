import { createHash } from 'node:crypto';
import {
  CLOUD_BACKUP_VERIFY_SLICES,
  inVerifySlice,
  isoWeekOf,
  retentionPlan,
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

describe('cloud backup retention (FL-164)', () => {
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
});
