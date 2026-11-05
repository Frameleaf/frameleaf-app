import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operations, type CommonImportReview } from '../src/operations.js';
import { identifyPhotoprismSqliteSource } from '../src/photoprism-source.js';
import { Store } from '../src/store.js';
import { Docker, SERVER_ADMIN, type Container } from '../src/docker.js';
import { digest, type Installation, type Source, type Operation } from '../src/contracts.js';
import type { Releases } from '../src/releases.js';
import type { Backups } from '../src/backups.js';
import type { PostgresStorage } from '../src/postgres-storage.js';

// Exercise real orchestration and file publication with Docker/role execution mocked.
// These tests do not qualify a live Docker network, PostgreSQL grants, or source fencing.
async function fixture(base = tmpdir()) {
  const root = await mkdtemp(join(base, 'manager-import-authority-'));
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
    fencing: { recover(): Promise<void>; retiredServices(): null };
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
      SERVER_ADMIN, 'frameleaf-server', 'import-immich', 'verify', '--config', '/run/frameleaf/import.json',
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
        retiredServices: () => null,
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
        services: { database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {} },
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
        machineLearning: { enabled: false, urls: ['http://frameleaf-machine-learning:3003'] },
      });
    };
    const internal = f.operations as unknown as {
      install(operation: Operation, review: unknown): Promise<void>;
      fencing: { verify(): Promise<void>; assertMedia(): Promise<void>; retireSourceServices(): Promise<unknown[]> };
      releases: { eligible(): Promise<void> };
    };
    internal.fencing = {
      verify: async () => {
        f.events.push('verify-fence');
      },
      assertMedia: async () => {
        f.events.push('assert-media');
      },
      retireSourceServices: async () => {
        f.events.push('retire-source-services');
        return [];
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
      'check-media-writable',
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
    // FL-476: the source database retires only after its last use (the reader revocation), before Frameleaf starts.
    assert.ok(f.events.indexOf('revoke-reader') < f.events.indexOf('retire-source-services'));
    assert.ok(f.events.indexOf('retire-source-services') < f.events.indexOf('start-frameleaf'));
    assert.deepEqual(f.operation.receipts['capture-fenced-settings'], {
      environment: {},
      settings: liveSettings,
      authority: 'database',
      services: {},
    });
    assert.equal(f.store.get<Installation>('installation')?.mayHaveWrittenMedia, true);
  } finally {
    await f.cleanup();
  }
});

test('the media check asks the server image, with its own mounts and user, which folders it cannot write (FL-414)', async () => {
  const commands: string[][] = [];
  const docker = new Docker(async (binary, args, options) => {
    assert.equal(binary, 'docker');
    assert.equal(options?.cwd, '/fixture/manager');
    commands.push(args);
    return '/data/library\nnoise from the entrypoint\n';
  });
  assert.deepEqual(
    await docker.unwritableMedia('/fixture/manager', `frameleaf-${'a'.repeat(12)}`, ['/data', '/data/library']),
    ['/data/library'],
  );
  const [command] = commands;
  assert.deepEqual(command.slice(0, 12), [
    'compose', '--project-name', `frameleaf-${'a'.repeat(12)}`, '--file', 'compose.json', 'run', '--rm',
    '--no-deps', '-T', '--entrypoint', 'sh', 'frameleaf-server',
  ]);
  assert.deepEqual(command.slice(-3), ['sh', '/data', '/data/library']);
  await assert.rejects(docker.unwritableMedia('/fixture/manager', 'not-a-project', ['/data']), /invalid_media_check/);
  await assert.rejects(
    docker.unwritableMedia('/fixture/manager', `frameleaf-${'a'.repeat(12)}`, ['relative']),
    /invalid_media_check/,
  );
  assert.deepEqual(await docker.unwritableMedia('/fixture/manager', `frameleaf-${'a'.repeat(12)}`, []), []);
});

