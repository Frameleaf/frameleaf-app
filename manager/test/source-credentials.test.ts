import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Container } from '../src/docker.js';
import { Discovery } from '../src/discovery.js';
import { Operations } from '../src/operations.js';

const container = (id: string, name: string, env: string[]) =>
  ({
    Id: id,
    Name: `/${name}`,
    Config: { Image: 'ghcr.io/immich-app/immich-server:v2.0.0', Env: env, Labels: {} },
    NetworkSettings: { Networks: { immich: { IPAddress: '', Aliases: [name] } } },
  }) as unknown as Container;

async function credentials(env: string[]) {
  let seen: { name: string; user: string; password: string } | undefined;
  const docker = {
    sql: (database: typeof seen) => {
      seen = database;
      throw new Error('stop');
    },
  };
  const app = container('a'.repeat(64), 'immich_server', env);
  await assert.rejects(new Discovery(docker as never).inspect(app, [app, container('b'.repeat(64), 'database', [])]), /stop/);
  return { name: seen!.name, user: seen!.user, password: seen!.password };
}

test('plain DB_* credentials are used as written, never percent-decoded', async () => {
  assert.deepEqual(await credentials(['DB_PASSWORD=Pa%ss-word', 'DB_USERNAME=ab%41', 'DB_DATABASE_NAME=im%mich']), {
    name: 'im%mich',
    user: 'ab%41',
    password: 'Pa%ss-word',
  });
});

test('DB_URL credentials are percent-decoded', async () => {
  assert.deepEqual(await credentials(['DB_URL=postgres://us%40er:p%25ss@database:5432/my%20db']), {
    name: 'my db',
    user: 'us@er',
    password: 'p%ss',
  });
});

test('library moves accept Unraid user shares without a mounted autostart file', () => {
  const operations = new Operations({ directory: '/manager' } as never, {} as never, {} as never, {} as never, [], {
    unraid: true,
  } as never);
  assert.equal((operations as any).mediaMove.storage.unraid, true);
});
