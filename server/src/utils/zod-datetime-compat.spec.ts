import { createRequire } from 'node:module';
import z from 'zod';
import { ICloudCoverageSchema } from 'src/dtos/icloud-identity.dto.js';
import { BuddyStatusReport } from 'src/utils/frameleaf-buddy.js';
import { backupRunReportSchema } from 'src/utils/frameleaf-cloud-backup.js';
import { isoDatetimeToDate } from 'src/validation.js';

const require = createRequire(import.meta.url);
const common = require('zod') as typeof import('zod');

it.each([z, common.z])('preserves default datetime precision in both module formats', (schema) => {
  for (const value of [
    '2026-10-13T08:32Z',
    '2024-02-29T08:32:01Z',
    '2026-10-13T08:32:01.125Z',
    '2026-10-13T08:32+05:30',
  ]) {
    expect(schema.iso.datetime({ offset: true }).safeParse(value).success, value).toBe(true);
  }
  for (const value of [
    '2026-02-29T08:32Z',
    '2026-10-32T08:32Z',
    '2026-10-13T24:32Z',
    '2026-10-13T08:60Z',
    '2026-10-13T08:32:60Z',
    '2026-10-13T08:32+24:00',
    '2026-10-13T08:32',
  ]) {
    expect(schema.iso.datetime({ offset: true }).safeParse(value).success, value).toBe(false);
  }
  expect(schema.iso.datetime({ local: true }).safeParse('2026-10-13T08:32').success).toBe(true);
  expect(schema.iso.datetime().safeParse('2026-10-13T08:32+05:30').success).toBe(false);
});

it.each([-1, 0, 3])('keeps explicit precision %s unchanged', (precision) => {
  const values = ['2026-10-13T08:32Z', '2026-10-13T08:32:01Z', '2026-10-13T08:32:01.125Z'];
  for (const schema of [z, common.z]) {
    expect(values.map((value) => schema.iso.datetime({ precision }).safeParse(value).success)).toEqual(
      values.map((_, i) => i === [-1, 0, 3].indexOf(precision)),
    );
  }
});

it('keeps minute precision on shared codec, backup, iCloud and vault boundaries', () => {
  const minute = '2026-10-13T08:32Z';
  expect(isoDatetimeToDate.parse(minute).toISOString()).toBe('2026-10-13T08:32:00.000Z');
  expect(z.encode(isoDatetimeToDate, new Date(minute))).toBe('2026-10-13T08:32:00.000Z');
  const validators = [
    backupRunReportSchema.shape.startedAt,
    ICloudCoverageSchema.shape.samples.element.shape.creationDate,
    BuddyStatusReport.shape.lastCompleteAt,
  ];
  for (const validator of validators) {
    expect(validator.safeParse(minute).success).toBe(true);
    expect(validator.safeParse('2026-02-29T08:32Z').success).toBe(false);
  }
});