test('an in-place import stops before any grant or import when a media folder is not writable (FL-414)', async () => {
  const f = await fixture();
  try {
    const checked: string[][] = [];
    (f.docker as unknown as { unwritableMedia: (d: string, p: string, t: string[]) => Promise<string[]> }).unwritableMedia =
      async (_directory, _project, targets) => {
        checked.push(targets);
        return ['/data/library'];
      };
    const internal = f.operations as unknown as {
      install(operation: Operation, review: unknown): Promise<void>;
      fencing: { verify(): Promise<void>; assertMedia(): Promise<void> };
    };
    internal.fencing = { verify: async () => {}, assertMedia: async () => {} };
    f.operation.completed = [
      'preflight',
      'download-images',
      'configure',
      'review-source',
      'fence-source',
      'start-database',
      'capture-fenced-settings',
      'copy-current-database',
      'database-backup',
    ];
    f.operation.receipts.configure = f.installation;
    await assert.rejects(
      internal.install(f.operation, { input: { tag: 'v1.0.0' }, source: f.source, backup: { verified: true } }),
      (error: Error & { code?: string; detail?: string }) =>
        error.code === 'media_folder_not_writable' && !!error.detail?.includes('/data/library'),
    );
    assert.deepEqual(checked, [['/data', '/data/library']]);
    // nothing was granted on the source and no import ran
    assert.deepEqual(f.events, []);
    assert.equal(f.operation.completed.includes('configure-offline-import'), false);
  } finally {
    await f.cleanup();
  }
});

test('common setup persists preflight and the writer boundary before activation', async (t) => {
  const { store, operations, docker, installation, source, operation, root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const common = {
    fence: { ...source, containers: [] },
    destinationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    requiredMediaBytes: 128,
    summary: { owners: 1, assets: 1, files: 1, albums: 0, preservationDifferences: 0 },
    binding: {
      operationId: operation.id,
      manifestSha256: 'a'.repeat(64),
      planSha256: 'b'.repeat(64),
      source: { kind: 'photoprism', version: 'fixture', identity: 'source', revision: 'frozen', schemaSha256: 'c'.repeat(64) },
    },
    media: [{ source: installation.mounts[0].source, target: '/data', readOnly: false }],
  };
  const calls: string[] = [];
  const internal = operations as any;
  internal.fencing.verify = async () => { calls.push('fence'); };
  let reportedBytes = 64;
  docker.completeReviewedImport = async (_directory, _project, authority, _media, preflight, beforeActivation) => {
    assert.equal(authority.binding.operationId, operation.id);
    await authority.verify();
    await preflight(async () => {
      calls.push('preflight');
      return { summary: common.summary, requiredMediaBytes: reportedBytes };
    });
    assert(operation.completed.includes('preflight-common-import'));
    await beforeActivation();
    assert.equal(store.get<Installation>('installation')?.mayHaveWrittenMedia, true);
    calls.push('activate');
  };
  await assert.rejects(
    internal.runCommonImport(operation, { ...common, binding: { ...common.binding, operationId: 'different' } }, installation),
    /invalid_import_authority/,
  );
  assert.deepEqual(calls, []);
  await assert.rejects(internal.runCommonImport(operation, common, installation), /import_common_review_changed/);
  assert.deepEqual(calls, ['fence', 'preflight']);
  assert(!operation.completed.includes('preflight-common-import'));
  calls.length = 0;
  reportedBytes = common.requiredMediaBytes;
  await internal.runCommonImport(operation, common, installation);
  assert.deepEqual(calls, ['fence', 'preflight', 'activate']);
  assert(operation.completed.includes('import-canonical-database'));
});

test('common cancellation restores the source only after rollback is durably reported', async (t) => {
  for (const succeeds of [false, true]) {
    const f = await fixture();
    t.after(f.cleanup);
    const source = { kind: 'photoprism', version: 'fixture' } as const;
    f.operation.input.reviewId = 'common-review';
    f.operation.completed.push('preflight-common-import');
    f.operation.receipts['cancellation-intent'] = {
      kind: 'source',
      installation: f.installation,
      archive: join(f.root, 'cancelled-stack'),
    };
    const common = {
      fence: { ...f.source, containers: [] },
      destinationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      binding: { operationId: f.operation.id, source },
      media: [],
    };
    f.operation.receipts['reviewed-common-import'] = digest(common);
    f.store.set('review:common-review', { common });
    const internal = f.internal as typeof f.internal & { fencing: { verify(): Promise<void> } };
    internal.fencing.verify = async () => {};
    internal.fencing.recover = async () => { f.events.push('recover-source'); };
    let status = 'copying';
    f.docker.importCommand = async (_directory, _project, _operation, action) => {
      f.events.push(action);
      if (action === 'rollback' && succeeds) status = 'abandoned';
      return {
        run: { operationId: f.operation.id, source, status },
        execution: { phase: status, abandoned: status === 'abandoned', writersMayHaveStarted: false },
      };
    };
    if (succeeds) {
      await f.internal.cancelOperation(f.operation);
      assert.deepEqual(f.events.slice(0, 3), ['status', 'rollback', 'status']);
      assert.ok(f.events.indexOf('recover-source') > 2);
    } else {
      await assert.rejects(f.internal.cancelOperation(f.operation), /import_common_status_unexpected/);
      assert.deepEqual(f.events, ['status', 'rollback', 'status']);
    }
  }
});

test('library setup requests ignore the common offline import container', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const server = {
    Id: 'server',
    State: { Running: true },
    Config: { Labels: {
      'app.frameleaf.manager': f.installation.id,
      'com.docker.compose.service': 'frameleaf-server',
    } },
  } as Container;
  f.inventory.push({
    ...server,
    Id: 'offline',
    State: { Running: false },
    Config: { Labels: { ...server.Config.Labels, 'app.frameleaf.manager.import': f.operation.id } } as Container['Config'],
  }, server);
  f.docker.node = async (id) => {
    assert.equal(id, server.Id);
    return '{"value":{"status":"ready"}}';
  };
  assert.deepEqual(await f.operations.libraryStatus(), { status: 'ready' });
});

