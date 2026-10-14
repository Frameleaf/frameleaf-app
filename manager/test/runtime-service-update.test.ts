import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Docker } from '../src/docker.js';
import { Operations } from '../src/operations.js';

const project = 'frameleaf-' + 'a'.repeat(12);

for (const service of ['immich-machine-learning', 'frameleaf-machine-learning']) {
  test(`updates stop the worker named in the saved Compose file: ${service}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-service-update-'));
    const calls: unknown[][] = [];
    try {
      await writeFile(join(directory, 'compose.json'), JSON.stringify({ services: { [service]: {} } }));
      const operations = Object.assign(Object.create(Operations.prototype), {
        directory: () => directory,
        docker: { compose: (...args: unknown[]) => { calls.push(args); return Promise.resolve(); } },
        step: (_operation: unknown, name: string, action: () => Promise<unknown>) =>
          name === 'stop-application' ? action() : Promise.resolve(),
      });
      await operations.applyUpdate({}, { current: { project, ml: true } });
      assert.deepEqual(calls, [[directory, project, 'stop', ['frameleaf-server', service]]]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('managed startup removes the stopped old worker without deleting its volumes', async () => {
  let command: string[] = [];
  const docker = new Docker((_binary, args) => {
    command = args;
    return Promise.resolve('');
  });
  await docker.compose('/fixture/stack', project, 'up');
  assert.ok(command.includes('--remove-orphans'));
  assert.ok(!command.includes('--volumes'));
});
