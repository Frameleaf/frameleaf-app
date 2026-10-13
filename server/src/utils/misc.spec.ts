import { describe, expect, it, vi } from 'vitest';
import {
  batched,
  getKeyByValue,
  getKeysDeep,
  globToPostgresRegex,
  removeOpenApi30IncompatibleKeys,
  unsetDeep,
} from 'src/utils/misc.js';

describe('getKeyByValue', () => {
  it('returns the first own enumerable key with an exact value match', () => {
    const object = Object.assign(Object.create({ inherited: 42 }), { first: 42, second: 42 });
    Object.defineProperty(object, 'hidden', { value: 'hidden' });
    expect(getKeyByValue(object, 42)).toBe('first');
    expect(getKeyByValue(object, 'hidden')).toBeUndefined();
    expect(getKeyByValue({ number: 42 }, '42')).toBeUndefined();
    expect(getKeyByValue({ number: NaN }, NaN)).toBeUndefined();
  });

  it('supports objects without a prototype', () => {
    const object = Object.assign(Object.create(null), { job: 'run' });
    expect(getKeyByValue(object, 'run')).toBe('job');
    expect(getKeyByValue(object, 'missing')).toBeUndefined();
  });
});

describe('OpenAPI 3.0 literals', () => {
  it('preserves false and nullable string literals as single-value enums without treating a property named const as a keyword', () => {
    const schema = {
      type: 'object',
      properties: {
        executionAvailable: { type: 'boolean', const: false },
        suggestedAdministrativeLabel: { type: 'string', const: 'administrative-original', nullable: true },
        nullOnly: { type: 'string', const: null, nullable: true },
        const: { type: 'string' },
      },
    };
    removeOpenApi30IncompatibleKeys(schema);
    expect(schema.properties).toEqual({
      executionAvailable: { type: 'boolean', enum: [false] },
      suggestedAdministrativeLabel: { type: 'string', enum: ['administrative-original', null], nullable: true },
      nullOnly: { type: 'string', enum: [null], nullable: true },
      const: { type: 'string' },
    });
  });
});

describe('getKeysDeep', () => {
  it('should handle an empty object', () => {
    expect(getKeysDeep({})).toEqual([]);
  });

  it('should list properties', () => {
    expect(
      getKeysDeep({
        foo: 'bar',
        flag: true,
        count: 42,
        date: new Date(),
      }),
    ).toEqual(['foo', 'flag', 'count', 'date']);
  });

  it('should skip undefined properties', () => {
    expect(getKeysDeep({ foo: 'bar', hello: undefined })).toEqual(['foo']);
  });

  it('should skip array indices', () => {
    expect(getKeysDeep({ foo: 'bar', hello: ['foo', 'bar'] })).toEqual(['foo', 'hello']);
    expect(getKeysDeep({ foo: 'bar', nested: { hello: ['foo', 'bar'] } })).toEqual(['foo', 'nested.hello']);
  });

  it('should list nested properties', () => {
    expect(getKeysDeep({ foo: 'bar', hello: { world: true } })).toEqual(['foo', 'hello.world']);
  });

  it("preserves depth-first ordering, shared objects and the caller's path", () => {
    const shared = { value: null };
    const path = ['config', ''];
    expect(getKeysDeep({ first: shared, ignored: {}, second: shared, last: false }, path)).toEqual([
      'config..first.value',
      'config..second.value',
      'config..last',
    ]);
    expect(path).toEqual(['config', '']);
  });

  it('does not invoke function properties or include undefined values', () => {
    const callback = vi.fn();
    expect(getKeysDeep({ callback, missing: undefined, present: null })).toEqual(['present']);
    expect(callback).not.toHaveBeenCalled();
  });

  it('walks deeply nested objects without using the call stack', () => {
    let target: object = { value: true };
    for (let index = 0; index < 5000; index++) {
      target = { nested: target };
    }
    expect(getKeysDeep(target)).toEqual([`${'nested.'.repeat(5000)}value`]);
  });

  it('handles a nested object wider than the function argument limit', () => {
    const nested = Object.fromEntries(Array.from({ length: 150_000 }, (_, index) => [`key${index}`, index]));
    const keys = getKeysDeep({ nested });
    expect(keys).toHaveLength(150_000);
    expect(keys[0]).toBe('nested.key0');
    expect(keys.at(-1)).toBe('nested.key149999');
  });

  it('rejects circular objects', () => {
    const target: Record<string, unknown> = {};
    target.self = target;
    expect(() => getKeysDeep(target)).toThrow(RangeError);
  });
});

