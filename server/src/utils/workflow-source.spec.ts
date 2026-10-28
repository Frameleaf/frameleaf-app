import { WorkflowCreateDto } from 'src/dtos/workflow.dto.js';
import { toDefinition, workflowIssues } from 'src/utils/workflow-definition.js';

describe('workflow source definitions', () => {
  it('keeps copied structured conditions, thresholds and rolling dates', () => {
    const source = {
      filter: { rating: { gte: 4 } },
      semantic: { query: 'mountains', maxDistance: 0.2 },
      rollingDates: [{ field: 'takenAt', days: 30 }],
    };
    const dto = WorkflowCreateDto.schema.parse({ trigger: 'AssetChanged', source, schedule: { cron: '0 9 * * *' } });
    expect(dto).toMatchObject({ source, schedule: { cron: '0 9 * * *' } });
    expect(toDefinition({ ...dto, steps: [] })).toMatchObject({ source, schedule: { cron: '0 9 * * *' } });
  });
  it('does not silently enable unsupported imported schedules', () => {
    expect(workflowIssues(toDefinition({ trigger: 'Schedule', steps: [] }), [])).not.toEqual([]);
  });
  it('accepts configured schedules without plugin actions', () => {
    const dto = WorkflowCreateDto.schema.parse({
      trigger: 'Schedule',
      source: { filter: {} },
      schedule: { cron: '0 9 * * *' },
    });
    expect(workflowIssues(toDefinition({ ...dto, steps: [] }), [])).toEqual([]);
  });
  it('rejects a semantic search with no explicit threshold', () => {
    expect(
      WorkflowCreateDto.schema.safeParse({
        trigger: 'AssetChanged',
        source: { filter: {}, semantic: { query: 'cat' } },
      }).success,
    ).toBe(false);
  });
  it('rejects seconds cron so a schedule cannot launch every second', () => {
    expect(
      WorkflowScheduleSchema.safeParse({cron:'* * * * * *'}).success,
    ).toBe(false);
  });
});

import { nextWorkflowOccurrence, resolveWorkflowSource, WorkflowScheduleSchema } from 'src/utils/workflow-source.js';
describe('source time semantics', () => {
  it('rolls only explicitly relative fields at the frozen snapshot time', () => {
    const source = {
      filter: { createdAt: { gte: new Date('2020-01-01Z') } },
      rollingDates: [{ field: 'takenAt' as const, days: 7 }],
    };
    const frozen = resolveWorkflowSource(source, new Date('2026-10-27T12:00:00Z'));
    expect(frozen.filter.takenAt).toEqual({ gte: new Date('2026-10-20T12:00:00Z') });
    expect(frozen.filter.createdAt).toEqual(source.filter.createdAt);
    expect(source.filter).not.toHaveProperty('takenAt');
  });
  it('advances hourly schedules in the server timezone across spring DST', () => {
    expect(nextWorkflowOccurrence({ cron: '0 * * * *' }, new Date('2026-03-08T08:00:00Z'), 'America/Edmonton')).toEqual(
      new Date('2026-03-08T09:00:00Z'),
    );
  });
});

describe('semantic source references', () => {
  it('accepts one reference photo and refuses ambiguous text plus photo', () => {
    const reference = { queryAssetId: '11111111-1111-4111-8111-111111111111', maxDistance: 0.25 };
    expect(
      WorkflowCreateDto.schema.safeParse({ trigger: 'AssetChanged', source: { filter: {}, semantic: reference } })
        .success,
    ).toBe(true);
    expect(
      WorkflowCreateDto.schema.safeParse({
        trigger: 'AssetChanged',
        source: { filter: {}, semantic: { ...reference, query: 'cats' } },
      }).success,
    ).toBe(false);
  });
});

it('rejects a schedule whose date can never occur', () => {
  expect(
    WorkflowScheduleSchema.safeParse({cron:'0 0 31 2 *'}).success,
  ).toBe(false);
});

it('keeps an invalid imported schedule while paused and reports why enabling is blocked',()=>{
 const dto=WorkflowCreateDto.schema.parse({trigger:'Schedule',enabled:false,source:{filter:{}},schedule:{cron:'daily'}});
 expect(toDefinition({...dto,steps:[]})).toMatchObject({schedule:{cron:'daily'}});
 expect(workflowIssues(toDefinition({...dto,steps:[]}),[])).not.toEqual([]);
});
