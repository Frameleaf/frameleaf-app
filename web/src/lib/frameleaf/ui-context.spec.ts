import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { getChildContext, setChildContext } from '../../../../packages/ui/dist/common/context.svelte.js';
import { ChildKey } from '../../../../packages/ui/dist/constants.js';
import ChildContextHarness from '../../test-data/frameleaf/ChildContextHarness.svelte';

type ChildContextHarnessApi = ReturnType<typeof setChildContext> & ReturnType<ReturnType<typeof getChildContext>>;

afterEach(cleanup);

const mountContext = () => {
  let api!: ChildContextHarnessApi;
  const view = render(ChildContextHarness, {
    capture: (context: ChildContextHarnessApi) => {
      api = context;
    },
  });
  return { api, value: view.getByTestId('child-value') };
};

it('keeps the latest child after an older registration is cleaned up', () => {
  const { api, value } = mountContext();
  const removeOld = api.register(ChildKey.CardBody, () => ({ class: 'old child' }));
  const removeNew = api.register(ChildKey.CardBody, () => ({ class: 'new child' }));
  flushSync();
  expect(value).toHaveTextContent('new child');
  removeOld();
  flushSync();
  expect(value).toHaveTextContent('new child');
  removeNew();
  flushSync();
  expect(value).toHaveTextContent('missing');
});

it('distinguishes separate registrations of the same data callback', () => {
  const { api, value } = mountContext();
  const data = () => ({ class: 'shared callback' });
  const removeOld = api.register(ChildKey.CardBody, data);
  const removeNew = api.register(ChildKey.CardBody, data);
  removeOld();
  flushSync();
  expect(value).toHaveTextContent('shared callback');
  removeNew();
  flushSync();
  expect(value).toHaveTextContent('missing');
});

it('makes repeated cleanup harmless after a newer child replaces a removed one', () => {
  const { api, value } = mountContext();
  const removeOld = api.register(ChildKey.CardBody, () => ({ class: 'old child' }));
  removeOld();
  const removeNew = api.register(ChildKey.CardBody, () => ({ class: 'replacement' }));
  removeOld();
  flushSync();
  expect(value).toHaveTextContent('replacement');
  removeNew();
});

it('keeps other slots independent and preserves the data callback receiver and return identity', () => {
  const { api } = mountContext();
  const body = { class: 'body' };
  const removeBody = api.register(ChildKey.CardBody, function (this: undefined) {
    expect(this).toBeUndefined();
    return body;
  });
  const removeHeader = api.register(ChildKey.CardHeader, () => ({ class: 'header' }));
  expect(api.getByKey(ChildKey.CardBody)).toBe(body);
  removeHeader();
  expect(api.getByKey(ChildKey.CardHeader)).toBeUndefined();
  expect(api.getByKey(ChildKey.CardBody)).toBe(body);
  removeBody();
});
