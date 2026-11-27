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
  it('round trips every choice of the picker', () => {
    for (const frequency of ['hourly', 'daily', 'weekly', 'days'] as const) {
      const schedule = workflowSchedule({ frequency, time: '14:35', weekday: '2', days: [5, 1, 3], cron: '' });
      expect(scheduleControls(schedule).frequency).toBe(frequency);
      expect(workflowSchedule(scheduleControls(schedule))).toEqual(schedule);
    }
    expect(workflowSchedule({ frequency: 'days', time: '09:00', weekday: '1', days: [5, 1, 3], cron: '' })).toEqual({
      cron: '0 9 * * 1,3,5',
    });
    expect(scheduleControls({ cron: '30 7 * * 0,6' })).toMatchObject({
      frequency: 'days',
      days: [0, 6],
      time: '07:30',
    });
    // one chosen day is the same schedule as "every week"
    expect(scheduleControls({ cron: '0 9 * * 3' })).toMatchObject({ frequency: 'weekly', weekday: '3', days: [3] });
  });

  it('keeps a schedule the picker cannot say exactly as it was saved (FL-1815)', () => {
    for (const cron of ['15 1,8 * * 1-5', '0 9 * * * extra', '0 9 1 * *', '*/5 * * * *', '0 9 * * 7', '0 25 * * *']) {
      const controls = scheduleControls({ cron });
      expect(controls.frequency).toBe('custom');
      expect(workflowSchedule(controls)).toEqual({ cron });
    }
  });
});