test('starts a common import with its reviewed operation ID and keeps request retries idempotent', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.operation.state = 'complete';
  f.store.save(f.operation);
  const internal = f.operations as unknown as { launch(operation: Operation): void };
  const launched: string[] = [];
  internal.launch = (operation) => { launched.push(operation.id); };
  const reviewId = randomUUID();
  const review = {
    id: reviewId,
    expires: Date.now() + 60_000,
    input: { kind: 'import' },
    source: null,
    common: { binding: { operationId: randomUUID() } },
  };
  f.store.set(`review:${reviewId}`, review);
  assert.throws(() => f.operations.start(reviewId, 'common-request'), /invalid_import_authority/);
  assert.deepEqual(launched, []);
  review.common.binding.operationId = reviewId;
  f.store.set(`review:${reviewId}`, review);
  const operation = f.operations.start(reviewId, 'common-request');
  assert.equal(operation.id, reviewId);
  assert.equal(operation.receipts['reviewed-common-import'], digest(review.common));
  assert.equal(f.operations.start(reviewId, 'common-request').id, reviewId);
  const install = f.operations as unknown as { install(operation: Operation, review: unknown): Promise<void> };
  await assert.rejects(
    install.install(operation, { ...review, common: { ...review.common, bundleName: 'changed' } }),
    /invalid_import_authority/,
  );
  assert.throws(() => f.operations.start(reviewId, 'another-request'), /operation_in_progress/);
  assert.deepEqual(launched, [reviewId]);
});

