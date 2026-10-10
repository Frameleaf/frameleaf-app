// Hosted Linux only. Real PostgreSQL, private disposable host folders and the launcher's capabilities.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.GITHUB_ACTIONS) throw new Error('Run this integration fixture in GitHub Actions');
const folder = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'manager-postgres-'));
const names = {
  manager: `manager-disk-${process.pid}`,
  first: `manager-pg-first-${process.pid}`,
  second: `manager-pg-second-${process.pid}`,
};
const root = join(folder, 'appdata'),
  state = join(folder, 'state'),
  backup = join(folder, 'backup');
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const evaluate = (code) => docker('exec', names.manager, 'node', '--input-type=module', '-e', code);
const storage = `import { PostgresStorage } from '/app/manager/build/postgres-storage.js'; import { Docker } from '/app/manager/build/docker.js'; const storage = new PostgresStorage(new Docker(), ${JSON.stringify(state)}, [${JSON.stringify(root)}], false);`;
const firstId = 'aaaaaaaabbbb',
  secondId = 'ccccccccdddd';
const pg = (name, path, id) =>
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `app.frameleaf.manager=${id}`,
    '--label',
    'com.docker.compose.service=database',
    '--mount',
    `type=bind,source=${path},target=/var/lib/postgresql`,
    '-e',
    'POSTGRES_USER=frameleaf',
    '-e',
    'POSTGRES_DB=frameleaf',
    '-e',
    'POSTGRES_PASSWORD=disposable-fixture-password',
    'frameleaf-postgres:manager-test',
  );
const sql = (name, query) =>
  docker('exec', name, 'psql', '-XAt', '-U', 'frameleaf', '-d', 'frameleaf', '-v', 'ON_ERROR_STOP=1', '-c', query);
