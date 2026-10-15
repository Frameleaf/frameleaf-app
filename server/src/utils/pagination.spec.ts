import { paginationHelper } from 'src/utils/pagination.js';

it.each([
  [0, 0, false],
  [0, 2, false],
  [2, 0, true],
  [2, 1, true],
  [2, 2, false],
  [2, 3, false],
])('paginates %i rows with a limit of %i', (count, take, hasNextPage) => {
  const items = Array.from({ length: count }, (_, id) => ({ id }));
  const original = [...items];
  const result = paginationHelper(items, take);
  expect(result.items).toBe(items);
  expect(result.items).toEqual(original.slice(0, take));
  expect(result.hasNextPage).toBe(hasNextPage);
});

it.each([-Infinity, -5, -2, -0.5, 0.5, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE])(
  'preserves numeric coercion for %s',
  (take) => {
    const items = [{ id: 0 }, { id: 1 }, { id: 2 }];
    const expected = [...items];
    const hasNextPage = items.length > take;
    expected.splice(take);
    expect(paginationHelper(items, take)).toEqual({ items: expected, hasNextPage });
  },
);

it('keeps row objects and sparse positions intact', () => {
  const row = { id: 'kept' };
  const items = [row];
  items.length = 2;
  items.push({ id: 'discarded' });
  const result = paginationHelper(items, 2);
  expect(result.items).toBe(items);
  expect(result.items[0]).toBe(row);
  expect(result.items).toHaveLength(2);
  expect(1 in result.items).toBe(false);
  expect(result.hasNextPage).toBe(true);
});