test('journals credential staging without retaining the administrator password in operation state', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const root = join(f.operations.directory(), `import-runtime-${f.operation.id}`);
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, 'bundle'), { mode: 0o700 });
  const common = {
    fence: { ...f.source, containers: [] },
    destinationId: randomUUID(),
    bootstrapAdminId: randomUUID(),
    binding: { operationId: f.operation.id },
  };
  f.operation.receipts['reviewed-common-import'] = digest(common);
  f.operation.completed.push('preflight');
  const credentials = { email: 'fixture-admin@example.test', name: 'Fixture administrator', password: 'fixture-secret' };
  const internal = f.operations as unknown as {
    install(operation: Operation, review: unknown, credentials?: unknown): Promise<void>;
  };
  await assert.rejects(
    internal.install(f.operation, { source: null, common, release: { directory: '/fixture' }, input: { tag: 'fixture' } }, credentials),
    /releases.verify is not a function/,
  );
  assert(f.operation.completed.includes('stage-bootstrap-admin'));
  assert(!JSON.stringify(f.store.history()).includes(credentials.password));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'config', 'bootstrap-admin.json'), 'utf8')), {
    operationId: f.operation.id,
    destinationId: common.destinationId,
    userId: common.bootstrapAdminId,
    ...credentials,
  });
  // FL-1242: a run that stops removes the staged password; resuming asks the administrator for it again.
  await rm(join(root, 'config', 'bootstrap-admin.json'));
  const review = { source: null, common, release: { directory: '/fixture' }, input: { tag: 'fixture' } };
  await assert.rejects(internal.install(f.operation, review), /import_bootstrap_credentials_required/);
  await assert.rejects(internal.install(f.operation, review, credentials), /releases.verify is not a function/);
  assert(await readFile(join(root, 'config', 'bootstrap-admin.json'), 'utf8'));
});

