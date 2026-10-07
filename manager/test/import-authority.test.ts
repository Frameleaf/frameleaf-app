import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { Docker, type Container } from '../src/docker.js';
import type { Installation, Source, Operation } from '../src/contracts.js';
import type { Releases } from '../src/releases.js';
import type { Backups } from '../src/backups.js';
import type { PostgresStorage } from '../src/postgres-storage.js';

// Exercise real orchestration and file publication with Docker/role execution mocked.
// These tests do not qualify a live Docker network, PostgreSQL grants, or source fencing.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'manager-import-authority-'));
  const directory = join(root, '$tenant');
  const store = new Store(directory);
  const installation = {
    id: 'a'.repeat(12),
    project: `frameleaf-${'a'.repeat(12)}`,
    sourceId: 'b'.repeat(64),
    release: 'v1.0.0',
    port: 2283,
    ml: false,
    origin: 'new_import',
    mayHaveWrittenMedia: false,
    databaseRoot: '/fixture/db',
    databasePath: '/fixture/db/instance',
    mounts: [
      { type: 'bind', source: '/fixture/$media', target: '/data', readOnly: false },
      { type: 'volume', source: 'library', target: '/data/library', readOnly: false },
    ],
  } as Installation;
  const source = {
    id: installation.sourceId,
    version: 'v3.1.0',
    environment: { IMMICH_MEDIA_LOCATION: '/data' },
    database: {
      container: 'source-db',
      host: 'database',
      port: 5432,
      name: 'immich',
      user: 'admin',
      password: 'fixture',
    },
  } as Source;
  const destination = {
    Id: 'target-db',
    State: { Running: true },
    Config: { Labels: { 'app.frameleaf.manager': installation.id, 'com.docker.compose.service': 'database' } },
    Mounts: [{ Type: 'bind', Source: installation.databasePath, Destination: '/var/lib/postgresql', RW: true }],
    NetworkSettings: { Networks: { [`${installation.project}_default`]: { IPAddress: '172.20.0.8' } } },
  } as Container;
  const upstream = {
    Id: 'source-db',
    NetworkSettings: { Networks: { 'source-$tenant': { IPAddress: '172.19.0.7' } } },
  } as unknown as Container;
  const events: string[] = [];
  const inventory: Container[] = [destination];
  const docker = {
    inventory: async () => inventory,
    inspect: async (id: string) => (id === 'source-db' ? upstream : destination),
    sql: async (_database: unknown, sql: string) => {
      events.push(sql);
      return '';
    },
    restartPolicy: async () => {
      events.push('restart:no');
    },
    stop: async () => {
      events.push('stop');
    },
  } as unknown as Docker;
  const operations = new Operations(store, docker, {} as Releases, {} as Backups, [], {
    verify: async () => {},
  } as unknown as PostgresStorage);
  // TypeScript private methods remain the actual production implementations at runtime.
  const internal = operations as unknown as {
    configureImport(operation: Operation, review: { source: Source }, installation: Installation): Promise<void>;
    cancelOperation(operation: Operation): Promise<void>;
    fencing: { recover(): Promise<void> };
  };
  store.set('installation', installation);
  store.set('database-password', 'fixture-destination-password');
  store.set(`source:${source.id}`, source);
  const { operation } = store.start('import', 'fixture-request', {});
  await mkdir(operations.directory(), { recursive: true });
  await writeFile(
    join(operations.directory(), 'compose.json'),
    JSON.stringify({
      services: {
        'frameleaf-server': {
          environment: { OLD_VALUE: 'removed' },
          labels: {},
          ports: ['2283:2283'],
          depends_on: ['database'],
          healthcheck: { test: ['true'] },
          volumes: [
            { type: 'bind', source: '/fixture/$$media', target: '/data', read_only: false },
            {
              type: 'volume',
              source: 'source-media-1',
              target: '/data/library',
              read_only: false,
              volume: { nocopy: true },
            },
          ],
        },
      },
      volumes: { 'source-media-1': { external: true, name: 'library' } },
      networks: { default: {} },
    }),
  );
  return {
    root,
    store,
    operations,
    internal,
    operation,
    installation,
    source,
    destination,
    upstream,
    events,
    inventory,
    docker,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('offline import preserves exact mounts read-only and escapes literal dollar config paths', async () => {
  const f = await fixture();
  try {
    await f.internal.configureImport(f.operation, { source: f.source }, f.installation);
    const config = JSON.parse(await readFile(join(f.operations.directory(), 'import.json'), 'utf8'));
    assert.deepEqual(config.mediaRoots, [
      { source: '/data', target: '/data' },
      { source: '/data/library', target: '/data/library' },
    ]);
    assert.deepEqual(config.media, {
      mode: 'manager-in-place',
      authority: 'frameleaf-manager',
      operationId: f.operation.id,
      deploymentId: f.installation.id,
    });
    const compose = JSON.parse(await readFile(join(f.operations.directory(), 'import-compose.json'), 'utf8'));
    const app = compose.services['frameleaf-server'];
    assert.deepEqual(app.volumes.slice(0, 2), [
      { type: 'bind', source: '/fixture/$$media', target: '/data', read_only: true },
      { type: 'volume', source: 'source-media-1', target: '/data/library', read_only: true, volume: { nocopy: true } },
    ]);
    assert.equal(
      app.volumes[2].source,
      join(f.operations.directory(), 'import.json').replaceAll('$', () => '$$'),
    );
    assert.equal(app.volumes[2].target, '/run/frameleaf/import.json');
    assert.equal(app.volumes[2].read_only, true);
    assert.equal(compose.networks['import-source'].name, 'source-$$tenant');
    assert.equal(app.restart, 'no');
    assert.deepEqual(app.logging, { driver: 'none' });
    for (const field of ['ports', 'depends_on', 'healthcheck']) assert.equal(field in app, false);
    assert.equal(app.environment.OLD_VALUE, undefined);
    assert.equal(app.environment.FRAMELEAF_MANAGER_ORIGIN, f.installation.origin);
    assert.equal(app.environment.FRAMELEAF_MANAGER_INSTALLATION, config.media.deploymentId);
    assert.equal(app.environment.FRAMELEAF_IMPORT_MANAGER_OPERATION_ID, f.operation.id);
    assert.equal(new URL(app.environment.DB_URL).hostname, '172.20.0.8');
    assert.equal(new URL(app.environment.FRAMELEAF_IMPORT_SOURCE_URL).hostname, '172.19.0.7');
  } finally {
    await f.cleanup();
  }
});

test('actual offline verify command receives only the matching Manager import authority from its generated Compose', async () => {
  const f = await fixture();
  const commands: string[][] = [];
  try {
    // Stale live-app authority must never be carried into this operation's dedicated CLI.
    const file = join(f.operations.directory(), 'compose.json');
    const runtime = JSON.parse(await readFile(file, 'utf8'));
    runtime.services['frameleaf-server'].environment = {
      FRAMELEAF_MANAGER_ORIGIN: 'restored_library',
      FRAMELEAF_MANAGER_INSTALLATION: 'cccccccccccc',
      FRAMELEAF_IMPORT_MANAGER_OPERATION_ID: 'stale-operation',
    };
    await writeFile(file, JSON.stringify(runtime));
    await f.internal.configureImport(f.operation, { source: f.source }, f.installation);
    const docker = new Docker(async (binary, args, options) => {
      assert.equal(binary, 'docker');
      commands.push(args);
      if (!args.includes('run')) return '';
      const directory = options!.cwd!;
      const path = join(directory, args[args.indexOf('--file') + 1]);
      assert.equal(directory, f.operations.directory());
      assert.equal(path, join(directory, 'import-compose.json'));
      const generated = JSON.parse(await readFile(path, 'utf8'));
      const config = JSON.parse(await readFile(join(directory, 'import.json'), 'utf8'));
      const environment = generated.services['frameleaf-server'].environment;
      assert.equal(config.media.mode, 'manager-in-place');
      assert.equal(config.media.authority, 'frameleaf-manager');
      assert.match(config.media.deploymentId, /^[a-f0-9]{12}$/);
      assert.equal(environment.FRAMELEAF_MANAGER_ORIGIN, 'new_import');
      assert.equal(environment.FRAMELEAF_MANAGER_INSTALLATION, config.media.deploymentId);
      assert.equal(environment.FRAMELEAF_IMPORT_MANAGER_OPERATION_ID, config.media.operationId);
      assert.equal(config.media.deploymentId, f.installation.id);
      assert.equal(config.media.operationId, f.operation.id);
      assert.equal(args.includes('-e'), false); // No command override can replace the reviewed authority.
      return '{"status":"activated"}';
    });
    assert.deepEqual(
      await docker.importCommand(f.operations.directory(), f.installation.project, f.operation.id, 'verify'),
      { status: 'activated' },
    );
    const command = commands.find((args) => args.includes('run'))!;
    assert.ok(command);
    assert.deepEqual(command.slice(-6), [
      'dist/main.js', 'frameleaf-admin', 'import-immich', 'verify', '--config', '/run/frameleaf/import.json',
    ]);
  } finally {
    await f.cleanup();
  }
});

test('offline import refuses mismatched installation, source or operation authority before any grants', async () => {
  const f = await fixture();
  try {
    for (const [operation, source, installation] of [
      [f.operation, f.source, { ...f.installation, origin: 'restored_library' }],
      [f.operation, f.source, { ...f.installation, id: 'invalid' }],
      [f.operation, { ...f.source, id: 'different-reviewed-source' }, f.installation],
      [{ ...f.operation, kind: 'update' }, f.source, f.installation],
    ] as const) {
      await assert.rejects(
        f.internal.configureImport(operation as Operation, { source: source as Source }, installation as Installation),
        /invalid_import_authority/,
      );
    }
    assert.equal(f.events.length, 0);
    assert.equal(f.store.get(`import-reader:${f.operation.id}`) === null, true);
  } finally {
    await f.cleanup();
  }
});

test('repeated import configuration refreshes both database IPs without changing logical config or reader identity', async () => {
  const f = await fixture();
  try {
    await f.internal.configureImport(f.operation, { source: f.source }, f.installation);
    const config = await readFile(join(f.operations.directory(), 'import.json'), 'utf8');
    const reader = f.store.get<{ name: string }>(`import-reader:${f.operation.id}`)!;
    f.upstream.NetworkSettings.Networks['source-$tenant'].IPAddress = '172.19.0.17';
    f.destination.NetworkSettings.Networks[`${f.installation.project}_default`].IPAddress = '172.20.0.18';
    await f.internal.configureImport(f.operation, { source: f.source }, f.installation);
    const grants = f.events.filter((event) => event.includes('GRANT SELECT ON ALL TABLES'));
    assert.equal(grants.length, 2);
    for (const grant of grants) {
      // Replayed setup also upgrades a reader created with NOINHERIT by an earlier Manager.
      // This spelling works on PG14 as well as newer role-membership implementations.
      const inherit = grant.indexOf(`ALTER ROLE "${reader.name}" INHERIT;`);
      const statistics = grant.indexOf(`GRANT pg_read_all_stats TO "${reader.name}";`);
      assert.ok(inherit >= 0 && statistics > inherit);
      assert.ok(grant.includes('NOSUPERUSER NOBYPASSRLS NOINHERIT'));
      assert.equal(grant.includes('pg_monitor'), false);
      assert.equal(grant.includes('WITH INHERIT'), false);
    }
    assert.equal(await readFile(join(f.operations.directory(), 'import.json'), 'utf8'), config);
    assert.deepEqual(f.store.get(`import-reader:${f.operation.id}`), reader);
    const compose = JSON.parse(await readFile(join(f.operations.directory(), 'import-compose.json'), 'utf8'));
    const app = compose.services['frameleaf-server'];
    assert.equal(new URL(app.environment.DB_URL).hostname, '172.20.0.18');
    assert.equal(new URL(app.environment.FRAMELEAF_IMPORT_SOURCE_URL).hostname, '172.19.0.17');
    assert.equal(
      app.volumes.filter((mount: { target: string }) => mount.target === '/run/frameleaf/import.json').length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test('a surviving importer is refused before creating reader credentials or issuing source grants', async () => {
  const f = await fixture();
  try {
    f.inventory.push({
      State: { Running: true },
      Config: { Labels: { 'app.frameleaf.manager.import': f.operation.id } },
    } as Container);
    await assert.rejects(
      f.internal.configureImport(f.operation, { source: f.source }, f.installation),
      /import_still_running/,
    );
    assert.deepEqual(f.events, []);
    assert.equal(f.store.get(`import-reader:${f.operation.id}`), null);
  } finally {
    await f.cleanup();
  }
});

for (const revokeFails of [false, true]) {
  test(`source cancellation revokes import login before recovery (revocation failure=${revokeFails})`, async () => {
    const f = await fixture();
    try {
      f.store.set(`import-reader:${f.operation.id}`, { name: 'frameleaf_import_fixture' });
      f.operation.receipts['cancellation-intent'] = {
        kind: 'source',
        installation: f.installation,
        archive: join(f.root, 'cancelled-stack'),
      };
      f.internal.fencing = {
        recover: async () => {
          f.events.push('recover-source');
        },
      };
      f.docker.sql = async (_database, sql) => {
        f.events.push(sql);
        if (revokeFails) throw new Error('fixture revoke failure');
        return '';
      };
      if (revokeFails) {
        await assert.rejects(f.internal.cancelOperation(f.operation), /fixture revoke failure/);
        assert.equal(f.events.includes('recover-source'), false);
        assert.equal(f.operation.completed.includes('cancel-import-reader'), false);
      } else {
        await f.internal.cancelOperation(f.operation);
        assert.ok(f.events.findIndex((event) => event.includes('NOLOGIN')) < f.events.indexOf('recover-source'));
        assert.equal(f.store.get('installation'), null);
      }
      assert.ok(f.events.some((event) => event.includes('ALTER ROLE "frameleaf_import_fixture" NOLOGIN')));
    } finally {
      await f.cleanup();
    }
  });
}

test('resumed cutover captures fenced settings and applies the reviewed ML choice before starting Frameleaf', async () => {
  const f = await fixture();
  try {
    f.source.settingsAuthority = 'database';
    f.store.set('application-config', {
      environment: {},
      settings: { machineLearning: { enabled: true } },
      authority: 'database',
    });
    f.store.set(`import-reader:${f.operation.id}`, { name: 'frameleaf_import_fixture' });
    const releaseDirectory = join(f.root, 'release');
    await mkdir(releaseDirectory);
    await writeFile(
      join(releaseDirectory, 'docker-compose.yml'),
      JSON.stringify({
        services: { database: {}, 'frameleaf-server': {}, 'immich-machine-learning': {} },
      }),
    );
    const liveSettings = {
      machineLearning: { enabled: true, urls: ['http://old-source:3003'] },
      image: { quality: 71 },
    };
    let targetSettings: Record<string, unknown> | undefined;
    f.docker.sql = async (_database, sql) => {
      if (sql.includes('SELECT coalesce')) {
        f.events.push('capture-settings');
        return JSON.stringify(liveSettings);
      }
      if (sql.includes('INSERT INTO public.system_metadata')) {
        f.events.push('apply-settings');
        const json = sql.match(/VALUES \('system-config','(.*)'::jsonb\)/s)?.[1];
        assert.ok(json);
        targetSettings = JSON.parse(json.replaceAll("''", "'"));
      }
      if (sql.includes('NOLOGIN')) f.events.push('revoke-reader');
      return '';
    };
    f.docker.compose = async () => {
      f.events.push('start-frameleaf');
      assert.deepEqual(targetSettings, {
        ...liveSettings,
        machineLearning: { enabled: false, urls: ['http://immich-machine-learning:3003'] },
      });
    };
    const internal = f.operations as unknown as {
      install(operation: Operation, review: unknown): Promise<void>;
      fencing: { verify(): Promise<void>; assertMedia(): Promise<void> };
      releases: { eligible(): Promise<void> };
    };
    internal.fencing = {
      verify: async () => {
        f.events.push('verify-fence');
      },
      assertMedia: async () => {
        f.events.push('assert-media');
      },
    };
    internal.releases = { eligible: async () => {} };
    // Resume from completed data import while running the real settings/cutover steps and Store receipts.
    f.operation.completed = [
      'preflight',
      'download-images',
      'configure',
      'review-source',
      'fence-source',
      'start-database',
      'copy-current-database',
      'database-backup',
      'configure-offline-import',
      'import-canonical-database',
      'verify-import',
      'prepare-library',
    ];
    f.operation.receipts.configure = f.installation;
    const image = `ghcr.io/frameleaf/fixture@sha256:${'a'.repeat(64)}`;
    await internal.install(f.operation, {
      input: { tag: 'v1.0.0' },
      source: f.source,
      backup: null,
      release: {
        directory: releaseDirectory,
        nas: { images: { server: image, machineLearning: image, postgres: image } },
      },
    });
    assert.ok(f.events.indexOf('verify-fence') < f.events.indexOf('capture-settings'));
    assert.ok(f.events.indexOf('capture-settings') < f.events.indexOf('apply-settings'));
    assert.ok(f.events.indexOf('apply-settings') < f.events.indexOf('start-frameleaf'));
    assert.ok(f.events.indexOf('revoke-reader') < f.events.indexOf('start-frameleaf'));
    assert.deepEqual(f.operation.receipts['capture-fenced-settings'], {
      environment: {},
      settings: liveSettings,
      authority: 'database',
    });
    assert.equal(f.store.get<Installation>('installation')?.mayHaveWrittenMedia, true);
  } finally {
    await f.cleanup();
  }
});
