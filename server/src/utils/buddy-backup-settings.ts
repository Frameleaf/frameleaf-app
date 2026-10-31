import { CronTime } from 'cron';
import z from 'zod';
import type { BuddySettings } from 'src/repositories/buddy-backup.repository.js';
import { BuddySettingsSchema } from 'src/dtos/buddy-backup.dto.js';

/** Source storage bindings are encrypted reference data, never replacement hosting authority. */
export type BuddySettingsSnapshot = { version: 1; settings: BuddySettings };
const snapshot = z.strictObject({ version: z.literal(1), settings: BuddySettingsSchema });

export const readBuddySettingsSnapshot = (value: unknown): BuddySettingsSnapshot | undefined => {
  if (value === undefined) {
    return;
  }
  const saved = snapshot.parse(value);
  new CronTime(saved.settings.schedule, saved.settings.timezone);
  new Intl.DateTimeFormat('en', { timeZone: saved.settings.timezone }).format();
  return saved;
};
