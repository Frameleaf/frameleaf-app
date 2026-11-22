/**
 * FL-1677: Cloud Backup's upload hours, in the server's chosen time zone (as the schedule is). A window may
 * run past midnight (22:00 to 06:00); a start equal to its stop means all day.
 * ponytail: the moment it opens or closes is counted in minutes from now, so on a day the clocks change it
 * can be an hour off; the next check corrects it.
 */
export type UploadHours = { enabled: boolean; start: string; stop: string };

const DAY = 24 * 60;
const minutes = (time: string) => {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
};

/** The time of day in a time zone, in minutes and the seconds past it. */
const clock = (now: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((value) => value.type === type)?.value ?? 0);
  return { at: part('hour') * 60 + part('minute'), seconds: part('second') * 1000 + now.getMilliseconds() };
};

/** Whether uploads may run now; while they may, when they must stop; while not, when they may start. */
export const uploadWindow = (
  hours: UploadHours,
  timeZone: string,
  now = new Date(),
): { open: true; closesAt: Date | null } | { open: false; opensAt: Date } => {
  const start = minutes(hours.start);
  const stop = minutes(hours.stop);
  if (!hours.enabled || start === stop) {
    return { open: true, closesAt: null };
  }
  const { at, seconds } = clock(now, timeZone);
  const open = start < stop ? at >= start && at < stop : at >= start || at < stop;
  const until = (time: number) => new Date(now.getTime() - seconds + ((time - at + DAY) % DAY || DAY) * 60_000);
  return open ? { open, closesAt: until(stop) } : { open, opensAt: until(start) };
};
