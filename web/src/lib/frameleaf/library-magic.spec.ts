import { colourName, forecast, laps, nextMilestone } from '$lib/frameleaf/library-magic';

describe('colourName', () => {
  it.each([
    ['#d23b2f', 'red'],
    ['#e8913a', 'orange'],
    ['#6b4421', 'brown'],
    ['#e8d23a', 'yellow'],
    ['#4f8a3c', 'green'],
    ['#2f9c97', 'teal'],
    ['#3a6fd2', 'blue'],
    ['#7b4fc4', 'purple'],
    ['#d24f9c', 'pink'],
    ['#808080', 'grey'],
    ['#f8f8f6', 'white'],
    ['#101010', 'black'],
  ])('%s is %s', (hex, name) => expect(colourName(hex)).toBe(name));
});

describe('forecast', () => {
  const bucket = (from: string, through: string, photos: number) => ({ from, through, photos, videos: 0 }) as never;
  const summary = { items: 9500, physicalBytes: 9500 * 5_000_000 } as never;

  it('goes on at the pace of the selected dates to the next round number and a full drive', () => {
    const now = new Date('2026-11-04T00:00:00Z');
    const result = forecast(
      [bucket('2026-09-01', '2026-09-30', 300), bucket('2026-10-01', '2026-10-30', 300)],
      summary,
      { freeBytes: 600 * 5_000_000 } as never,
      now,
    )!;
    expect(result.perMonth).toBe(304);
    expect(result.milestone).toBe(10_000);
    // 500 more at 10 a day
    expect(result.milestoneOn.toISOString().slice(0, 10)).toBe('2026-12-24');
    // 600 photos of room at 10 a day
    expect(result.fullOn?.toISOString().slice(0, 10)).toBe('2027-01-03');
  });

  it('has nothing to say when nothing was added', () => {
    expect(forecast([bucket('2026-10-01', '2026-10-31', 0)], summary, { freeBytes: null } as never)).toBeNull();
    expect(forecast([], summary, { freeBytes: null } as never)).toBeNull();
  });
});

it('rounds milestones and laps of the Earth', () => {
  expect(nextMilestone(0)).toBe(1000);
  expect(nextMilestone(48_090)).toBe(50_000);
  expect(nextMilestone(120_000)).toBe(200_000);
  expect(laps(80_150)).toBe(2);
});
