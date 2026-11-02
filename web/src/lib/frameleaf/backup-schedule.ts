/**
 * The backup schedule in plain words (FL-362). The server keeps a schedule as a cron expression; a
 * person chooses how often and at what time. These functions go both ways and say the result back as
 * a sentence. An expression the choices cannot express is `custom`: it is never rewritten or guessed
 * at, it keeps running, and the page says so.
 *
 * Times are the server's own clock: the expression runs in the server's time zone, so "2:00 AM" here
 * is 2:00 AM where the server is. `viewerTime` gives the same moment where the viewer is.
 */
import { DateTime } from 'luxon';
import type { Words } from '$lib/frameleaf/backup-overview';

/** Days of the week as cron numbers them: Sunday is 0. */
export const WEEK_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** The gaps "every few hours" offers: the ones that divide a day evenly. */
export const HOUR_STEPS = [2, 3, 4, 6, 8, 12] as const;

export type BackupSchedule =
  | { every: 'day'; time: string }
  /** `days` are cron day numbers, sorted, at least one and not all seven. */
  | { every: 'days'; days: number[]; time: string }
  | { every: 'hours'; hours: number }
  | { every: 'custom'; cron: string };

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (value: number) => String(value).padStart(2, '0');
const whole = (text: string, max: number) => (/^\d{1,2}$/.test(text) && Number(text) <= max ? Number(text) : null);

/** The days a day-of-week field names (lists, ranges and names), or null when it is anything else. */
const parseDays = (field: string): number[] | null => {
  const days = new Set<number>();
  for (const part of field.toLowerCase().split(',')) {
    const [from, to, extra] = part.split('-', 3);
    const day = (text: string | undefined) => {
      if (text === undefined) {
        return null;
      }
      const named = DAY_NAMES.indexOf(text);
      // Raw numbers (0–7) here, so `0-7` and `5-7` are ranges; `% 7` folds 7 to Sunday below.
      return named === -1 ? whole(text, 7) : named;
    };
    const start = day(from);
    const end = to === undefined ? start : day(to);
    if (start === null || end === null || extra !== undefined || (to !== undefined && end < start)) {
      return null;
    }
    for (let value = start; value <= end; value++) {
      days.add(value % 7);
    }
  }
  return [...days].sort((a, b) => a - b);
};

/** What a stored expression means as a choice; `custom` when the choices cannot say it. */
export const cronToSchedule = (cron: string): BackupSchedule => {
  const custom: BackupSchedule = { every: 'custom', cron };
  const fields = cron.trim().split(/\s+/);
  // An expression with a seconds field is one of ours only when it fires on the minute.
  if (fields.length === 6 && fields[0] === '0') {
    fields.shift();
  }
  if (fields.length !== 5) {
    return custom;
  }
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*') {
    return custom;
  }
  const minute = whole(minuteField, 59);
  if (minute === null) {
    return custom;
  }
  const step = /^(?:\*|0-23)\/(\d{1,2})$/.exec(hourField);
  if (step) {
    const hours = Number(step[1]);
    return minute === 0 && dayOfWeek === '*' && HOUR_STEPS.includes(hours as (typeof HOUR_STEPS)[number])
      ? { every: 'hours', hours }
      : custom;
  }
  const hour = whole(hourField, 23);
  if (hour === null) {
    return custom;
  }
  const time = `${pad(hour)}:${pad(minute)}`;
  if (dayOfWeek === '*') {
    return { every: 'day', time };
  }
  const days = parseDays(dayOfWeek);
  if (!days || days.length === 0) {
    return custom;
  }
  return days.length === 7 ? { every: 'day', time } : { every: 'days', days, time };
};

/** The expression that runs a choice. A custom schedule is stored exactly as it was. */
export const scheduleToCron = (schedule: BackupSchedule): string => {
  if (schedule.every === 'custom') {
    return schedule.cron;
  }
  if (schedule.every === 'hours') {
    return `0 */${schedule.hours} * * *`;
  }
  const [hour, minute] = schedule.time.split(':').map(Number);
  const days = schedule.every === 'days' ? [...new Set(schedule.days)].sort((a, b) => a - b).join(',') : '*';
  return `${minute} ${hour} * * ${days}`;
};

/** Whether two expressions run at the same times, however they are written ("0 02 * * *", "0 2 * * *"). */
export const sameSchedule = (a: string, b: string) => {
  const [first, second] = [cronToSchedule(a), cronToSchedule(b)];
  return first.every === 'custom' || second.every === 'custom'
    ? a.trim() === b.trim()
    : scheduleToCron(first) === scheduleToCron(second);
};

/** A clock time as the viewer's language writes it: "2:00 AM", "02:00". */
export const clockTime = (time: string, locale?: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 0, 1, hour, minute)),
  );
};

/** A day's name: "Sunday". 4 January 2026 was a Sunday. */
export const dayName = (day: number, locale?: string, width: 'long' | 'short' = 'long') =>
  new Intl.DateTimeFormat(locale, { weekday: width, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + day)));

/** The schedule as a person would say it: "Every day at 2:00 AM". */
export const scheduleWords = (schedule: BackupSchedule, locale?: string): Words => {
  switch (schedule.every) {
    case 'day': {
      return { key: 'frameleaf_backup_schedule_every_day', values: { time: clockTime(schedule.time, locale) } };
    }
    case 'days': {
      const days = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
        schedule.days.map((day) => dayName(day, locale)),
      );
      return { key: 'frameleaf_backup_schedule_every_days', values: { days, time: clockTime(schedule.time, locale) } };
    }
    case 'hours': {
      return { key: 'frameleaf_backup_schedule_every_hours', values: { hours: schedule.hours } };
    }
    case 'custom': {
      return { key: 'frameleaf_backup_schedule_custom_words' };
    }
  }
};

/**
 * The server's start time on the viewer's own clock, when the two are in different time zones;
 * undefined when they agree (or a zone is unknown), so nothing extra needs saying. `on` is the day the
 * difference is worked out for, since daylight saving changes it.
 */
export const viewerTime = (
  time: string,
  serverZone: string,
  viewerZone: string,
  on: Date = new Date(),
): string | undefined => {
  const [hour, minute] = time.split(':').map(Number);
  const atServer = DateTime.fromJSDate(on, { zone: serverZone }).set({ hour, minute, second: 0, millisecond: 0 });
  const atViewer = atServer.setZone(viewerZone);
  if (!atServer.isValid || !atViewer.isValid || atServer.offset === atViewer.offset) {
    return undefined;
  }
  return atViewer.toFormat('HH:mm');
};

/** How long a backup may go unfinished before a schedule counts as behind: three of its own gaps, at least three days. */
export const behindAfterMs = (schedule: BackupSchedule) => {
  const day = 86_400_000;
  if (schedule.every === 'days') {
    // The longest wait between two chosen days, going round the week.
    const gaps = schedule.days.map((value, index) => {
      const next = schedule.days[(index + 1) % schedule.days.length];
      return (next - value + 7) % 7 || 7;
    });
    return Math.max(3, Math.max(...gaps) + 2) * day;
  }
  return 3 * day;
};