test('common review reports the source and space without exposing the private bundle binding', async (t) => {
  const f = await fixture(await realpath(tmpdir()));
  t.after(f.cleanup);
  f.inventory.length = 0;
  f.store.set('installation', null);
  const mediaPath = join(f.root, 'destination');
  await mkdir(mediaPath);
  const internal = f.operations as unknown as {
    roots: string[];
    fencing: { verify(): Promise<void> };
    databaseStorage: { validate(): Promise<{ root: string }> };
  };
  internal.roots = [f.root];
  let fenceChecks = 0;
  internal.fencing.verify = async () => { fenceChecks++; };
  internal.databaseStorage.validate = async () => ({ root: f.root });
  f.docker.compatibility = async () => ({ platform: 'linux/arm64' }) as Awaited<ReturnType<Docker['compatibility']>>;
  const image = `ghcr.io/frameleaf/frameleaf-server@sha256:${'a'.repeat(64)}`;
  f.operations.releases.acquire = async () => ({
    nas: { platforms: ['linux/arm64'], images: { server: image } },
  }) as Awaited<ReturnType<Releases['acquire']>>;
  f.operation.state = 'complete';
  f.store.save(f.operation);
  const { operation } = f.store.start('import', 'capture-review', {
    sourceId: f.source.id, commonCapture: f.source.id,
  });
  const common: CommonImportReview = {
    fence: { ...f.source, workers: [], containers: [], mounts: [] },
    destinationId: randomUUID(),
    bundleName: 'private-fixture-bundle',
    bootstrapAdminId: randomUUID(),
    requiredMediaBytes: 42,
    summary: { owners: 1, assets: 2, files: 2, albums: 1, preservationDifferences: 3 },
    binding: {
      operationId: operation.id,
      manifestSha256: 'a'.repeat(64),
      planSha256: 'b'.repeat(64),
      source: { kind: 'photoprism', version: 'fixture', identity: 'private-source', revision: 'frozen', schemaSha256: 'c'.repeat(64) },
    },
    media: [{ source: mediaPath, target: '/data', readOnly: false }],
  };
  const input = {
    kind: 'import', sourceId: f.source.id, mediaPath, databaseRoot: f.root,
    tag: 'frameleaf-v1.0.0', port: 2283, ml: false, lifecycle: 'docker-only',
  } as const;
  const { fence, media, bootstrapAdminId, ...receipt } = common;
  const request = {
    operationId: common.binding.operationId,
    destinationId: common.destinationId,
    observed: { source: common.binding.source },
    snapshotPath: '/run/frameleaf/import-preparation/capture/snapshot.sqlite',
  };
  const root = join(f.operations.directory(), `import-runtime-${request.operationId}`);
  await mkdir(root, { mode: 0o700 });
  operation.state = 'awaiting-review';
  operation.receipts['capture-common-source'] = {
    fence, source: common.binding.source, originalsPath: f.root, snapshotPath: join(root, 'capture/snapshot.sqlite'),
  };
  f.store.save(operation);
  for (const changed of [
    { operationId: randomUUID() },
    { snapshotPath: '/run/frameleaf/import-preparation/substitute.sqlite' },
    { observed: { source: { ...common.binding.source, revision: 'substitute' } } },
  ]) {
    await assert.rejects(
      f.operations.prepareCommonReview(input, { fence, media, bootstrapAdminId, request: { ...request, ...changed } }),
      /invalid_import_authority/,
    );
  }
  f.docker.pull = async (candidate) => { assert.equal(candidate, image); };
  f.docker.prepareImportBundle = async (directory, candidate, authority, reviewedMedia) => {
    assert.equal(directory, f.operations.directory());
    assert.equal(candidate, image);
    assert.deepEqual(reviewedMedia, media);
    const staged = await readFile(join(root, 'prepare.json'));
    assert.deepEqual(JSON.parse(staged.toString('utf8')), request);
    assert.equal(authority.preparationSha256, createHash('sha256').update(staged).digest('hex'));
    await authority.verify();
    return receipt as Awaited<ReturnType<Docker['prepareImportBundle']>>;
  };
  await assert.rejects(
    f.operations.prepareCommonReview(input, {
      fence, media: [...media, { source: f.root, target: '/import-media/foreign', readOnly: true }],
      bootstrapAdminId, request,
    }),
    /import_runtime_media_invalid/,
  );
  assert.equal(fenceChecks, 0);
  const prepared = { fence, media, bootstrapAdminId, request };
  const prepareBundle = f.docker.prepareImportBundle;
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.docker.prepareImportBundle = async () => {
    entered.resolve();
    await finish.promise;
    throw new Error('interrupted preparation');
  };
  const preparing = f.operations.prepareCommonReview(input, prepared);
  await entered.promise;
  await assert.rejects(f.operations.prepareCommonReview(input, prepared), /invalid_import_authority/);
  await assert.rejects(f.operations.recover(operation.id), /operation_not_recoverable/);
  finish.resolve();
  await assert.rejects(preparing, /interrupted preparation/);
  f.docker.prepareImportBundle = prepareBundle;
  fenceChecks = 0;
  const review = await f.operations.prepareCommonReview(input, prepared);
  assert.equal(fenceChecks, 3);
  assert.equal(review.id, common.binding.operationId);
  assert.equal(review.backup, null);
  assert.deepEqual(review.commonImport, {
    source: 'photoprism', version: 'fixture', requiresBootstrap: true, requiredMediaBytes: 42, summary: common.summary,
  });
  const publicReview = JSON.stringify(review);
  for (const value of [common.bundleName, common.destinationId, common.bootstrapAdminId, common.binding.source.identity]) {
    assert(value && !publicReview.includes(value));
  }
  assert.deepEqual(f.store.get<{ common: CommonImportReview }>(`review:${review.id}`)?.common, common);
  const lowSpaceId = randomUUID();
  await assert.rejects(f.operations.review(input, undefined, {
    ...common,
    binding: { ...common.binding, operationId: lowSpaceId },
    requiredMediaBytes: Number.MAX_SAFE_INTEGER,
  }), /insufficient_disk_space/);
  assert.equal(f.store.get(`review:${lowSpaceId}`), null);
  await assert.rejects(f.operations.review(input, undefined, common), /invalid_import_authority/);
  const repeated = await f.operations.prepareCommonReview(input, prepared);
  assert.equal(repeated.id, review.id);
  assert.ok(review.approvalToken && repeated.approvalToken);
  assert.notEqual(repeated.approvalToken, review.approvalToken);
  assert.throws(
    () => f.operations.start(review.id, 'stale-review', undefined, review.approvalToken),
    /invalid_import_authority/,
  );
});

