import { expect, it } from 'vitest';
import { filterIsInOrNearViewport } from './utils.svelte';

it('keeps visible items in their existing order and retains their references', () => {
  const hidden = { id: 'hidden', isInOrNearViewport: false };
  const first = { id: 'first', isInOrNearViewport: true };
  const second = { id: 'second', isInOrNearViewport: true };
  const input = [hidden, first, second];
  const output = filterIsInOrNearViewport(input);
  expect(output).toEqual([first, second]);
  expect(output[0]).toBe(first);
  expect(output[1]).toBe(second);
  expect(input).toEqual([hidden, first, second]);
  expect(output).not.toBe(input);
});

it('reads the current viewport flag once per item on each pass', () => {
  let visible = false;
  const receivers: unknown[] = [];
  class Item {
    get isInOrNearViewport() {
      receivers.push(this);
      return visible;
    }
  }
  const item = new Item();
  expect(filterIsInOrNearViewport([item])).toEqual([]);
  visible = true;
  expect(filterIsInOrNearViewport([item])).toEqual([item]);
  expect(receivers).toEqual([item, item]);
});

it('retains native sparse-array filtering and getter failures', () => {
  const item = { isInOrNearViewport: true };
  const input: Array<typeof item> = [];
  input.length = 3;
  input[2] = item;
  expect(filterIsInOrNearViewport(input)).toEqual([item]);
  expect(filterIsInOrNearViewport([])).toEqual([]);
  const failure = new Error('viewport read failed');
  expect(() =>
    filterIsInOrNearViewport([
      {
        get isInOrNearViewport(): boolean {
          throw failure;
        },
      },
    ]),
  ).toThrow(failure);
});
