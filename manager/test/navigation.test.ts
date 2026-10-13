import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gotoWithNetworkChangeRetry } from './navigation.mjs';

const origin = 'https://127.0.0.1:19443';

test('initial navigation returns the response without another request', async () => {
  const response = { status: 200 };
  const urls: string[] = [];
  const page = {
    goto: async (url: string) => {
      urls.push(url);
      return response;
    },
  };

  assert.equal(await gotoWithNetworkChangeRetry(page, origin), response);
  assert.deepEqual(urls, [origin]);
});

test('initial network-change notification allows exactly one retry to the same origin', async () => {
  const response = { status: 200 };
  const urls: string[] = [];
  const page = {
    goto: async (url: string) => {
      urls.push(url);
      if (urls.length === 1)
        throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
      return response;
    },
  };

  assert.equal(await gotoWithNetworkChangeRetry(page, origin), response);
  assert.deepEqual(urls, [origin, origin]);
});

test('a second network-change failure propagates without a third attempt', async () => {
  const error = new Error('page.goto: net::ERR_NETWORK_CHANGED');
  let calls = 0;
  const page = {
    goto: async () => {
      calls++;
      throw error;
    },
  };

  await assert.rejects(
    () => gotoWithNetworkChangeRetry(page, origin),
    (caught) => caught === error,
  );
  assert.equal(calls, 2);
});

test('other navigation failures propagate unchanged after one attempt', async () => {
  for (const error of [
    new Error('net::ERR_CONNECTION_REFUSED'),
    new Error('net::ERR_NAME_NOT_RESOLVED'),
    new Error('Timeout exceeded'),
    'net::ERR_NETWORK_CHANGED',
    null,
  ]) {
    let calls = 0;
    const page = {
      goto: async () => {
        calls++;
        throw error;
      },
    };

    await assert.rejects(
      () => gotoWithNetworkChangeRetry(page, origin),
      (caught) => caught === error,
    );
    assert.equal(calls, 1);
  }
});
