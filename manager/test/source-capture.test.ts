import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type SourceFence } from '../src/contracts.js';
import { type Container, type Docker } from '../src/docker.js';
import { sourceFingerprint } from '../src/discovery.js';
import { Fencing } from '../src/fencing.js';
import { fileHash } from '../src/files.js';
import { sqliteSchemaFingerprint } from '../src/import-sqlite.js';
import { captureFencedSqliteSource } from '../src/source-capture.js';
import { Store } from '../src/store.js';

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'manager-source-capture-'));
  const sourceRoot = join(root, 'source'), stagingRoot = join(root, 'staging');
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(stagingRoot, { mode: 0o700 });
  const databasePath = join(sourceRoot, 'catalog.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE photos(id INTEGER PRIMARY KEY, caption TEXT); INSERT INTO photos VALUES(1,'Edited caption')");
  const store = new Store(join(root, 'manager'));
  t.after(async () => { database.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const app: Container = {
    Id: 'a'.repeat(64), Name: '/synthetic-photo-source', Image: 'sha256:' + 'b'.repeat(64),
    State: { Running: true },
    Config: { Image: 'fixture.invalid/photo-source:pinned', Env: [], Labels: {}, Entrypoint: null, Cmd: null },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 }, NetworkMode: 'bridge', PortBindings: {} },
    Mounts: [{ Type: 'bind', Source: sourceRoot, Destination: '/source', RW: true }],
    NetworkSettings: { Networks: { private: { IPAddress: '172.19.0.2', Aliases: ['app'] } } },
  };
  const source: SourceFence = {
    id: app.Id, workers: [app.Id], containers: [app.Id], platform: 'docker',
    mounts: [{ type: 'bind', source: sourceRoot, target: '/source', readOnly: false }],
    fingerprint: sourceFingerprint([app]), restart: { [app.Id]: structuredClone(app.HostConfig.RestartPolicy) },
  };
  const fault = { onInventory: undefined as (() => Promise<void>) | undefined };
  let mutations = 0;
  const docker = {
    inventory: async () => { await fault.onInventory?.(); return [structuredClone(app)]; },
    restartPolicy: async (_id: string, policy: string) => { mutations++; app.HostConfig.RestartPolicy.Name = policy; },
    stop: async () => { mutations++; app.State.Running = false; },
  } as unknown as Docker;
  const fencing = new Fencing(docker, store);
  const input = { databasePath, stagingRoot, expectedSchemaSha256: sqliteSchemaFingerprint(database) };
  return { root, sourceRoot, stagingRoot, databasePath, database, source, app, fault, fencing, input, mutations: () => mutations };
}

test('captures committed WAL metadata privately and binds the snapshot to the actual source fence', async (t) => {
  const f = await setup(t);
  const before = await Promise.all([readFile(f.databasePath), readFile(f.databasePath + '-wal')]);
  const snapshot = await captureFencedSqliteSource(f.fencing, f.source, f.input);
  const copy = new DatabaseSync(snapshot.path, { readOnly: true });
  try { assert.equal(copy.prepare('SELECT caption FROM photos WHERE id=1').get()?.caption, 'Edited caption'); }
  finally { copy.close(); }
  assert.equal(snapshot.sourceId, f.source.id);
  assert.equal(snapshot.sourceFingerprint, f.source.fingerprint);
  assert.equal(snapshot.schemaSha256, f.input.expectedSchemaSha256);
  assert.equal(snapshot.sha256, await fileHash(snapshot.path));
  assert.equal((await stat(snapshot.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(snapshot.path))).mode & 0o777, 0o700);
  assert.deepEqual(await Promise.all([readFile(f.databasePath), readFile(f.databasePath + '-wal')]), before);
  assert.equal(f.app.State.Running, false);
  assert.equal(f.app.HostConfig.RestartPolicy.Name, 'no');
});

test('unknown schemas remove only their own snapshot and keep the source fenced', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.stagingRoot, 'previous.json'), 'retained');
  await assert.rejects(captureFencedSqliteSource(f.fencing, f.source, { ...f.input, expectedSchemaSha256: '0'.repeat(64) }), /source_snapshot_schema_unqualified/);
  assert.deepEqual(await readdir(f.stagingRoot), ['previous.json']);
  assert.equal(f.app.State.Running, false);
  assert.equal(f.app.HostConfig.RestartPolicy.Name, 'no');
});

test('changed source WAL metadata refuses the receipt and removes the incomplete capture', async (t) => {
  const f = await setup(t);
  let changed = false;
  f.fault.onInventory = async () => {
    if (!changed && (await readdir(f.stagingRoot)).some((name) => name.startsWith('sqlite-import-'))) {
      changed = true;
      f.database.exec("INSERT INTO photos VALUES(2,'Unexpected writer')");
    }
  };
  await assert.rejects(captureFencedSqliteSource(f.fencing, f.source, f.input), /source_snapshot_changed/);
  assert.equal(changed, true);
  assert.deepEqual(await readdir(f.stagingRoot), []);
  assert.equal(f.app.State.Running, false);
  assert.equal(f.app.HostConfig.RestartPolicy.Name, 'no');
});

for (const invalid of ['outside source', 'symbolic link', 'shared staging', 'staging in source']) {
  test(`invalid capture paths make no container changes: ${invalid}`, async (t) => {
    const f = await setup(t);
    const input = { ...f.input };
    switch (invalid) {
      case 'outside source': input.databasePath = join(f.root, 'unreviewed.sqlite'); break;
      case 'symbolic link': input.databasePath = join(f.sourceRoot, 'link.sqlite'); await symlink(f.databasePath, input.databasePath); break;
      case 'shared staging': await chmod(f.stagingRoot, 0o755); break;
      case 'staging in source': input.stagingRoot = f.sourceRoot; break;
    }
    await assert.rejects(captureFencedSqliteSource(f.fencing, f.source, input));
    assert.equal(f.mutations(), 0);
    assert.equal(f.app.State.Running, true);
  });
}
