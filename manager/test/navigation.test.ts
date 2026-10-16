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

test('the Chromium error page racing a network-change retry gets one final navigation', async () => {
  const errors = [
    new Error('page.goto: net::ERR_NETWORK_CHANGED'),
    new Error(
      'page.goto: Navigation to "https://fixture.test/" is interrupted by another navigation to "chrome-error://chromewebdata/"',
    ),
  ];
  let calls = 0;
  await navigate(
    {
      goto: async () => {
        const error = errors[calls++];
        if (error) throw error;
      },
    },
    'https://fixture.test',
  );
  assert.equal(calls, 3);
});

test('a repeated browser error race and unrelated second error still fail', async () => {
  const race = new Error(
    'page.goto: Navigation to "https://fixture.test/" is interrupted by another navigation to "chrome-error://chromewebdata/"',
  );
  const certificate = new Error('net::ERR_CERT_INVALID');
  for (const sequence of [
    [race],
    [new Error('net::ERR_NETWORK_CHANGED'), certificate],
    [new Error('net::ERR_NETWORK_CHANGED'), race, race],
  ]) {
    let calls = 0;
    await assert.rejects(
      navigate(
        {
          goto: async () => {
            throw sequence[Math.min(calls++, sequence.length - 1)];
          },
        },
        'https://fixture.test',
      ),
      (error) => error === sequence.at(-1),
    );
    assert.equal(calls, sequence.length === 1 ? 2 : sequence.length);
  }
});

test('a first navigation replaced by Chromium error page retries once', async () => {
  let first = true;
  const visited: string[] = [];
  await navigate(
    {
      goto: async (url: string) => {
        visited.push(url);
        if (first) {
          first = false;
          throw new Error(
            'navigation interrupted by chrome-error://chromewebdata/',
          );
        }
      },
    },
    'https://fixture.test',
  );
  assert.deepEqual(visited, ['https://fixture.test', 'https://fixture.test']);
});