test('cancels a fenced capture before the destination is configured', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.store.set('installation', null);
  const fence = { ...f.source, containers: [] };
  f.operation.receipts['common-source-fence'] = fence;
  f.operation.receipts['cancellation-intent'] = {
    kind: 'source',
    installation: null,
    archive: join(f.root, 'cancelled-stack'),
  };
  let recovered = false;
  const internal = f.operations as unknown as {
    fencing: { recover(source: unknown, installation: unknown): Promise<void> };
    cancelOperation(operation: Operation): Promise<void>;
  };
  internal.fencing.recover = async (source, installation) => {
    assert.deepEqual(source, fence);
    assert.equal(installation, null);
    recovered = true;
  };
  await internal.cancelOperation(f.operation);
  assert(recovered);
  assert(f.operation.completed.includes('cancel-source'));
});

test('capture reserves the Manager operation until the reviewed import is approved or cancelled', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.operation.state = 'complete';
  f.store.save(f.operation);
  f.store.set('installation', null);
  const id = 'a'.repeat(64);
  const sourceFixture = JSON.parse(await readFile(new URL('../../server/src/library-import/fixtures/photoprism/261029-sqlite.json', import.meta.url), 'utf8'));
  f.docker.inspect = async () => ({
    Id: id,
    Config: { Image: sourceFixture.source.runtimeImage, Env: ['PHOTOPRISM_DATABASE_DRIVER=sqlite', 'PHOTOPRISM_DATABASE_DSN=/photoprism/storage/index.db'] },
    HostConfig: { RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } },
    Mounts: [
      { Type: 'bind', Source: '/fixture/source-storage', Destination: '/photoprism/storage', RW: true },
      { Type: 'bind', Source: '/fixture/source-originals', Destination: '/photoprism/originals', RW: true },
    ],
    NetworkSettings: { Networks: {} },
  }) as Container;
  const detected = identifyPhotoprismSqliteSource(await f.docker.inspect(id), 'docker')!;
  const source = { kind: 'photoprism', identity: id, version: 'fixture', revision: 'fixture', schemaSha256: 'a'.repeat(64) };
  const internal = f.operations as unknown as {
    captureCommonSource(operation: Operation): Promise<void>;
    install(operation: Operation): Promise<void>;
  };
  let calls = 0;
  internal.captureCommonSource = async (operation) => {
    calls++;
    assert.equal(f.store.history().find(({ id }) => id === operation.id)?.state, 'running');
    assert.throws(() => f.store.start('install', 'second-installation', {}), /operation_in_progress/);
    operation.receipts['capture-common-source'] = { fence: detected.fence, source };
  };
  const operation = await f.operations.startCommonCapture(id, 'capture-request', 'docker');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.store.history().find(({ id }) => id === operation.id)?.state, 'awaiting-review');
  assert.equal((await f.operations.startCommonCapture(id, 'capture-request', 'docker')).id, operation.id);
  assert.equal(calls, 1);
  let installCalls = 0;
  internal.install = async (approved) => {
    assert.equal(approved.id, operation.id);
    assert.equal(approved.state, 'running');
    installCalls++;
  };
  const review = {
    id: operation.id,
    approvalToken: randomUUID(),
    expires: Date.now() + 60_000,
    input: { kind: 'import' },
    source: null,
    common: { fence: detected.fence, binding: { operationId: operation.id, source: { ...source, revision: 'substituted' } } },
  };
  f.store.set(`review:${operation.id}`, review);
  assert.throws(() => f.operations.start(operation.id, 'approval-request', undefined, review.approvalToken), /invalid_import_authority/);
  review.common.binding.source = source;
  f.store.set(`review:${operation.id}`, review);
  assert.throws(() => f.operations.start(operation.id, 'approval-request', undefined, randomUUID()), /invalid_import_authority/);
  assert.equal(f.operations.start(operation.id, 'approval-request', undefined, review.approvalToken).id, operation.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.operations.start(operation.id, 'approval-request', undefined, review.approvalToken).id, operation.id);
  assert.throws(() => f.operations.start(operation.id, 'other-approval'), /request_key_reused/);
  assert.equal(installCalls, 1);
});
