import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { loadRuleSources } from '$lib/frameleaf/classification-sources';
import { personFactory } from '@test-data/factories/person-factory';

// FL-1803: a rule could only name someone among the first 500 people.
describe('loadRuleSources', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getAllTags.mockResolvedValue([]);
    sdkMock.getClassificationSettings.mockResolvedValue({} as never);
  });

  it('reads every named person, past the first page of the list', async () => {
    const everyone = Array.from({ length: 1500 }, (_, index) =>
      personFactory.build({ id: `p${index}`, name: index === 7 ? '' : `Person ${index}` }),
    );
    sdkMock.getAllPeople.mockImplementation(({ page = 1, size = 500 } = {}) =>
      Promise.resolve({
        people: everyone.slice((page - 1) * size, page * size) as never,
        total: everyone.length,
        hidden: 0,
        hasNextPage: page * size < everyone.length,
      }),
    );

    const { people } = await loadRuleSources();

    expect(people).toHaveLength(1499);
    expect(people.at(-1)?.name).toBe('Person 1499');
    expect(sdkMock.getAllPeople.mock.calls.map(([options]) => options)).toEqual([
      { withHidden: false, page: 1, size: 1000 },
      { withHidden: false, page: 2, size: 1000 },
    ]);
  });

  it('answers with nobody when people cannot be read, and still gives the tags', async () => {
    sdkMock.getAllPeople.mockRejectedValue(new Error('offline'));
    sdkMock.getAllTags.mockResolvedValue([{ id: 't', value: 'Travel' }] as never);

    await expect(loadRuleSources()).resolves.toMatchObject({ people: [], tags: [{ id: 't', value: 'Travel' }] });
  });
});
