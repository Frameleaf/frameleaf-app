import {
  ASSISTANT_ACTION_TOOLS,
  ASSISTANT_ACTION_TOOL_SCHEMAS,
  CullFrame,
  assistantActionToolArguments,
  assistantUndoExpiry,
  groupBursts,
  planCull,
} from 'src/utils/assistant-action.js';

const at = (seconds: number) => Date.parse('2024-07-02T10:00:00.000Z') + seconds * 1000;

const frame = (id: string, overrides: Partial<CullFrame> = {}): CullFrame => ({
  id,
  takenAt: at(0),
  burstId: null,
  score: 0.5,
  isFavorite: false,
  rating: null,
  ...overrides,
});

describe('assistant action tools', () => {
  it('offers the five write tools and no delete or trash verb', () => {
    expect([...ASSISTANT_ACTION_TOOLS]).toEqual(['create_album', 'add_to_album', 'tag', 'favourite', 'cull']);
    expect(Object.keys(ASSISTANT_ACTION_TOOL_SCHEMAS)).toEqual([...ASSISTANT_ACTION_TOOLS]);
  });

  it('describes each tool as a closed JSON schema a planner can be given', () => {
    for (const tool of ASSISTANT_ACTION_TOOLS) {
      expect(ASSISTANT_ACTION_TOOL_SCHEMAS[tool]).toMatchObject({ type: 'object', additionalProperties: false });
    }
    expect(ASSISTANT_ACTION_TOOL_SCHEMAS.create_album).toMatchObject({ required: ['name'] });
    expect(ASSISTANT_ACTION_TOOL_SCHEMAS.add_to_album).toMatchObject({ required: ['album'] });
    expect(ASSISTANT_ACTION_TOOL_SCHEMAS.tag).toMatchObject({ required: ['tags'] });
  });

  it('refuses arguments a tool does not have', () => {
    expect(assistantActionToolArguments.favourite.safeParse({ album: 'Trips' }).success).toBe(false);
    expect(assistantActionToolArguments.create_album.safeParse({ name: '  ' }).success).toBe(false);
    expect(assistantActionToolArguments.tag.safeParse({ tags: [] }).success).toBe(false);
    expect(assistantActionToolArguments.create_album.safeParse({ name: ' Lisbon ' }).data).toEqual({ name: 'Lisbon' });
  });

  it('lets a change be undone for 30 days', () => {
    const applied = new Date('2026-11-01T08:00:00.000Z');
    expect(assistantUndoExpiry(applied).toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });
});

describe(groupBursts.name, () => {
  it('groups frames that share a camera burst id, however far apart', () => {
    const groups = groupBursts([
      frame('a', { burstId: 'burst-1', takenAt: at(0) }),
      frame('b', { burstId: 'burst-1', takenAt: at(30) }),
      frame('c', { takenAt: at(31) }),
    ]);
    expect(groups.map((group) => group.map(({ id }) => id))).toEqual([['a', 'b'], ['c']]);
  });

  it('reads photos taken within two seconds of the last one as one burst', () => {
    const groups = groupBursts([
      frame('late', { takenAt: at(60) }),
      frame('c', { takenAt: at(3) }),
      frame('a', { takenAt: at(0) }),
      frame('b', { takenAt: at(1.5) }),
    ]);
    expect(groups.map((group) => group.map(({ id }) => id))).toEqual([['a', 'b', 'c'], ['late']]);
  });
});

describe(planCull.name, () => {
  it('keeps the best-scored frame of each burst and rejects the others', () => {
    const plan = planCull([
      frame('a', { burstId: 'one', score: 0.2 }),
      frame('b', { burstId: 'one', score: 0.9 }),
      frame('c', { burstId: 'one', score: 0.4 }),
      frame('d', { burstId: 'two', score: 0.7, takenAt: at(100) }),
      frame('e', { burstId: 'two', score: 0.1, takenAt: at(101) }),
    ]);
    expect(plan.bursts).toBe(2);
    expect(plan.keepIds).toEqual(['b', 'd']);
    expect(plan.rejectIds.toSorted()).toEqual(['a', 'c', 'e']);
  });

  it('keeps the earliest frame when two score the same', () => {
    const plan = planCull([
      frame('second', { burstId: 'one', score: 0.5, takenAt: at(1) }),
      frame('first', { burstId: 'one', score: 0.5, takenAt: at(0) }),
    ]);
    expect(plan.keepIds).toEqual(['first']);
    expect(plan.rejectIds).toEqual(['second']);
  });

  it('never rejects a favourite or a starred frame', () => {
    const plan = planCull([
      frame('best', { burstId: 'one', score: 0.9 }),
      frame('loved', { burstId: 'one', score: 0.1, isFavorite: true }),
      frame('starred', { burstId: 'one', score: 0.1, rating: 4 }),
      frame('plain', { burstId: 'one', score: 0.1 }),
    ]);
    expect(plan.rejectIds).toEqual(['plain']);
    expect(plan.keepIds.toSorted()).toEqual(['best', 'loved', 'starred']);
  });

  it('leaves a photo that is in no burst alone', () => {
    const plan = planCull([frame('alone'), frame('other', { takenAt: at(600) })]);
    expect(plan).toMatchObject({ bursts: 0, rejectIds: [], keepIds: [] });
    expect(plan.singleIds.toSorted()).toEqual(['alone', 'other']);
  });

  it('leaves a burst with an unscored frame alone rather than guessing', () => {
    const plan = planCull([
      frame('unscored', { burstId: 'one', score: null }),
      frame('scored', { burstId: 'one', score: 0.3, takenAt: at(1) }),
    ]);
    expect(plan.rejectIds).toEqual([]);
    expect(plan.keepIds).toEqual([]);
    expect(plan.unscoredIds).toEqual(['unscored', 'scored']);
  });
});
