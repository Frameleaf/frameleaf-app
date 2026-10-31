import { TagRepository } from 'src/repositories/tag.repository.js';
import { upsertTags } from 'src/utils/tag.js';
import { tagStub } from 'test/fixtures/tag.stub.js';

describe('upsertTags', () => {
  const upsertValue = vi.fn<TagRepository['upsertValue']>();
  const repository = { upsertValue };

  beforeEach(() => {
    vi.resetAllMocks();
    upsertValue.mockImplementation(({ userId, value, parentId }) =>
      Promise.resolve({
        ...tagStub.parentUpsert,
        id: `${userId}:${value}`,
        userId,
        value,
        parentId: parentId ?? null,
      }),
    );
  });

  it('writes shared parent paths once while preserving leaf order and parent IDs', async () => {
    const values = ['places/coast', 'places/mountains', 'places/coast/summer'];
    const results = await upsertTags(repository, { userId: 'owner', tags: values });
    expect(results.map(({ value }) => value)).toEqual(values);
    expect(upsertValue.mock.calls.map(([request]) => request)).toEqual([
      { userId: 'owner', value: 'places', parentId: undefined },
      { userId: 'owner', value: 'places/coast', parentId: 'owner:places' },
      { userId: 'owner', value: 'places/mountains', parentId: 'owner:places' },
      { userId: 'owner', value: 'places/coast/summer', parentId: 'owner:places/coast' },
    ]);
  });

  it('retains results for normalized aliases and drops only exact duplicate inputs', async () => {
    const results = await upsertTags(repository, {
      userId: 'owner',
      tags: ['//places//coast/', 'places/coast', 'places/coast', '', '///'],
    });
    expect(results.map(({ value }) => value)).toEqual(['places/coast', 'places/coast']);
    expect(upsertValue).toHaveBeenCalledTimes(2);
  });

  it('never reuses parent results across calls or users', async () => {
    for (const userId of ['first', 'second', 'first']) {
      const [result] = await upsertTags(repository, { userId, tags: ['places/coast'] });
      expect(result.id).toBe(`${userId}:places/coast`);
      expect(result.parentId).toBe(`${userId}:places`);
    }
    expect(upsertValue).toHaveBeenCalledTimes(6);
  });

  it('propagates a failed write before admitting later paths', async () => {
    const error = new Error('write failed');
    upsertValue.mockRejectedValueOnce(error);
    await expect(upsertTags(repository, { userId: 'owner', tags: ['places/coast', 'other'] })).rejects.toBe(error);
    expect(upsertValue).toHaveBeenCalledTimes(1);
  });
});