describe('batched', () => {
  const source = async function* (items: number[]) {
    for (const item of items) {
      yield await new Promise<number>((resolve) => queueMicrotask(() => resolve(item)));
    }
  };

  it.each([
    [[], 2, []],
    [[1], 2, [[1]]],
    [
      [1, 2, 3, 4],
      2,
      [
        [1, 2],
        [3, 4],
      ],
    ],
    [[1, 2, 3], 2, [[1, 2], [3]]],
    [[1, 2, 3], 1, [[1], [2], [3]]],
  ])('groups %j by %i without modifying earlier batches', async (items, size, expected) => {
    const result: number[][] = await Array.fromAsync(batched(source(items), size));
    expect(result).toEqual(expected);
    expect(new Set(result).size).toBe(result.length);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid batch size %s before reading the source',
    async (size) => {
      const iterable = { [Symbol.asyncIterator]: vi.fn(() => source([1, 2])) };
      await expect(batched(iterable, size).next()).rejects.toThrow(RangeError);
      expect(iterable[Symbol.asyncIterator]).not.toHaveBeenCalled();
    },
  );

  it('closes the source when the consumer stops early', async () => {
    const iterator = source([1, 2, 3]);
    const close = vi.spyOn(iterator, 'return');
    for await (const batch of batched(iterator, 1)) {
      expect(batch).toEqual([1]);
      break;
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('propagates source errors', async () => {
    const error = new Error('stream failed');
    const iterable = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
    };
    await expect(batched(iterable, 1).next()).rejects.toBe(error);
  });
});

describe('unsetDeep', () => {
  it('should remove a property', () => {
    expect(unsetDeep({ hello: 'world', foo: 'bar' }, 'foo')).toEqual({ hello: 'world' });
  });

  it('should remove the last property', () => {
    expect(unsetDeep({ foo: 'bar' }, 'foo')).toBeUndefined();
  });

  it('should remove a nested property', () => {
    expect(unsetDeep({ foo: 'bar', nested: { enabled: true, count: 42 } }, 'nested.enabled')).toEqual({
      foo: 'bar',
      nested: { count: 42 },
    });
  });

  it('should clean up an empty property', () => {
    expect(unsetDeep({ foo: 'bar', nested: { enabled: true } }, 'nested.enabled')).toEqual({ foo: 'bar' });
  });
});

const matches = (glob: string, value: string) => new RegExp(globToPostgresRegex(glob)).test(value);

describe('globToPostgresRegex', () => {
  const testCases: [string, string, boolean][] = [
    ['**/Raw/**', '/foo/Raw/bar.jpg', true],
    ['**/Raw/**', '/foo/bar.jpg', false],
    ['**/abc/*.tif', '/foo/abc/scan.tif', true],
    ['**/abc/*.tif', '/foo/abc/sub/scan.tif', false],
    ['**/*.tif', '/foo/bar.tif', true],
    ['**/*.jp?', '/foo/bar.jpg', true],
    ['**/@eaDir/**', '/foo/@eaDir/thumb.jpg', true],
    ['**/._*', '/foo/._resource', true],
    ['/absolute/path/**', '/absolute/path/photo.jpg', true],
    ['/absolute/path/**', '/other/path/photo.jpg', false],
    // a bare `*` must not cross a path separator, unlike SQL `LIKE`'s `%`
    ['/path/*.*', '/path/photo.jpg', true],
    ['/path/*.*', '/path/2020/photo.jpg', false],
  ];

  it.each(testCases)('should match %s against %s as %s', (glob, value, expected) => {
    expect(matches(glob, value)).toEqual(expected);
  });
});

describe('removeOpenApi30IncompatibleKeys', () => {
  it('describes a tuple as an array of its item schema, which OpenAPI 3.0 generators accept', () => {
    const point = { type: 'number', minimum: 0, maximum: 1 };
    const schema = { type: 'array', items: { type: 'array', prefixItems: [point, point] }, propertyNames: {} };
    removeOpenApi30IncompatibleKeys(schema);
    expect(schema).toEqual({ type: 'array', items: { type: 'array', items: point } });
  });
});
