import { describe, expect, it } from 'vitest';
import {
  behindAfterMs,
  clockTime,
  cronToSchedule,
  sameSchedule,
  scheduleToCron,
  scheduleWords,
  viewerTime,
  type BackupSchedule,
} from '$lib/frameleaf/backup-schedule';

describe('a stored schedule as a choice (FL-362)', () => {
  it.each([
    ['0 02 * * *', { every: 'day', time: '02:00' }],
    ['0 2 * * *', { every: 'day', time: '02:00' }],
    ['30 23 * * *', { every: 'day', time: '23:30' }],
    ['0 0 * * *', { every: 'day', time: '00:00' }],
    // Every day of the week is every day.
    ['0 3 * * 0-6', { every: 'day', time: '03:00' }],
    ['0 3 * * 1,2,3,4,5,6,7', { every: 'day', time: '03:00' }],
    ['0 3 * * 0', { every: 'days', days: [0], time: '03:00' }],
    ['0 3 * * 7', { every: 'days', days: [0], time: '03:00' }],
    ['0 3 * * SUN', { every: 'days', days: [0], time: '03:00' }],
    ['15 1 * * 1-5', { every: 'days', days: [1, 2, 3, 4, 5], time: '01:15' }],
    ['0 2 * * 6,mon,3', { every: 'days', days: [1, 3, 6], time: '02:00' }],
    ['0 */6 * * *', { every: 'hours', hours: 6 }],
    ['0 0-23/12 * * *', { every: 'hours', hours: 12 }],
    // An expression with a seconds field that fires on the minute.
    ['0 0 2 * * *', { every: 'day', time: '02:00' }],
    ['  0   2 * * *  ', { every: 'day', time: '02:00' }],
  ])('%s', (cron, expected) => {
    expect(cronToSchedule(cron)).toEqual(expected);
  });

  it.each([
    '0 2 1 * *', // a day of the month
    '0 2 * 6 *', // one month
    '*/15 * * * *', // every quarter of an hour
    '0 2,14 * * *', // twice a day at chosen hours
    '0 */5 * * *', // a gap that does not divide a day
    '30 */6 * * *', // every few hours, off the hour
    '0 */6 * * 1', // every few hours on one day
    '0 2 * * 5-1', // a range that wraps
    '0 2 * * 1-3-5',
    '0 25 * * *',
    '15 0 2 * * *', // seconds other than 0
    '@daily',
    '',
    'not a schedule',
  ])('keeps "%s" as Custom, exactly as stored', (cron) => {
    expect(cronToSchedule(cron)).toEqual({ every: 'custom', cron });
    expect(scheduleToCron(cronToSchedule(cron))).toBe(cron);
  });
});

describe('a choice as a stored schedule (FL-362)', () => {
  it('writes each choice as one expression', () => {
    expect(scheduleToCron({ every: 'day', time: '02:00' })).toBe('0 2 * * *');
    expect(scheduleToCron({ every: 'day', time: '23:05' })).toBe('5 23 * * *');
    expect(scheduleToCron({ every: 'days', days: [6, 0, 6], time: '04:30' })).toBe('30 4 * * 0,6');
    expect(scheduleToCron({ every: 'hours', hours: 6 })).toBe('0 */6 * * *');
  });

  it('reads back what it wrote', () => {
    const schedules: BackupSchedule[] = [
      { every: 'day', time: '02:00' },
      { every: 'days', days: [1, 3, 5], time: '21:45' },
      { every: 'hours', hours: 12 },
    ];
    for (const schedule of schedules) {
      expect(cronToSchedule(scheduleToCron(schedule))).toEqual(schedule);
    }
  });

  it('knows two spellings of one schedule, and never equates a custom one with anything else', () => {
    expect(sameSchedule('0 02 * * *', '0 2 * * *')).toBe(true);
    expect(sameSchedule('0 3 * * 7', '0 3 * * SUN')).toBe(true);
    expect(sameSchedule('0 2 * * *', '0 3 * * *')).toBe(false);
    expect(sameSchedule('0 2 1 * *', '0 2 1 * *')).toBe(true);
    expect(sameSchedule('0 2 1 * *', '0 2 2 * *')).toBe(false);
  });
});

describe('the schedule said back (FL-362)', () => {
  it('says how often and when', () => {
    expect(scheduleWords({ every: 'day', time: '02:00' }, 'en-US')).toEqual({
      key: 'frameleaf_backup_schedule_every_day',
      values: { time: '2:00 AM' },
    });
    expect(scheduleWords({ every: 'days', days: [0, 3], time: '14:30' }, 'en-US')).toEqual({
      key: 'frameleaf_backup_schedule_every_days',
      values: { days: 'Sunday and Wednesday', time: '2:30 PM' },
    });
    expect(scheduleWords({ every: 'hours', hours: 6 }, 'en-US').values).toEqual({ hours: 6 });
    expect(scheduleWords({ every: 'custom', cron: '0 2 1 * *' }, 'en-US').key).toBe(
      'frameleaf_backup_schedule_custom_words',
    );
  });

  it('writes the time as the viewer’s language does', () => {
    expect(clockTime('14:05', 'en-US')).toBe('2:05 PM');
    expect(clockTime('14:05', 'de-DE')).toBe('14:05');
  });
});

describe('the server’s time and the viewer’s (FL-362)', () => {
  const winter = new Date('2026-01-15T12:00:00Z');
  const summer = new Date('2026-07-15T12:00:00Z');

  it('says nothing when both are in the same zone, or keep the same clock', () => {
    expect(viewerTime('02:00', 'America/Edmonton', 'America/Edmonton', winter)).toBeUndefined();
    expect(viewerTime('02:00', 'America/Edmonton', 'America/Denver', winter)).toBeUndefined();
  });

  it('gives the server’s start time on the viewer’s clock', () => {
    // A server kept in UTC (the default in a container), seen from Edmonton.
    expect(viewerTime('02:00', 'UTC', 'America/Edmonton', winter)).toBe('19:00');
    expect(viewerTime('02:00', 'UTC', 'America/Edmonton', summer)).toBe('20:00');
    expect(viewerTime('02:00', 'America/Edmonton', 'Europe/Berlin', winter)).toBe('10:00');
    expect(viewerTime('23:30', 'Asia/Kolkata', 'UTC', winter)).toBe('18:00');
  });

  it('says nothing for a zone it does not know', () => {
    expect(viewerTime('02:00', 'Not/AZone', 'UTC', winter)).toBeUndefined();
  });
});

describe('when a schedule counts as behind (FL-362)', () => {
  const days = (ms: number) => ms / 86_400_000;
  it('allows three days, or the longest wait between chosen days and two more', () => {
    expect(days(behindAfterMs({ every: 'day', time: '02:00' }))).toBe(3);
    expect(days(behindAfterMs({ every: 'hours', hours: 6 }))).toBe(3);
    expect(days(behindAfterMs({ every: 'days', days: [0], time: '02:00' }))).toBe(9);
    expect(days(behindAfterMs({ every: 'days', days: [1, 2], time: '02:00' }))).toBe(8);
    expect(days(behindAfterMs({ every: 'days', days: [0, 1, 2, 3, 4, 5], time: '02:00' }))).toBe(4);
    expect(days(behindAfterMs({ every: 'custom', cron: '0 2 1 * *' }))).toBe(3);
  });
});
