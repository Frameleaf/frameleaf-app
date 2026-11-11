import type { JobRunPageDto } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import type { ActivityFilter } from '$lib/frameleaf/activity';

export type FileCheck = NonNullable<JobRunPageDto['fileCheck']>;

/**
 * FL-1430: Library care's file check on Recent work: running, or finished with what it found (damaged and missing
 * files, warn; nothing, good), and which filter it shows under (running, failed when it found something, done).
 */
export const fileCheckView = (
  check: FileCheck,
): {
  status: Translations;
  tone: 'good' | 'warn';
  found: { key: Translations; values: Record<string, number> } | null;
  bucket: Exclude<ActivityFilter, 'all'>;
} => {
  if (check.running) {
    return { status: 'frameleaf_job_runs_state_running', tone: 'good', found: null, bucket: 'running' };
  }
  const { damaged, missing } = check;
  const found: { key: Translations; values: Record<string, number> } =
    damaged > 0 && missing > 0
      ? { key: 'frameleaf_job_runs_file_check_found_both' as Translations, values: { damaged, missing } }
      : damaged > 0
        ? { key: 'frameleaf_job_runs_file_check_found_damaged' as Translations, values: { count: damaged } }
        : missing > 0
          ? { key: 'frameleaf_job_runs_file_check_found_missing' as Translations, values: { count: missing } }
          : { key: 'frameleaf_job_runs_file_check_found_none' as Translations, values: {} };
  const bad = damaged + missing > 0;
  return {
    status: 'frameleaf_job_runs_status_finished',
    tone: bad ? 'warn' : 'good',
    found,
    bucket: bad ? 'failed' : 'done',
  };
};
