import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Store } from '../src/store.js';
import { Fencing } from '../src/fencing.js';
import { Docker, type Container } from '../src/docker.js';
import { sourceFingerprint } from '../src/discovery.js';
import { type Source, type Mount, type Installation } from '../src/contracts.js';
import { copyVerified, fileHash } from '../src/files.js';
import { BACKUP_INDEX, Backups } from '../src/backups.js';
import { Operations } from '../src/operations.js';

const media: Mount[] = [{ type: 'bind', source: '/fixture/media', target: '/data', readOnly: false }];
function container(id: string, running = true, policy = 'unless-stopped'): Container {
  return {
    Id: id.repeat(64),
    Name: `/worker-${id}`,
    Image: `sha256:${id.repeat(64)}`,
    State: { Running: running },
    Config: { Image: 'fixture.invalid/source-server:v3.1.0', Env: [], Labels: {}, Entrypoint: null, Cmd: null },
    HostConfig: { RestartPolicy: { Name: policy, MaximumRetryCount: 0 }, NetworkMode: 'bridge', PortBindings: {} },
    Mounts: [{ Type: 'bind', Source: '/fixture/media', Destination: '/data', RW: true }],
    NetworkSettings: { Networks: { private: { IPAddress: '172.19.0.2', Aliases: ['app'] } } },
  };
}
test('an unlabelled competing writer, stopped auto-restarting writer and a volume alias all block cutover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-fence-')),
    store = new Store(directory);
  const own = container('a', false, 'no'),
    other = container('b');
  const docker = { inventory: async () => [own, other] } as Docker;
  const fencing = new Fencing(docker, store);
  try {
    await assert.rejects(fencing.assertMedia(media), /other_media_writer_detected/);
    other.State.Running = false;
    await assert.rejects(fencing.assertMedia(media), /other_media_writer_detected/);
    other.HostConfig.RestartPolicy.Name = 'no';
    await fencing.assertMedia(media);
    other.State.Running = true;
    own.Mounts = [{ Type: 'volume', Name: 'library', Source: '/fixture/media', Destination: '/data', RW: true }];
    await assert.rejects(
      fencing.assertMedia([{ ...media[0], type: 'volume', source: 'library' }]),
      /other_media_writer_detected/,
    );
    other.Config.Labels['app.frameleaf.manager'] = 'owned';
    await fencing.assertMedia(media, { id: 'owned' } as Installation);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});
test('source fencing resumes after a crash between restart-policy changes without accepting other changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-fence-')),
    store = new Store(directory);
  const app = container('a'),
    worker = container('b'),
    database = container('c');
  database.Mounts = [];
  const all = [app, worker, database];
  const source = {
    id: app.Id,
    app: app.Id,
    workers: [app.Id, worker.Id],
    mounts: media,
    platform: 'docker',
    database: { container: database.Id },
    fingerprint: sourceFingerprint(structuredClone(all)),
    restart: Object.fromEntries([app, worker].map((c) => [c.Id, structuredClone(c.HostConfig.RestartPolicy)])),
  } as Source;
  let interrupt = true;
  const docker = {
    inventory: async () => structuredClone(all),
    restartPolicy: async (id: string, policy: string) => {
      all.find((c) => c.Id === id)!.HostConfig.RestartPolicy.Name = policy;
      if (interrupt) {
        interrupt = false;
        throw new Error('simulated process termination');
      }
    },
    stop: async (id: string) => {
      const c = all.find((c) => c.Id === id)!;
      c.State.Running = false;
      c.NetworkSettings.Networks.private.IPAddress = '';
    },
  } as unknown as Docker;
  try {
    await assert.rejects(new Fencing(docker, store).stop(source), /simulated process termination/);
    await new Fencing(docker, store).stop(source);
    await new Fencing(docker, store).verify(source);
    worker.Config.Env.push('IMMICH_MEDIA_LOCATION=/changed');
    await assert.rejects(new Fencing(docker, store).verify(source), /source_changed_review_again/);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});
