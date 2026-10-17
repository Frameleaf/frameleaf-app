import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { serverTestConfig } from './vitest.server-config.ts';

const originalFetch = globalThis.fetch;
const originalSkip = process.env.VITEST_DISABLE_DOCKER_SETUP;
const originalCI = process.env.CI;
beforeEach(() => {
  delete process.env.VITEST_DISABLE_DOCKER_SETUP;
  delete process.env.CI;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [
    ['VITEST_DISABLE_DOCKER_SETUP', originalSkip],
    ['CI', originalCI],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

for (const [name, include] of [
  ['e2e:server', 'src/specs/server/**/*.e2e-spec.ts'],
  ['e2e:maintenance', 'src/specs/maintenance/server/**/*.e2e-spec.ts'],
]) {
  test(`${name} reuses a healthy server and keeps its suite settings`, async () => {
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:2285/api/server/ping');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ res: 'pong' });
    };
    const config = await serverTestConfig(name, include);
    assert.deepEqual(config.test, {
      name,
      retry: 0,
      include: [include],
      globalSetup: [],
      testTimeout: 15000,
      pool: 'threads',
      maxWorkers: 1,
      isolate: false,
    });
    assert.deepEqual(config.resolve, { tsconfigPaths: true });
    assert.equal(calls, 1);
  });
}

for (const [name, response] of [
  ['HTTP failure', () => Response.json({ res: 'pong' }, { status: 503 })],
  ['wrong service', () => Response.json({ res: 'other' })],
  ['HTML proxy', () => new Response('<html>proxy</html>')],
  ['empty response', () => Response.json(null)],
  [
    'network failure',
    () => {
      throw new Error('connection refused');
    },
  ],
  [
    'timed out probe',
    () => {
      throw new DOMException('Timed out', 'TimeoutError');
    },
  ],
]) {
  test(`schedules setup for ${name}`, async () => {
    globalThis.fetch = async () => response();
    const config = await serverTestConfig('e2e:server', 'suite');
    assert.deepEqual(config.test.globalSetup, ['src/docker-compose.ts']);
  });
}

test('an explicit setup skip avoids the probe and preserves CI retries', async () => {
  process.env.VITEST_DISABLE_DOCKER_SETUP = 'true';
  process.env.CI = 'true';
  globalThis.fetch = async () => {
    throw new Error('probe must not run');
  };
  const config = await serverTestConfig('e2e:maintenance', 'suite');
  assert.deepEqual(config.test.globalSetup, []);
  assert.equal(config.test.retry, 4);
});
