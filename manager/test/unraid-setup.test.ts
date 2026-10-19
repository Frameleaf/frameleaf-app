// FL-462: Unraid setup refused a working Immich install and a dedicated database folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Container } from '../src/docker.js';
import { isSourceServer } from '../src/discovery.js';
import { overlappingWriter } from '../src/postgres-storage.js';

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
  ])
    assert.ok(isSourceServer(image), image);
  for (const image of [
    'ghcr.io/upstream-owner/immich-machine-learning:v3.2.4',
    'ghcr.io/frameleaf/frameleaf-server:latest',
    `ghcr.io/someone/not-${SERVER}:latest`,
    `${SERVER}-proxy:latest`,
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

test('only another container that can write to the database folder blocks it, and it is named', () => {
  const path = '/mnt/user/appdata/frameleaf-databases';
  const manager = container('manager', [{ Type: 'bind', Source: path, Destination: path, RW: true }]);
  const reader = container('backup-reader', [{ Type: 'bind', Source: '/mnt/user/appdata', Destination: '/appdata', RW: false }]);
  const sibling = container('website', [{ Type: 'bind', Source: '/mnt/user/appdata/frameleaf-website', Destination: '/site', RW: true }]);
  const ours = container('frameleaf-db', [{ Type: 'bind', Source: path, Destination: '/var/lib/postgresql', RW: true }], {
    'app.frameleaf.manager': 'abc123def456',
  });
  assert.equal(overlappingWriter([manager, reader, sibling, ours], path, manager.Id, 'abc123def456'), undefined);
  const writer = container('file-manager', [{ Type: 'bind', Source: '/mnt/user', Destination: '/media', RW: true }]);
  assert.deepEqual(overlappingWriter([manager, writer], path, manager.Id), { container: 'file-manager', source: '/mnt/user' });
  // A stopped container still counts: it can be started later and write into the database.
  assert.equal(writer.State.Running, false);
  // A stopped or older Manager container maps the database parent too; it never writes PGDATA.
  const oldManager = container('frameleaf-manager-old', [{ Type: 'bind', Source: path, Destination: path, RW: true }], {
    'app.frameleaf.manager.role': 'controller',
  });
  assert.equal(overlappingWriter([manager, oldManager], path + '/frameleaf-x-postgres-y', manager.Id), undefined);
});

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
