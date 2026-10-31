import { DateTime, IANAZone } from 'luxon';

/**
 * FL-426: the time zone this server keeps its clock in (Settings › Server name & welcome). Schedules
 * (overnight work, backups, library scans, file checks), the next start the settings show and the
 * calendar day of the Frameleaf Cloud description budget all follow it.
 *
 * An empty `server.timeZone` is the computer's own zone (its `TZ`), which is how every server ran
 * before the choice existed.
 */
export const isServerTimeZone = (zone: string) => zone === '' || IANAZone.isValidZone(zone);

/** The computer's own zone, which an empty choice means. */
export const systemTimeZone = () => DateTime.local().zoneName ?? 'UTC';

/** The zone the server's times are in: the one chosen, else the computer's own. */
export const serverTimeZone = (server?: { timeZone?: string }) => server?.timeZone || systemTimeZone();
