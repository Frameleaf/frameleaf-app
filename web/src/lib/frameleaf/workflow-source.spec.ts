import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { workflowFromSearch, workflowSchedule, scheduleControls } from './workflow-source';

describe('workflow search copy', () => {
  it('freezes compiled dates and keeps text, metadata and enrichment conditions', () => {
    const query = { ...emptyDiscoveryQuery(), text: 'holiday', filter: { takenAt: { gte: '2026-01-01T00:00:00Z' } } };
    const draft = workflowFromSearch(query, 'Holidays');
    expect(draft).toMatchObject({
      name: 'Holidays',
      trigger: 'AssetChanged',
      enabled: false,
      source: {
        filter: { originalFileName: { like: 'holiday' }, takenAt: { gte: '2026-01-01T00:00:00Z' } },
      },
    });
    expect(draft.source?.rollingDates).toBeUndefined();
    query.filter.takenAt.gte = '2025-01-01T00:00:00Z';
    expect(draft.source?.filter.takenAt?.gte).toBe('2026-01-01T00:00:00Z');
  });
  it('uses an explicit threshold for semantic matching', () => {
    expect(workflowFromSearch({ ...emptyDiscoveryQuery(), mode: 'smart', text: 'dogs' }).source?.semantic).toEqual({
      query: 'dogs',
      maxDistance: 0.4,
    });
  });
});

describe('workflow schedule controls', () => {
  it('round trips presets and preserves advanced schedules', () => {
    for (const frequency of ['hourly', 'daily', 'weekly'] as const) {
      const schedule = workflowSchedule({ frequency, time: '14:35', weekday: '2', cron: '' });
      expect(scheduleControls(schedule).frequency).toBe(frequency);
      expect(workflowSchedule(scheduleControls(schedule))).toEqual(schedule);
    }
    expect(scheduleControls({ cron: '15 1,8 * * 1-5' })).toMatchObject({
      frequency: 'advanced',
      cron: '15 1,8 * * 1-5',
    });
    expect(scheduleControls({ cron: '0 9 * * * extra' })).toMatchObject({
      frequency: 'advanced',
      cron: '0 9 * * * extra',
    });
  });
});
