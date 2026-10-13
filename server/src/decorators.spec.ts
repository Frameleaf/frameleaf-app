import { ChunkedSet } from 'src/decorators.js';

describe('ChunkedSet', () => {
  it.each([[], ['a'], ['a', 'b'], ['a', 'b', 'c', 'd', 'e']].map((values) => ({ values })))(
    'preserves order, identities and arguments for $values',
    async ({ values }) => {
      const marker = {};
      const returned: Set<unknown>[] = [];
      class Repository {
        @ChunkedSet({ paramIndex: 1, chunkSize: 2 })
        async find(owner: string, ids: Set<string>, suffix: string) {
          await Promise.resolve();
          expect(this).toBe(repository);
          expect(owner).toBe('owner');
          expect(suffix).toBe('suffix');
          const result = new Set<unknown>([...ids, marker]);
          returned.push(result);
          return result;
        }
      }
      const repository = new Repository();
      const input = new Set(values);
      const result = await repository.find('owner', input, 'suffix');
      const expected = values.length <= 2 ? [...values, marker] : [values[0], values[1], marker, ...values.slice(2)];
      expect([...result]).toEqual(expected);
      expect([...input]).toEqual(values);
      if (values.length <= 2) {
        expect(result).toBe(returned[0]);
      } else {
        expect(returned).toHaveLength(Math.ceil(values.length / 2));
        expect(returned).not.toContain(result);
        expect([...returned[0]]).toEqual([values[0], values[1], marker]);
      }
    },
  );

  it('returns an empty set when every chunk has an empty result', async () => {
    class Repository {
      @ChunkedSet({ chunkSize: 1 })
      async find(_ids: Set<string>) {
        await Promise.resolve();
        return new Set<string>();
      }
    }
    await expect(new Repository().find(new Set(['a', 'b', 'c']))).resolves.toEqual(new Set());
  });

  it('preserves a chunk failure', async () => {
    class Repository {
      @ChunkedSet({ chunkSize: 1 })
      async find(ids: Set<string>) {
        await Promise.resolve();
        if (ids.has('b')) {
          throw new Error('repository failure');
        }
        return ids;
      }
    }
    await expect(new Repository().find(new Set(['a', 'b', 'c']))).rejects.toThrow('repository failure');
  });
});
