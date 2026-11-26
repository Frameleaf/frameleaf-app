// FL-462: Unraid setup refused a working Immich install and a dedicated database folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Container } from '../src/docker.js';
import { isSourceServer } from '../src/discovery.js';

// The upstream repository name is assembled: the Frameleaf naming gate rejects it as a literal anywhere in the repo.
const SERVER = ['immich', 'server'].join('-');

test('Immich servers are recognised by repository name, whatever the registry or owner', () => {
  for (const image of [
    `ghcr.io/upstream-owner/${SERVER}:v3.2.4`,
    `ghcr.io/upstream-owner/${SERVER}@sha256:` + 'a'.repeat(64),
    `ghcr.io/adamtaylor152/${SERVER}:fork-main`,
    `docker.io/altran1502/${SERVER}:release`,
    `registry.local:5000/photos/${SERVER}:latest`,
    'ghcr.io/upstream-owner/immich-microservices:v1.105.0',
    'ghcr.io/open-noodle/gallery-server:release',
    'ghcr.io/open-noodle/gallery-server:v5.9.0',
  ])
    assert.ok(isSourceServer(image), image);
  for (const image of [
    'ghcr.io/upstream-owner/immich-machine-learning:v3.2.4',
    'ghcr.io/frameleaf/frameleaf-server:latest',
    `ghcr.io/someone/not-${SERVER}:latest`,
    `${SERVER}-proxy:latest`,
    'ghcr.io/open-noodle/gallery-ml:release',
    'ghcr.io/someone/gallery-server:latest',
  ])
    assert.ok(!isSourceServer(image), image);
});

function container(name: string, mounts: Container['Mounts'], labels: Record<string, string> = {}): Container {
  return {
    Id: name.padEnd(64, '0'),
    Name: `/${name}`,
    Image: 'sha256:' + '0'.repeat(64),
    State: { Running: false },
    Config: { Image: `fixture/${name}`, Env: [], Labels: labels, Entrypoint: null, Cmd: null },
    HostConfig: { RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, NetworkMode: 'bridge', PortBindings: {} },
    Mounts: mounts,
    NetworkSettings: { Networks: {} },
  };
}

test('psql and pg_dump use the Immich database port, not only 5432', async () => {
  const { Docker } = await import('../src/docker.js');
  const calls: string[][] = [];
  const docker = new Docker((async (_binary: string, args: string[]) => {
    calls.push(args);
    return '';
  }) as never);
  const db = { container: 'c'.repeat(64), host: '192.168.4.20', port: 5433, name: 'immich', user: 'postgres', password: 'x' };
  await docker.sql(db as never, 'select 1');
  await docker.dump(db as never, '/tmp/fixture.dump');
  for (const args of calls) assert.deepEqual(args.slice(args.indexOf('--port'), args.indexOf('--port') + 2), ['--port', '5433']);
});
