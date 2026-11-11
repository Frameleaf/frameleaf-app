import { describe, expect, it } from 'vitest';
import en from '$i18n/en.json';
import { fileCheckView } from '$lib/frameleaf/file-check';

const check = (overrides: Partial<Parameters<typeof fileCheckView>[0]> = {}) => ({
  running: false,
  startedAt: '2026-11-11T02:10:15.000Z',
  finishedAt: '2026-11-11T02:30:21.000Z',
  checked: 14_288,
  total: 14_288,
  damaged: 0,
  missing: 0,
  failed: false,
  ...overrides,
});

describe("Library care's file check card (FL-1430)", () => {
  it('says what a finished check found, with the matching tone and filter', () => {
    expect(fileCheckView(check({ damaged: 660 }))).toEqual({
      status: 'frameleaf_job_runs_status_finished',
      tone: 'warn',
      found: { key: 'frameleaf_job_runs_file_check_found_damaged', values: { count: 660 } },
      bucket: 'failed',
    });
    expect(fileCheckView(check({ missing: 3 })).found).toEqual({
      key: 'frameleaf_job_runs_file_check_found_missing',
      values: { count: 3 },
    });
    expect(fileCheckView(check({ damaged: 2, missing: 3 })).found).toEqual({
      key: 'frameleaf_job_runs_file_check_found_both',
      values: { damaged: 2, missing: 3 },
    });
    expect(fileCheckView(check())).toEqual({
      status: 'frameleaf_job_runs_status_finished',
      tone: 'good',
      found: { key: 'frameleaf_job_runs_file_check_found_none', values: {} },
      bucket: 'done',
    });
  });
  it("a check that failed or was cancelled says it didn't finish, under Failed", () => {
    expect(fileCheckView(check({ failed: true }))).toEqual({
      status: 'frameleaf_job_runs_status_unfinished',
      tone: 'warn',
      found: { key: 'frameleaf_job_runs_file_check_unfinished', values: {} },
      bucket: 'failed',
    });
    expect(Object.keys(en)).toEqual(
      expect.arrayContaining(['frameleaf_job_runs_status_unfinished', 'frameleaf_job_runs_file_check_unfinished']),
    );
  });
  it('a running check is running, and says nothing found yet', () => {
    expect(fileCheckView(check({ running: true, finishedAt: null }))).toEqual({
      status: 'frameleaf_job_runs_state_running',
      tone: 'good',
      found: null,
      bucket: 'running',
    });
  });
  it('every key it uses exists', () => {
    for (const key of [
      'frameleaf_job_runs_file_check_found_damaged',
      'frameleaf_job_runs_file_check_found_missing',
      'frameleaf_job_runs_file_check_found_both',
      'frameleaf_job_runs_file_check_found_none',
    ]) {
      expect(Object.keys(en)).toContain(key);
    }
  });
});
