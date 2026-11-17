/**
 * FL-1677: Cloud Backup's upload hours, in the server's own time zone. A window may run past midnight
 * (22:00 to 06:00); a start equal to its stop means all day.
 */
export type UploadHours = { enabled: boolean; start: string; stop: string };

const minutes = (time: string) => {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
};

/** The next moment, after `now`, whose local time is `time`. */
const next = (now: Date, time: string) => {
  const at = new Date(now);
  at.setHours(0, minutes(time), 0, 0);
  if (at <= now) {
    at.setDate(at.getDate() + 1);
  }
  return at;
};

/** Whether uploads may run now; while they may, when they must stop; while not, when they may start. */
export const uploadWindow = (
  hours: UploadHours,
  now = new Date(),
): { open: true; closesAt: Date | null } | { open: false; opensAt: Date } => {
  const start = minutes(hours.start);
  const stop = minutes(hours.stop);
  if (!hours.enabled || start === stop) {
    return { open: true, closesAt: null };
  }
  const at = now.getHours() * 60 + now.getMinutes();
  const open = start < stop ? at >= start && at < stop : at >= start || at < stop;
  return open ? { open, closesAt: next(now, hours.stop) } : { open, opensAt: next(now, hours.start) };
};