async function ready(name) {
  for (let i = 0; i < 90; i++) {
    try {
      if (sql(name, 'SELECT 1') === '1') return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const logs = spawnSync('docker', ['logs', '--tail', '40', name], {encoding:'utf8'});
  const diagnostic = `${logs.stdout ?? ''}${logs.stderr ?? ''}`.replaceAll('disposable-fixture-password', '[redacted]');
  console.error(diagnostic.slice(-8000));
  throw new Error('PostgreSQL fixture did not become ready');
}
const evidence = { schemaVersion: 1, commit: process.env.GITHUB_SHA, architecture: process.arch, checks: {} };
try {
  await chmod(folder, 0o755);
  for (const path of [root, state, backup]) await mkdir(path);
  // Only these freshly created fixture folders are changed. No operator or Unraid paths are accessed.
  execFileSync('sudo', ['chown', '0:0', root, state, backup]);
  docker(
    'run',
    '-d',
    '--name',
    names.manager,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--label',
    'app.frameleaf.manager.role=controller',
    '--mount',
    `type=bind,source=${folder},target=${folder}`,
    '--mount',
    'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    '--mount',
    'type=bind,source=/proc/1/mountinfo,target=/run/frameleaf-host/mountinfo,readonly',
    '-e',
    `MANAGER_DATA=${state}`,
    '-e',
    `MANAGER_BACKUP_ROOT=${backup}`,
    '-e',
    `MANAGER_DATABASE_ROOTS=${root}`,
    '-e',
    'MANAGER_ORIGIN=https://localhost:9443',
    'frameleaf-manager:test',
  );
  // Wait for the process, not an application or migration qualification signal.
  for (let i = 0; i < 60; i++) {
    try {
      evaluate(
        'await import("node:fs/promises").then(fs => fs.access(' + JSON.stringify(join(state, 'manager.sqlite')) + '))',
      );
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const first = evaluate(
    storage + `process.stdout.write(await storage.allocate(${JSON.stringify(root)}, '${firstId}', 1));`,
  );
  evaluate(`import assert from 'node:assert/strict'; import {stat} from 'node:fs/promises'; assert.equal((await stat(${JSON.stringify(first)})).mode & 0o777, 0o711);`);
  const firstContainer = pg(names.first, first, firstId);
  await ready(names.first);
  assert.equal(sql(names.first, 'SHOW data_directory'), '/var/lib/postgresql/19/docker');
  assert.equal(sql(names.first, 'SHOW server_version_num').slice(0, 2), '19');
  sql(
    names.first,
    "CREATE TABLE manager_storage_probe (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO manager_storage_probe VALUES (1, 'disk persistence');",
  );
  // Transport coverage only: the real canonical schema and release gate are covered by medium tests.
  // These retained header shapes exercise JSON/timestamps and all five held snapshots through
  // genuine pg_dump, encrypted Restic, container replacement and fresh-directory pg_restore.
  sql(names.first, `CREATE TABLE job_run (id uuid PRIMARY KEY, selection jsonb NOT NULL);
    CREATE TABLE job_selection (stage text PRIMARY KEY, state text NOT NULL, "capturedAt" timestamptz NOT NULL);
    INSERT INTO job_run VALUES ('11111111-2222-3333-4444-555555555555',
      '{"source":"fixture-source","config":"fixture-config","managerSetup":{"installation":"${firstId}","operationId":"11111111-2222-3333-4444-555555555555","preparedAt":"2026-01-01T00:00:00Z","startedAt":null}}');
    INSERT INTO job_selection SELECT stage,'enumerating','2026-01-01T00:00:00Z' FROM unnest(ARRAY[
      'AssetExtractMetadata','AssetGenerateThumbnails','SmartSearch','AssetDetectFaces','PersonGenerateThumbnail']) stage;`);
  const pendingRun = sql(names.first, 'SELECT selection::text FROM job_run');
  const heldSnapshots = sql(names.first, 'SELECT jsonb_agg(to_jsonb(s) ORDER BY stage)::text FROM job_selection s');
  const installation = { id: firstId, databaseRoot: root, databasePath: first };
  evaluate(
    storage +
      `import assert from 'node:assert/strict'; import { access } from 'node:fs/promises'; import { constants } from 'node:fs'; await assert.rejects(access(${JSON.stringify(join(first, '19', 'docker'))}, constants.R_OK | constants.W_OK | constants.X_OK)); await storage.verify(${JSON.stringify(installation)});`,
  );
  evidence.checks.privateInitializedPostgresWithDroppedManagerCapabilities = 'passed';
  const dump = join(state, 'database.dump');
  const database = {
    container: firstContainer,
    host: 'database',
    port: 5432,
    name: 'frameleaf',
    user: 'frameleaf',
    password: 'disposable-fixture-password',
  };
  evaluate(
    `import { Docker } from '/app/manager/build/docker.js'; await new Docker().dump(${JSON.stringify(database)}, ${JSON.stringify(dump)});`,
  );
  const checkpoint = join(state, 'checkpoint'),
    recovered = join(state, 'recovered');
  const restoredDump = join(recovered, 'database.dump');
  // Exercise the packaged Restic binary and Manager coordination, then discard the local dump.
  // Recovery must work from the encrypted repository and exported key into an empty folder.
  evaluate(`import assert from 'node:assert/strict'; import { mkdir, copyFile, writeFile, rm, readFile } from 'node:fs/promises';
    import { Backups } from '/app/manager/build/backups.js'; import { fileHash } from '/app/manager/build/files.js';
    import { command } from '/app/manager/build/docker.js';
    const execute = async (binary, args, options) => {
      const operation = args.find(value => ['init', 'cat', 'snapshots', 'backup', 'check', 'restore'].includes(value));
      try { return await command(binary, args, options); }
      catch { throw new Error('Disposable Restic fixture failed at ' + operation); }
    };
    const checkpoint=${JSON.stringify(checkpoint)}, repository=${JSON.stringify(backup)}, recovered=${JSON.stringify(recovered)};
    const backups = new Backups(repository, ${JSON.stringify(join(state, 'restic-key'))}, execute);
    await mkdir(checkpoint); await copyFile(${JSON.stringify(dump)}, checkpoint+'/database.dump');
    await writeFile(checkpoint+'/recovery.json', JSON.stringify({ mediaIncluded: false, databaseFormat: 'frameleaf-canonical', fixtureSecret: 'disposable-recovery-secret' }));
    const hash = await fileHash(checkpoint+'/database.dump');
    await backups.initialize(); const snapshot = await backups.snapshot(checkpoint, 'fixture-database-backup');
    assert.equal(await backups.snapshot(checkpoint, 'fixture-database-backup'), snapshot);
    const key = await backups.recoveryKey();
    await rm(checkpoint, { recursive: true }); await rm(${JSON.stringify(dump)});
    const replacement = new Backups(repository, ${JSON.stringify(join(state, 'replacement-key'))}, execute);
    await replacement.unlock(key); await replacement.restore(snapshot, recovered);
    assert.equal(await fileHash(recovered+'/database.dump'), hash);
    assert.equal(JSON.parse(await readFile(recovered+'/recovery.json', 'utf8')).fixtureSecret, 'disposable-recovery-secret');
  `);
  evidence.checks.encryptedResticDatabaseRecoveryToEmptyDirectory = 'passed';
  docker('rm', '-f', names.first);
  pg(names.first, first, firstId);
  await ready(names.first);
  assert.equal(sql(names.first, 'SELECT value FROM manager_storage_probe WHERE id=1'), 'disk persistence');
  evidence.checks.databaseSurvivesContainerReplacement = 'passed';
  const second = evaluate(
    storage + `process.stdout.write(await storage.allocate(${JSON.stringify(root)}, '${secondId}', 1));`,
  );
  assert.notEqual(first, second);
  const secondContainer = pg(names.second, second, secondId);
  await ready(names.second);
  const restoredDatabase = { ...database, container: secondContainer };
  evaluate(
    `import { Docker } from '/app/manager/build/docker.js'; const docker = new Docker(); await docker.verifyDump(${JSON.stringify(restoredDatabase)}, ${JSON.stringify(restoredDump)}); await docker.restore(${JSON.stringify(restoredDatabase)}, ${JSON.stringify(restoredDump)});`,
  );
  assert.equal(sql(names.second, 'SELECT value FROM manager_storage_probe WHERE id=1'), 'disk persistence');
  assert.equal(sql(names.first, 'SELECT value FROM manager_storage_probe WHERE id=1'), 'disk persistence');
  evidence.checks.logicalRestoreUsesFreshHostDirectoryAndPreservesSource = 'passed';
  assert.equal(sql(names.second, 'SELECT selection::text FROM job_run'), pendingRun);
  assert.equal(sql(names.second, 'SELECT jsonb_agg(to_jsonb(s) ORDER BY stage)::text FROM job_selection s'), heldSnapshots);
  assert.equal(sql(names.second, 'SELECT count(*) FROM job_selection WHERE state=\'enumerating\''), '5');
  assert.equal(sql(names.second, "SELECT selection #>> '{managerSetup,installation}' FROM job_run"), firstId);
  assert.equal(sql(names.second, "SELECT selection #>> '{managerSetup,startedAt}' FROM job_run"), '');
  assert.equal(sql(names.first, 'SELECT selection::text FROM job_run'), pendingRun);
  evidence.checks.preparedUnstartedImportAndFiveHeldSnapshotsSurviveCanonicalTransport = 'passed';
  for (const name of [names.first, names.second]) {
    const container = JSON.parse(docker('inspect', name))[0];
    const mount = container.Mounts.find((m) => m.Destination === '/var/lib/postgresql');
    assert.equal(mount.Type, 'bind');
    assert.ok(mount.Source.startsWith(root + '/frameleaf-'));
  }
} finally {
  for (const name of Object.values(names)) {
    try {
      docker('rm', '-f', name);
    } catch {}
  }
  await writeFile('manager-postgres-evidence.json', JSON.stringify(evidence, null, 2));
  // Container cleanup is restricted to the one fresh fixture root and occurs after all users stop.
  try {
    docker(
      'run',
      '--rm',
      '--mount',
      `type=bind,source=${folder},target=/fixture`,
      '--entrypoint',
      'sh',
      'frameleaf-manager:test',
      '-c',
      'rm -rf /fixture/appdata /fixture/state /fixture/backup',
    );
  } catch {}
  await rm(folder, { recursive: true, force: true });
}