test('checkpoint retry replaces a partial published copy and never accepts a changed source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-copy-'));
  const source = join(directory, 'current.dump'),
    target = join(directory, 'database.dump');
  try {
    await writeFile(source, 'complete postgres dump');
    const hash = await fileHash(source);
    await writeFile(target, 'complete post');
    await writeFile(`${target}.partial`, 'interrupted retry');
    await copyVerified(source, target, hash);
    assert.equal(await fileHash(target), hash);
    await writeFile(source, 'changed');
    await writeFile(target, 'incomplete');
    await assert.rejects(copyVerified(source, target, hash), /checkpoint_dump_changed/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
test('native backup reuse uses filename time and SQL library identity, not refreshed mtime', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'manager-backup-')));
  const identity = { id: 'f269b8ab-c83b-4fef-b3c8-216bf92b90cc', createdAt: Date.UTC(2026, 0, 1) };
  const filename = (time: number) => {
    const d = new Date(time),
      pad = (n: number) => String(n).padStart(2, '0');
    return `immich-db-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-v3.1.0-pg14.19.sql.gz`;
  };
  const sql = (id: string) =>
    `COPY public."user" (id, "createdAt") FROM stdin;\n${id}\t2026-01-01 00:00:00+00\n\\.\nCOPY public.asset (id) FROM stdin;\n\\.\nCOPY public.album (id) FROM stdin;\n\\.\n-- PostgreSQL database dump complete\n`;
  const now = Date.now();
  const valid = filename(now - 60_000),
    wrong = filename(now - 120_000),
    old = filename(now - 172_800_000);
  try {
    for (const [name, owner] of [
      [valid, identity.id],
      [wrong, 'another-library'],
      [old, identity.id],
    ]) {
      await writeFile(join(directory, name), gzipSync(sql(owner)));
      await utimes(join(directory, name), new Date(now), new Date(now));
    }
    let output = '';
    await runInNewContext(BACKUP_INDEX, {
      require: createRequire(import.meta.url),
      Buffer,
      process: {
        argv: ['node', directory, JSON.stringify(identity)],
        stdout: {
          write: (value: string) => {
            output += value;
          },
        },
        exit: () => {
          throw new Error('index failed');
        },
      },
    });
    assert.deepEqual(
      JSON.parse(output).map((entry: { name: string }) => entry.name),
      [valid],
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
test('a failed backup can be cancelled without stopping the application or holding the operation lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-operation-')),
    store = new Store(directory);
  store.set('installation', { id: 'owned', mayHaveWrittenMedia: true });
  const { operation } = store.start('backup', 'backup', {});
  operation.state = 'failed';
  store.save(operation);
  const docker = {
    compose: async () => {
      throw new Error('must not change running containers');
    },
  } as unknown as Docker;
  try {
    const operations = new Operations(store, docker, {} as never, {} as never, [], {} as never);
    await operations.recover(operation.id);
    assert.equal(store.history()[0].error, 'backup_cancelled');
    assert.equal(store.start('stop', 'next-control', {}).created, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});
test('cancellation claims the operation before awaiting Docker and excludes simultaneous resume or recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-cancel-race-')),
    store = new Store(directory);
  const installation = { id: 'a'.repeat(12), sourceId: null, mayHaveWrittenMedia: false } as Installation;
  store.set('installation', installation);
  await mkdir(join(directory, 'stack'));
  const { operation } = store.start('install', 'failed-install', {});
  operation.state = 'failed';
  operation.completed = ['configure'];
  store.save(operation);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const docker = {
    inventory: async () => {
      await blocked;
      return [];
    },
  } as unknown as Docker;
  const operations = new Operations(store, docker, {} as never, {} as never, [], {} as never);
  const cancellation = operations.recover(operation.id);
  try {
    assert.equal(store.history()[0].state, 'running');
    assert.ok(store.history()[0].receipts['cancellation-intent']);
    assert.throws(() => operations.resume(operation.id), /operation_not_recoverable/);
    await assert.rejects(operations.recover(operation.id), /operation_not_recoverable/);
    release();
    await cancellation;
    assert.equal(store.history()[0].state, 'complete');
    assert.equal(store.get('installation'), null);
    assert.equal(store.start('install', 'next-install', {}).created, true);
  } finally {
    release();
    await cancellation;
    store.close();
    await rm(directory, { recursive: true });
  }
});
test('a restart after archiving the stack resumes cancellation instead of reinstalling or losing its recovery record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-cancel-restart-')),
    store = new Store(directory);
  const installation = { id: 'b'.repeat(12), sourceId: null, mayHaveWrittenMedia: false } as Installation;
  const password = 'private-recovery-fixture';
  store.set('installation', installation);
  store.set('database-password', password);
  const { operation } = store.start('import', 'interrupted-cancellation', {});
  const archive = join(directory, `cancelled-stack-${operation.id}`);
  // The rename finished but its receipt was not persisted before the process stopped.
  await mkdir(archive);
  await writeFile(join(archive, 'compose.json'), '{}');
  operation.state = 'interrupted';
  operation.step = 'cancel-archive-stack';
  operation.completed = ['configure', 'cancel-stop-target', 'cancel-source'];
  operation.receipts['cancellation-intent'] = { kind: 'source', installation, archive };
  store.save(operation);
  try {
    const operations = new Operations(store, {} as never, {} as never, {} as never, [], {} as never);
    operations.resume(operation.id);
    for (let i = 0; i < 100 && store.history()[0].state === 'running'; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(store.history()[0].state, 'complete', store.history()[0].error ?? undefined);
    assert.equal(store.history()[0].error, 'recovered_source_stopped');
    assert.equal(store.get('installation'), null);
    assert.equal(store.get<{ password: string }>(`cancelled-installation:${operation.id}`)?.password, password);
    assert.equal(await readFile(join(archive, 'compose.json'), 'utf8'), '{}');
    assert.equal(store.start('install', 'next-install', {}).created, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});
test('a completed Restic snapshot is reused after a lost acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-snapshot-'));
  let backups = 0,
    checks = 0;
  const execute = async (_binary: string, args: string[]) => {
    if (args.includes('snapshots'))
      return JSON.stringify([
        { id: 'a'.repeat(64), paths: [directory], tags: ['frameleaf-manager-database', 'frameleaf-canonical'] },
      ]);
    if (args.includes('backup')) backups++;
    if (args.includes('check')) checks++;
    return '';
  };
  try {
    await writeFile(join(directory, 'recovery.json'), JSON.stringify({ databaseFormat: 'frameleaf-canonical' }));
    assert.equal(await new Backups('/repo', '/key', execute).snapshot(directory, 'operation'), 'a'.repeat(64));
    assert.equal(backups, 0);
    assert.equal(checks, 1);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('relative checkpoint backups restore the snapshot root, not their absolute source metadata path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-restore-'));
  const snapshot = 'a'.repeat(64),
    destination = join(directory, 'empty');
  const calls: string[][] = [];
  const execute = async (_binary: string, args: string[]) => {
    calls.push(args);
    if (args.includes('snapshots'))
      return JSON.stringify([
        { id: snapshot, paths: ['/old/host/checkpoint'], tags: ['frameleaf-manager-database', 'frameleaf-canonical'] },
      ]);
    return '';
  };
  try {
    await new Backups('/repo', '/key', execute).restore(snapshot, destination);
    assert.deepEqual(calls[1], [
      '--repo',
      '/repo',
      '--password-file',
      '/key',
      '--json',
      'restore',
      snapshot,
      '--target',
      destination,
      '--verify',
    ]);
    await assert.rejects(
      new Backups('/repo', '/key', execute).restore('b'.repeat(64), join(directory, 'unknown')),
      /unknown_snapshot/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('a failed lifecycle operation resumes and releases its lock after successful reconciliation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-retry-')),
    store = new Store(directory);
  const installation = {
    id: 'a'.repeat(12),
    project: `frameleaf-${'a'.repeat(12)}`,
    mounts: [],
    sourceId: null,
  } as unknown as Installation;
  store.set('installation', installation);
  let attempts = 0;
  const docker = {
    inventory: async () => [],
    compose: async () => {
      if (++attempts === 1) throw new Error('engine unavailable');
    },
  } as unknown as Docker;
  const wait = async () => {
    for (let i = 0; i < 100 && store.history()[0].state === 'running'; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
  };
  try {
    const operations = new Operations(store, docker, {} as never, {} as never, [], { verify: async () => {} } as never);
    const operation = operations.control('start', 'start');
    await wait();
    assert.equal(store.history()[0].state, 'failed');
    operations.resume(operation.id);
    await wait();
    assert.equal(store.history()[0].state, 'complete');
    assert.equal(attempts, 2);
    assert.equal(store.start('stop', 'next', {}).created, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});

test('import verification uses the fenced dump receipt instead of earlier discovery counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-counts-')),
    store = new Store(directory);
  const app = container('a'),
    sourceDb = container('b');
  sourceDb.Mounts = [];
  const source = {
    id: app.Id,
    app: app.Id,
    workers: [app.Id],
    mounts: media,
    platform: 'docker',
    database: { container: sourceDb.Id },
    fingerprint: sourceFingerprint(structuredClone([app, sourceDb])),
    restart: { [app.Id]: structuredClone(app.HostConfig.RestartPolicy) },
    summary: { users: 1, assets: 1, albums: 1 },
  } as Source;
  app.State.Running = false;
  app.HostConfig.RestartPolicy.Name = 'no';
  const installation = {
    id: 'e'.repeat(12),
    project: `frameleaf-${'e'.repeat(12)}`,
    databasePath: '/fixture/database',
    mounts: media,
    sourceId: app.Id,
    mayHaveWrittenMedia: false,
  } as Installation;
  const target = container('c'),
    server = container('d', false, 'no');
  target.Mounts = [{ Type: 'bind', Source: installation.databasePath, Destination: '/var/lib/postgresql', RW: true }];
  for (const [c, service] of [
    [target, 'database'],
    [server, 'frameleaf-server'],
  ] as const)
    c.Config.Labels = { 'app.frameleaf.manager': installation.id, 'com.docker.compose.service': service };
  const docker = {
    inventory: async () => structuredClone([app, sourceDb, target, server]),
    sql: async () => JSON.stringify({ users: 1, assets: 2, albums: 1 }),
    importCommand: async () => ({ status: 'activated' }),
    node: async () => '{}',
    compose: async () => {
      server.State.Running = true;
    },
  } as unknown as Docker;
  store.set('installation', installation);
  store.set(`review:review`, { source, backup: { verified: true }, input: {} });
  const { operation } = store.start('import', 'import', { reviewId: 'review' });
  operation.completed = [
    'preflight',
    'download-images',
    'configure',
    'review-source',
    'fence-source',
    'start-database',
    'capture-fenced-settings',
    'copy-current-database',
    'configure-offline-import',
    'import-canonical-database',
    'import-settings',
  ];
  operation.receipts.configure = installation;
  operation.receipts['copy-current-database'] = { summary: { users: 1, assets: 2, albums: 1 } };
  operation.state = 'interrupted';
  store.save(operation);
  try {
    const operations = new Operations(store, docker, { eligible: async () => {} } as never, {} as never, [], {
      verify: async () => {},
    } as never);
    // This case isolates fenced-count selection; transport reconciliation has separate coverage.
    Object.assign(operations, { runImport: async () => ({ status: 'activated' }) });
    operations.resume(operation.id);
    for (let i = 0; i < 100 && store.history()[0].state === 'running'; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(store.history()[0].state, 'complete', store.history()[0].error ?? undefined);
    assert.deepEqual(store.history()[0].receipts['verify-import'], { countsMatch: true, activated: true });
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});

test('offline importer command refuses a surviving runner and never accepts arbitrary actions', async () => {
  const active = container('a');
  const project = 'frameleaf-aaaaaaaaaaaa';
  const operation = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  active.Name = `/${project}-import-${operation}`;
  active.Config.Labels['app.frameleaf.manager.import'] = operation;
  const calls: string[][] = [];
  const docker = new Docker(async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'ps') return active.Id;
    if (args[0] === 'inspect') return JSON.stringify([active]);
    if (args.includes('run')) return '{"status":"activated"}';
    return '';
  });
  await assert.rejects(docker.importCommand('/fixture', project, operation, 'verify'), /import_still_running/);
  assert.equal(
    calls.some((args) => args[0] === 'rm' || args.includes('run')),
    false,
  );
  await assert.rejects(
    docker.importCommand('/fixture', project, operation, 'shell' as never),
    /invalid_import_command/,
  );
  active.State.Running = false;
  assert.deepEqual(await docker.importCommand('/fixture', project, operation, 'status'), { status: 'activated' });
  const command = calls.find((args) => args.includes('run'))!;
  assert.deepEqual(
    command.slice(-6),
    ['dist/main.js', 'frameleaf-admin', 'import-immich', 'status', '--config', '/run/frameleaf/import.json'].slice(-7),
  );
});
