import type { WorkflowScheduleDto } from '@frameleaf/sdk';
import { discoverySearchRequest, type DiscoveryQuery } from '$lib/components/discovery/query';
import { cloneJson, emptyDraft, type WorkflowDraft } from './workflows';

/** Compile once, so saved-search edits and date shortcuts cannot change an existing rule. */
export function workflowFromSearch(query: DiscoveryQuery, name = ''): WorkflowDraft {
  if (query.mode === 'speech') {
    throw new Error('Spoken words cannot be copied into a workflow');
  }
  const request = discoverySearchRequest(query);
  return {
    ...emptyDraft('AssetChanged'),
    name: name || null,
    source: {
      filter: cloneJson(request.filter ?? {}),
      ...(request.imageEnrichment && { imageEnrichment: request.imageEnrichment }),
      ...(request.queryAssetId
        ? { semantic: { queryAssetId: request.queryAssetId, maxDistance: 0.4 } }
        : request.query
          ? { semantic: { query: request.query, maxDistance: 0.4 } }
          : {}),
    },
  };
}

/**
 * "When it runs" (FL-1815): the server stores a cron line, the screen never shows one. `custom` is a
 * line saved earlier that these choices cannot say; it is kept as it is until it is replaced.
 */
export type ScheduleControls = {
  frequency: 'hourly' | 'daily' | 'weekly' | 'days' | 'custom';
  time: string;
  weekday: string;
  /** Days of the week, 0 is Sunday; for `days`, and the one day of `weekly`. */
  days: number[];
  cron: string;
};

const NUMBER = /^\d+$/;
const within = (value: string | undefined, max: number) => NUMBER.test(value ?? '') && Number(value) <= max;

export function scheduleControls(schedule: WorkflowScheduleDto): ScheduleControls {
  const cron = typeof schedule.cron === 'string' ? schedule.cron : '';
  const [minute, hour, day, month, weekday, extra] = cron.trim().split(/\s+/, 6);
  const simple = extra === undefined && within(minute, 59) && day === '*' && month === '*';
  const timed = simple && within(hour, 23);
  const days = /^[0-6](,[0-6])*$/.test(weekday ?? '')
    ? [...new Set(weekday.split(',').map(Number))].sort((a, b) => a - b)
    : [];
  return {
    frequency:
      simple && hour === '*' && weekday === '*'
        ? 'hourly'
        : timed && weekday === '*'
          ? 'daily'
          : timed && days.length === 1
            ? 'weekly'
            : timed && days.length > 1
              ? 'days'
              : 'custom',
    time: `${within(hour, 23) ? hour.padStart(2, '0') : '09'}:${within(minute, 59) ? minute.padStart(2, '0') : '00'}`,
    weekday: String(days[0] ?? 1),
    days: days.length > 0 ? days : [1, 3, 5],
    cron,
  };
}

export function workflowSchedule(controls: ScheduleControls): WorkflowScheduleDto {
  if (controls.frequency === 'custom') {
    return { cron: controls.cron };
  }
  const [hour, minute] = controls.time.split(':').map(Number);
  const days = [...new Set(controls.days)].sort((a, b) => a - b).join(',');
  return {
    cron: `${minute || 0} ${controls.frequency === 'hourly' ? '*' : hour || 0} * * ${
      controls.frequency === 'weekly' ? controls.weekday : controls.frequency === 'days' && days ? days : '*'
    }`,
  };
}
