import type { WorkflowScheduleDto } from '@frameleaf/sdk';
import { discoverySearchRequest, type DiscoveryQuery } from '$lib/components/discovery/query';
import { cloneJson, emptyDraft, type WorkflowDraft } from './workflows';

/** Compile once, so saved-search edits and date shortcuts cannot change an existing rule. */
export function workflowFromSearch(query: DiscoveryQuery, name = ''): WorkflowDraft {
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

export type ScheduleControls = {
  frequency: 'hourly' | 'daily' | 'weekly' | 'advanced';
  time: string;
  weekday: string;
  cron: string;
};

export function scheduleControls(schedule: WorkflowScheduleDto): ScheduleControls {
  const cron = typeof schedule.cron === 'string' ? schedule.cron : '';
  const [minute, hour, day, month, weekday, extra] = cron.trim().split(/\s+/, 6);
  const simple = extra === undefined && /^\d+$/.test(minute ?? '') && day === '*' && month === '*';
  return {
    frequency:
      simple && hour === '*' && weekday === '*'
        ? 'hourly'
        : simple && /^\d+$/.test(hour ?? '') && weekday === '*'
          ? 'daily'
          : simple && /^\d+$/.test(hour ?? '') && /^[0-6]$/.test(weekday ?? '')
            ? 'weekly'
            : 'advanced',
    time: `${/^\d+$/.test(hour ?? '') ? hour.padStart(2, '0') : '09'}:${/^\d+$/.test(minute ?? '') ? minute.padStart(2, '0') : '00'}`,
    weekday: /^[0-6]$/.test(weekday ?? '') ? weekday : '1',
    cron,
  };
}

export function workflowSchedule(controls: ScheduleControls): WorkflowScheduleDto {
  if (controls.frequency === 'advanced') {
    return { cron: controls.cron };
  }
  const [hour, minute] = controls.time.split(':').map(Number);
  return {
    cron: `${minute} ${controls.frequency === 'hourly' ? '*' : hour} * * ${controls.frequency === 'weekly' ? controls.weekday : '*'}`,
  };
}
