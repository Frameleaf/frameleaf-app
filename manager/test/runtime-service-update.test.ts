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

const image = (c: string) => `ghcr.io/frameleaf/frameleaf-machine-learning@sha256:${c.repeat(64)}`;
async function stack(services: Record<string, { image: string }>) {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-compose-up-'));
  await writeFile(join(directory, 'compose.json'), JSON.stringify({ services }));
  return directory;
}

test('managed startup removes the stopped old worker without deleting its volumes', async () => {
  const directory = await stack({ database: { image: image('a') } });
  let command: string[] = [];
  const docker = new Docker((_binary, args) => {
    command = args;
    return Promise.resolve(image('a'));
  });
  try {
    await docker.compose(directory, project, 'up');
    assert.ok(command.includes('--remove-orphans'));
    assert.ok(!command.includes('--volumes'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('starting pulls only the pinned images this host is missing, so a resumed setup can start', async () => {
  const directory = await stack({
    database: { image: image('a') },
    'frameleaf-server': { image: image('b') },
    'frameleaf-machine-learning': { image: image('c') },
  });
  const calls: string[][] = [];
  const docker = new Docker((_binary, args) => {
    calls.push(args);
    return Promise.resolve(args[1] === 'ls' ? `${image('a')}\n${image('b')}\n` : '');
  });
  try {
    await docker.compose(directory, project, 'up');
    assert.deepEqual(calls.filter((a) => a[0] === 'pull'), [['pull', image('c')]]);
    assert.equal(calls.at(-1)?.[0], 'compose');

    // Starting only the database looks at the database image alone.
    calls.length = 0;
    await docker.compose(directory, project, 'up', ['database']);
    assert.deepEqual(calls.filter((a) => a[0] === 'pull'), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a tagged, digest-pinned image already on the host is not pulled again', async () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  const directory = await stack({ database: { image: `ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7@${digest}` } });
  const calls: string[][] = [];
  const docker = new Docker((_binary, args) => {
    calls.push(args);
    return Promise.resolve(args[1] === 'ls' ? `ghcr.io/frameleaf/frameleaf-postgres@${digest}\n` : '');
  });
  try {
    await docker.compose(directory, project, 'up');
    assert.deepEqual(calls.filter((a) => a[0] === 'pull'), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
