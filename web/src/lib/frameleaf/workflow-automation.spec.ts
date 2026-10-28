import { describe, expect, it } from 'vitest';
import {
  draftFromDocument,
  draftToCreateDto,
  draftToDocument,
  importWorkflowFile,
  workflowProblems,
} from './workflows';

describe('workflow automation definitions', () => {
  const source = { filter: { rating: { gte: 4 } }, rollingDates: [{ field: 'takenAt', days: 30 }] };
  const schedule = { cron: '0 9 * * 1' };
  const definition = { trigger: 'AssetChanged', source, schedule, enabled: true, steps: [], other: { keep: true } };

  it('copies source and schedule as first-class fields without losing imported extensions', () => {
    const draft = draftFromDocument(definition);
    expect(draft).toMatchObject({ source, schedule, extra: { other: { keep: true } } });
    expect(draft.extra).not.toHaveProperty('source');
    expect(draftToCreateDto(draft)).toMatchObject({ source, schedule });
    expect(draftToDocument(draft)).toMatchObject(definition);
    source.filter.rating.gte = 5;
    expect(draftToDocument(draft).source).toMatchObject({ filter: { rating: { gte: 4 } } });
    source.filter.rating.gte = 4;
  });

  it('imports a scheduled definition paused with its schedule and source intact', () => {
    const text = JSON.stringify({ ...definition, trigger: 'Schedule' });
    expect(importWorkflowFile(text, text.length)).toMatchObject({ enabled: false, source, schedule });
  });

  it('keeps older unrecognized schedule and source objects as portable extensions', () => {
    const legacy = {
      trigger: 'Schedule',
      source: { server: 'old-server' },
      schedule: { timezone: 'UTC', interval: 'daily' },
      steps: [],
    };
    const draft = draftFromDocument(legacy);
    expect(draft.source).toBeUndefined();
    expect(draft.schedule).toBeUndefined();
    expect(draft.extra).toEqual({ source: legacy.source, schedule: legacy.schedule });
    expect(draftToDocument(draft)).toMatchObject(legacy);
    expect(draftToCreateDto(draft)).not.toHaveProperty('schedule');
    draft.source = { filter: {} };
    draft.schedule = { cron: '0 9 * * *' };
    const configured = draftFromDocument(draftToDocument(draft));
    expect(configured.extra).toEqual({ source: legacy.source, schedule: legacy.schedule });
  });

  it('does not claim scheduling is unsupported when a genuinely unknown trigger is encountered', () => {
    const draft = draftFromDocument({ trigger: 'FutureTrigger', steps: [] });
    expect(workflowProblems(draft, [], [])).toEqual([{ message: 'This trigger is unavailable.' }]);
  });

  it('retains legacy extensions inside otherwise recognizable source and schedule objects', () => {
    const legacy = {
      trigger: 'Schedule',
      source: { filter: {}, legacyOrigin: 'old-server' },
      schedule: { cron: '0 9 * * *', timezone: 'UTC' },
      steps: [],
    };
    const draft = draftFromDocument(legacy);
    expect(draft.source).toBeUndefined();
    expect(draft.schedule).toBeUndefined();
    expect(draftToDocument(draft)).toMatchObject(legacy);
    expect(draftToCreateDto(draft).extra).toMatchObject({ source: legacy.source, schedule: legacy.schedule });
  });
});
