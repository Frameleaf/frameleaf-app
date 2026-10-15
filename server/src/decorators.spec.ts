import { Chunked, ChunkedArray, ChunkedSet } from 'src/decorators.js';

describe('Chunked invocation ownership', () => {
  it('observes earlier thenable failures when a later chunk throws synchronously, without starting later work', async () => {
    const invoked: string[] = [];
    const failure = new Error('synchronous failure');
    const earlierFailure = new Error('earlier asynchronous failure');
    let observed = false;
    const early = {
      then(_resolve: unknown, reject: (error: Error) => void) {
        observed = true;
        reject(earlierFailure);
      },
    };
    class Repository {
      @Chunked({ chunkSize: 1 })
      find(ids: string[]) {
        invoked.push(ids[0]);
        if (ids[0] === 'b') {
          throw failure;
        }
        return early;
      }
    }
    expect(() => new Repository().find(['a', 'b', 'c'])).toThrow(failure);
    await Promise.resolve();
    expect(invoked).toEqual(['a', 'b']);
    expect(observed).toBe(true);
  });

  it('invokes all chunks before settlement and merges results in input order', async () => {
    const resolvers: Array<(value: string[]) => void> = [];
    const input = ['a', 'b', 'c', 'd', 'e'];
    const calls: string[][] = [];
    class Repository {
      @ChunkedArray({ paramIndex: 1, chunkSize: 2 })
      find(owner: object, ids: string[], suffix: object) {
        expect(this).toBe(repository);
        expect(owner).toBe(prefix);
        expect(suffix).toBe(tail);
        calls.push(ids);
        return new Promise<string[]>((resolve) => {
          resolvers.push(resolve);
        });
      }
    }
    const prefix = {};
    const tail = {};
    const repository = new Repository();
    const result = repository.find(prefix, input, tail);
    expect(calls).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    resolvers[2](['e']);
    resolvers[0](['a', 'b']);
    resolvers[1](['c', 'd']);
    await expect(result).resolves.toEqual(input);
    expect(input).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps the fast path synchronous and returns the original reference without invoking the merger', () => {
    const mergeFn = vi.fn();
    class Repository {
      @Chunked({ chunkSize: 2, mergeFn })
      find(ids: string[]) {
        return ids;
      }
    }
    const input = ['a', 'b'];
    expect(new Repository().find(input)).toBe(input);
    expect(mergeFn).not.toHaveBeenCalled();
  });
});

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
