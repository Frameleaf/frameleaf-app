import { tick } from 'svelte';
// @ts-expect-error Plain tsc cannot see component module exports compiled by Vite.
import { portal } from './Portal.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

const node = () => {
  const element = document.createElement('div');
  element.hidden = true;
  return element;
};

it('mounts and reveals the original element in the default body target', () => {
  const element = node();
  const action = portal(element);
  expect(element.parentNode).toBe(document.body);
  expect(element.hidden).toBe(false);
  action.destroy();
  expect(element.parentNode).toBeNull();
});

it('moves the original element between element and selector targets', async () => {
  const first = node();
  const second = node();
  second.id = 'second';
  document.body.append(first, second);
  const element = node();
  const action = portal(element, first);
  expect(first.firstChild).toBe(element);
  await action.update('#second');
  expect(first.childNodes).toHaveLength(0);
  expect(second.firstChild).toBe(element);
  action.destroy();
});

it('allows a selector target to arrive during the next Svelte tick', async () => {
  const element = node();
  const action = portal(element);
  const pending = action.update('#late');
  const target = node();
  target.id = 'late';
  document.body.append(target);
  await pending;
  expect(target.firstChild).toBe(element);
  action.destroy();
});

it('rejects a missing target without detaching the current content', async () => {
  const element = node();
  const action = portal(element);
  await expect(action.update('#absent')).rejects.toBeInstanceOf(Error);
  expect(element.parentNode).toBe(document.body);
  action.destroy();
});

it('rejects malformed selectors without detaching the current content', async () => {
  const element = node();
  const action = portal(element);
  await expect(action.update('[')).rejects.toBeInstanceOf(DOMException);
  expect(element.parentNode).toBe(document.body);
  action.destroy();
});

it.each([null, undefined, 1, {}])('rejects unsupported update target %j', async (target) => {
  const element = node();
  const action = portal(element);
  await expect(action.update(target as HTMLElement)).rejects.toBeInstanceOf(TypeError);
  expect(element.parentNode).toBe(document.body);
  action.destroy();
});

it('does not reattach content when a deferred target arrives after destroy', async () => {
  const element = node();
  const action = portal(element);
  const pending = action.update('#late');
  action.destroy();
  const target = node();
  target.id = 'late';
  document.body.append(target);
  await pending;
  expect(element.parentNode).toBeNull();
  expect(target.childNodes).toHaveLength(0);
});

it('does not reject an obsolete selector update after a newer element target wins', async () => {
  const element = node();
  const action = portal(element);
  const pending = action.update('#obsolete');
  const target = node();
  document.body.append(target);
  await action.update(target);
  await expect(pending).resolves.toBeUndefined();
  expect(element.parentNode).toBe(target);
  action.destroy();
});

it('ignores updates after destroy', async () => {
  const element = node();
  const action = portal(element);
  action.destroy();
  await action.update(document.body);
  await tick();
  expect(element.parentNode).toBeNull();
});

it('can destroy detached content more than once', () => {
  const element = node();
  const action = portal(element);
  element.remove();
  expect(() => {
    action.destroy();
    action.destroy();
  }).not.toThrow();
});
