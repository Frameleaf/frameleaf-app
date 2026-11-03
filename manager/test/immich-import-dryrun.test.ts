// FL-460: regressions from the START-07 Immich 3.2.4 import dry run (manager-v0.2.0).
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Docker, command, mounts, type CommandOptions, type Container } from '../src/docker.js';
import { sourceFingerprint } from '../src/discovery.js';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import type { Source } from '../src/contracts.js';
import { readable } from '../ui/src/presentation.js';

function container(id: string, port?: number): Container {
  return {
    Id: id.repeat(64),
    Name: `/immich-${id}`,
    Image: `sha256:${id.repeat(64)}`,
    State: { Running: true },
    Config: { Image: 'fixture.invalid/source-server:v3.2.4', Env: [], Labels: {}, Entrypoint: null, Cmd: null },
    HostConfig: {
      RestartPolicy: { Name: 'always', MaximumRetryCount: 0 },
      NetworkMode: 'bridge',
      PortBindings: port ? { '2283/tcp': [{ HostIp: '', HostPort: String(port) }] } : {},
    },
    Mounts: [
      { Type: 'bind', Source: '/srv/immich/library', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/etc/localtime', Destination: '/etc/localtime', RW: false },
    ],
    NetworkSettings: { Networks: { source_default: { IPAddress: '172.19.0.2', Aliases: ['source-server', 'server'] } } },
  };
}

test('pg_restore --list closing stdin after the table of contents is not a failed database copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-dump-list-'));
  const dump = join(directory, 'database.dump');
  try {
    // Larger than any pipe buffer, so the writer is still streaming when the reader exits.
    await writeFile(dump, Buffer.alloc(16 * 1024 * 1024, 1));
    const readTocAndExit = 'process.stdin.once("data",()=>process.exit(0))';
    const options: CommandOptions = { executable: process.execPath, inputFile: dump, inputMayCloseEarly: true, timeout: 10_000 };
    await command('docker', ['-e', readTocAndExit], options);
    // An early-closing reader still has to succeed: a pg_restore error is a failed copy.
    await assert.rejects(
      command('docker', ['-e', 'process.stdin.once("data",()=>process.exit(1))'], options),
      { message: 'docker_operation_failed' },
    );
    let seen: CommandOptions | undefined;
    await new Docker((async (_binary: string, _args: string[], opts?: CommandOptions) => {
      seen = opts;
      return '';
    }) as typeof command).verifyDump({ container: 'c'.repeat(64) } as never, dump);
    assert.equal(seen?.inputMayCloseEarly, true, 'verifyDump must allow pg_restore --list to stop reading early');
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('database commands pass the password through the docker environment, not its argv', async () => {
  const calls: { args: string[]; options?: CommandOptions }[] = [];
  const docker = new Docker((async (_binary: string, args: string[], options?: CommandOptions) => {
    calls.push({ args, options });
    return '';
  }) as typeof command);
  const db = { container: 'c'.repeat(64), user: 'postgres', name: 'frameleaf', password: 's3cret-value' } as never;
  await docker.sql(db, 'SELECT 1');
  await docker.dump(db, '/unused-destination');
  await docker.restore(db, '/unused-source');
  assert.equal(calls.length, 3);
  for (const { args, options } of calls) {
    assert.ok(!args.some((arg) => arg.includes('s3cret-value')));
    assert.equal(args[args.indexOf('--env') + 1], 'PGPASSWORD');
    assert.equal(options?.env?.PGPASSWORD, 's3cret-value');
  }
});

test('the source fingerprint ignores the order Docker lists mounts and network aliases in', () => {
  const first = [container('a'), container('b')];
  const second = structuredClone(first).reverse();
  for (const c of second) {
    c.Mounts.reverse();
    c.NetworkSettings.Networks.source_default.Aliases!.reverse();
  }
  assert.equal(sourceFingerprint(structuredClone(second)), sourceFingerprint(structuredClone(first)));
  assert.deepEqual(mounts(second[0]), mounts(first[1]), 'reviewed media mappings are listed in a stable order');
  // Real changes still count.
  second[0].Mounts[0].Source = '/srv/other';
  assert.notEqual(sourceFingerprint(second), sourceFingerprint(first));
});

test('an import may take over the port of the Immich installation it replaces, and only that one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-import-port-'));
  const store = new Store(directory);
  const immich = container('a', 2283),
    unrelated = container('d', 2290);
  const docker = { inventory: async () => [immich, unrelated] } as unknown as Docker;
  const operations = new Operations(store, docker, {} as never, {} as never, [], {} as never);
  const source = { workers: [immich.Id], database: { container: 'b'.repeat(64) } } as Source;
  try {
    await assert.rejects(operations.checkPort(2283), /port_in_use/);
    await operations.checkPort(2283, null, source);
    await assert.rejects(operations.checkPort(2290, null, source), /port_in_use/);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});

test('failed commands log the command, exit code and a redacted stderr tail', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: string) => lines.push(line));
  await assert.rejects(
    command(
      'docker',
      ['-e', 'process.stderr.write("x".repeat(5000)+" password=hunter2 pg_restore: input file is too short");process.exit(31)', '--', '--env', 'PGPASSWORD=s3cret-value'],
      { executable: process.execPath, timeout: 5000 },
    ),
    { message: 'docker_operation_failed' },
  );
  const logged = lines.join('\n');
  assert.match(logged, /docker/);
  assert.match(logged, /exit 31/);
  assert.match(logged, /input file is too short/);
  assert.doesNotMatch(logged, /hunter2|s3cret-value/);
  assert.ok(logged.length < 3000, 'only the tail of stderr is logged');
});

test('failed commands also redact secrets passed through the environment', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: string) => lines.push(line));
  await assert.rejects(
    command('docker', ['-e', 'process.stderr.write("auth failed for " + process.env.PGPASSWORD);process.exit(2)'], {
      executable: process.execPath,
      timeout: 5000,
      env: { PGPASSWORD: 'env-s3cret' },
    }),
    { message: 'docker_operation_failed' },
  );
  const logged = lines.join('\n');
  assert.match(logged, /auth failed for/);
  assert.doesNotMatch(logged, /env-s3cret/);
});

test('import failures read as reasons, not error codes', () => {
  for (const code of ['source_changed_review_again', 'port_in_use', 'docker_operation_failed', 'operation_failed']) {
    const text = readable(code);
    assert.notEqual(text, code.replaceAll('_', ' '), code);
    assert.ok(text.endsWith('.'), code);
  }
});
