import type { JobRunPageDto } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import type { ActivityFilter } from '$lib/frameleaf/activity';

export type FileCheck = NonNullable<JobRunPageDto['fileCheck']>;

/**
 * FL-1430: Library care's file check on Recent work: running, or finished with what it found (damaged and missing
 * files, warn; nothing, good), and which filter it shows under (running, failed when it found something, done).
 */
type Words = { key: Translations; values: Record<string, number> };

export const fileCheckView = (
  check: FileCheck,
): {
  status: Translations;
  tone: 'good' | 'warn';
  /** what the finished checks found (nothing found, when all of them finished) */
  found: Words | null;
  /** that some of it didn't finish */
  note: Words | null;
  bucket: Exclude<ActivityFilter, 'all'>;
} => {
  if (check.running) {
    return { status: 'frameleaf_job_runs_state_running', tone: 'good', found: null, note: null, bucket: 'running' };
  }
  const { damaged, missing } = check;
  const bad = damaged + missing > 0;
  const found: Words | null =
    damaged > 0 && missing > 0
      ? { key: 'frameleaf_job_runs_file_check_found_both' as Translations, values: { damaged, missing } }
      : damaged > 0
        ? { key: 'frameleaf_job_runs_file_check_found_damaged' as Translations, values: { count: damaged } }
        : missing > 0
          ? { key: 'frameleaf_job_runs_file_check_found_missing' as Translations, values: { count: missing } }
          : null;
  // a check that failed or was cancelled didn't get through its work; what the others found still shows
  if (check.failed) {
    return {
      status: 'frameleaf_job_runs_status_unfinished',
      tone: 'warn',
      found,
      note: { key: 'frameleaf_job_runs_file_check_unfinished' as Translations, values: {} },
      bucket: 'failed',
    };
  }
  return {
    status: 'frameleaf_job_runs_status_finished',
    tone: bad ? 'warn' : 'good',
    found: found ?? { key: 'frameleaf_job_runs_file_check_found_none' as Translations, values: {} },
    note: null,
    bucket: bad ? 'failed' : 'done',
  };
};
