import assert from 'node:assert/strict';
import test from 'node:test';
import { navigate } from './navigation.mjs';

test('initial Chromium network-change retries once and still requires successful navigation', async () => {
  let calls = 0;
  const page = {
    goto: async (url: string) => {
      assert.equal(url, 'https://fixture.test');
      if (++calls === 1) throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
    },
  };
  await navigate(page, 'https://fixture.test');
  assert.equal(calls, 2);
});

test('navigation never retries other failures or hides a repeated network-change error', async () => {
  for (const message of ['net::ERR_CERT_INVALID', 'net::ERR_NETWORK_CHANGED']) {
    let calls = 0;
    await assert.rejects(
      navigate(
        {
          goto: async () => {
            calls++;
            throw new Error(message);
          },
        },
        'https://fixture.test',
      ),
      (error: Error) => error.message === message,
    );
    assert.equal(calls, message === 'net::ERR_NETWORK_CHANGED' ? 2 : 1);
  }
});
