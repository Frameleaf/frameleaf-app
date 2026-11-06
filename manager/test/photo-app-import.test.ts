import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { type Operation } from '../src/contracts.js';
import {
  Docker,
  sourceRestoreName,
  type CommandOptions,
  type Container,
  type ImportInspection,
} from '../src/docker.js';
import { encodeImportPreparationRequest, parseImportSourceAuthorityResponse } from '../src/import-source-authority.js';
import { Operations } from '../src/operations.js';
import type { PostgresStorage } from '../src/postgres-storage.js';
import type { Releases } from '../src/releases.js';
import type { Backups } from '../src/backups.js';
import { Store } from '../src/store.js';

const serverImage = `ghcr.io/frameleaf/frameleaf-server@sha256:${'a'.repeat(64)}`;
const source = {
  kind: 'photoprism' as const,
  version: '240915',
  identity: 'f'.repeat(64),
  revision: 'b'.repeat(64),
  schemaSha256: 'b'.repeat(64),
};

test('source database dump, disposable copy and reader keep passwords out of argv', async () => {
  const calls: { args: string[]; options: CommandOptions }[] = [];
  const operationId = randomUUID();
  const name = sourceRestoreName(operationId);
  const docker = new Docker(async (_binary, args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'exec' && args.includes('--version') && ['mariadb-dump', 'mariadb'].includes(args.at(-2)!))
      throw new Error('not in this image');
    if (args[0] === 'run') return `${'c'.repeat(64)}\n`;
    if (args[0] === 'ps') return `${'c'.repeat(64)}\n`;
    if (args[0] === 'inspect')
      return JSON.stringify([
        {
          Id: 'c'.repeat(64),
          Name: `/${name}`,
          Config: {
            Labels: { 'app.frameleaf.manager.import-source': operationId },
          },
        },
      ]);
    return '';
  });
  const login = {
    engine: 'mysql' as const,
    container: 'd'.repeat(64),
    name: 'photoprism',
    user: 'root',
    password: 'root-secret',
  };
  await docker.dumpSourceDatabase(login, '/private/stage/source.sql');
  const dump = calls.at(-1)!;
  assert.deepEqual(dump.args.slice(0, 5), ['exec', '--env', 'MYSQL_PWD', login.container, 'mysqldump']);
  for (const flag of ['--single-transaction', '--routines', '--triggers', '--events', '--databases'])
    assert(dump.args.includes(flag));
  assert.equal(dump.options.env?.MYSQL_PWD, 'root-secret');
  assert.equal(dump.options.outputFile, '/private/stage/source.sql');
  await assert.rejects(
    docker.dumpSourceDatabase({ ...login, name: 'x; DROP' }, '/private/x'),
    /invalid_source_database/,
  );

  const restore = {
    engine: 'mysql' as const,
    name,
    image: `sha256:${'e'.repeat(64)}`,
    database: 'photoprism',
    password: '1'.repeat(64),
  };
  assert.equal(await docker.startSourceRestore(restore, operationId), 'c'.repeat(64));
  const run = calls.at(-1)!;
  assert.deepEqual(run.args.slice(0, 7), ['run', '--detach', '--name', name, '--network', 'none', '--restart']);
  assert.equal(run.args.at(-1), restore.image);
  assert.equal(run.options.env?.MARIADB_ROOT_PASSWORD, restore.password);
  await assert.rejects(
    docker.startSourceRestore({ ...restore, name: 'frameleaf-import-source-other' }, operationId),
    /invalid_source_database/,
  );

  await docker.secureSourceRestore(restore, '2'.repeat(64));
  const statements = calls.filter((call) => call.options.input).map((call) => call.options.input!);
  assert.match(statements[0], /CREATE USER 'frameleaf_reader'@'%' IDENTIFIED BY '2{64}';/u);
  assert.match(
    statements[0],
    /GRANT SELECT, RELOAD, LOCK TABLES, TRIGGER, EVENT, SHOW VIEW ON \*\.\* TO 'frameleaf_reader'@'%';/u,
  );
  assert(statements.includes("GRANT SHOW CREATE ROUTINE ON *.* TO 'frameleaf_reader'@'%';"));
  assert(statements.includes('SET GLOBAL read_only=1;'));
  assert(statements.includes('SET GLOBAL super_read_only=1;'));
  for (const call of calls) assert(!call.args.some((arg) => /secret|1{64}|2{64}/u.test(arg)));

  await docker.removeSourceRestore(name);
  assert.deepEqual(calls.at(-1)!.args, ['rm', '--force', '--volumes', 'c'.repeat(64)]);
});

test('the preparation runner inspects and prepares inside the copy network namespace only', async () => {
  const operationId = randomUUID();
  const destinationId = randomUUID();
  const seal = {
    operationId,
    destinationId,
    source,
    preparationSha256: 'd'.repeat(64),
  };
  let checks = 0;
  const authority = { ...seal, verify: async () => void checks++ };
  const inspection: ImportInspection = {
    format: 'frameleaf-library-import-inspection',
    source,
    tested: false,
    testedVersion: '231128',
    summary: { owners: 1, assets: 2, albums: 1, files: 3, bytes: '4096' },
    owners: [
      {
        sourceId: 'u1',
        name: 'Admin',
        email: null,
        assets: 2,
        restrictions: [],
      },
    ],
    losses: [{ code: 'SOURCE_VERSION_UNTESTED', count: 1 }],
  };
  let returned: unknown = inspection;
  let network = '';
  const docker = new Docker(async (_binary, args, options) => {
    network = args[args.indexOf('--network') + 1];
    const nonce = randomUUID();
    parseImportSourceAuthorityResponse(
      (await options!.reply!(encodeImportPreparationRequest(seal, nonce).trimEnd()))!.trimEnd(),
      nonce,
    );
    return `progress\n${JSON.stringify(returned)}\n`;
  });
  const media = [{ source: '/srv/pp/originals', target: '/import-media/source' }];
  const restore = sourceRestoreName(operationId);
  assert.deepEqual(
    await docker.inspectImportSource('/private/manager', serverImage, authority, media, restore),
    inspection,
  );
  assert.equal(network, `container:${restore}`);
  assert.equal(checks, 3);
  await docker.inspectImportSource('/private/manager', serverImage, authority, media);
  assert.equal(network, 'none');
  returned = { ...inspection, source: { ...source, revision: 'c'.repeat(64) } };
  await assert.rejects(
    docker.inspectImportSource('/private/manager', serverImage, authority, media),
    /invalid_import_response/,
  );
  returned = { ...inspection, owners: [{ sourceId: 'u1' }] };
  await assert.rejects(
    docker.inspectImportSource('/private/manager', serverImage, authority, media),
    /invalid_import_response/,
  );
  await assert.rejects(
    docker.prepareImportBundle('/private/manager', serverImage, authority, media, sourceRestoreName(randomUUID())),
    /invalid_import_authority/,
  );
});

/** A Manager with a PhotoPrism + MariaDB source; Docker, fencing and releases are fakes, files are real. */
async function photoAppFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'manager-photo-app-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'manager'));
  t.after(() => store.close());
  for (const folder of ['pp/storage', 'pp/originals', 'destination', 'databases'])
    await mkdir(join(root, folder), { recursive: true });
  const app = {
    Id: 'a'.repeat(64),
    Name: '/photoprism',
    Image: `sha256:${'1'.repeat(64)}`,
    State: { Running: true },
    Config: {
      Image: 'photoprism/photoprism:240915',
      Env: [
        'PHOTOPRISM_DATABASE_DRIVER=mysql',
        'PHOTOPRISM_DATABASE_SERVER=mariadb:3306',
        'PHOTOPRISM_DATABASE_NAME=photoprism',
        'PHOTOPRISM_DATABASE_PASSWORD=app-secret',
      ],
      Labels: { 'com.docker.compose.project': 'pp' },
      Entrypoint: null,
      Cmd: null,
    },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      NetworkMode: 'pp_default',
      PortBindings: {},
    },
    Mounts: [
      {
        Type: 'bind',
        Source: join(root, 'pp/storage'),
        Destination: '/photoprism/storage',
        RW: true,
      },
      {
        Type: 'bind',
        Source: join(root, 'pp/originals'),
        Destination: '/photoprism/originals',
        RW: true,
      },
    ],
    NetworkSettings: {
      Networks: {
        pp_default: { IPAddress: '172.30.0.2', DNSNames: ['photoprism'] },
      },
    },
  } as Container;
  const db = {
    ...app,
    Id: 'd'.repeat(64),
    Name: '/mariadb',
    Image: `sha256:${'e'.repeat(64)}`,
    Config: {
      ...app.Config,
      Image: 'mariadb:11',
      Env: ['MARIADB_ROOT_PASSWORD=root-secret'],
    },
    Mounts: [],
    NetworkSettings: {
      Networks: {
        pp_default: { IPAddress: '172.30.0.3', DNSNames: ['mariadb'] },
      },
    },
  } as Container;
  const events: string[] = [];
  const inventory = [app, db];
  let ready = 0;
  const docker = {
    inventory: async () => structuredClone(inventory),
    readFile: async () => {
      throw new Error('no such file');
    },
    compatibility: async () => ({ platform: 'linux/arm64' }),
    pull: async () => void events.push('pull'),
    start: async (id: string) => void events.push(`start:${id === app.Id ? 'app' : id}`),
    dumpSourceDatabase: async (login: { user: string; password: string }, file: string) => {
      events.push(`dump:${login.user}`);
      assert.equal(login.password, 'root-secret');
      await writeFile(file, 'CREATE TABLE photos (id int);');
    },
    removeSourceRestore: async (name: string) => void events.push(`remove:${name}`),
    startSourceRestore: async (restore: { image: string; password: string }, operationId: string) => {
      events.push('restore-start');
      assert.equal(restore.image, db.Image);
      assert.match(restore.password, /^[a-f0-9]{64}$/u);
      assert(operationId);
      return 'c'.repeat(64);
    },
    sourceRestoreReady: async () => {
      events.push('ready?');
      return ++ready > 1;
    },
    restoreSourceDatabase: async () => void events.push('restore-load'),
    secureSourceRestore: async (_restore: unknown, reader: string) => {
      events.push('restore-secure');
      assert.match(reader, /^[a-f0-9]{64}$/u);
    },
  } as unknown as Docker;
  const releases = {
    available: async () => [{ tag: 'frameleaf-v1.2.4' }],
    acquire: async () => ({
      nas: { platforms: ['linux/arm64'], images: { server: serverImage } },
    }),
  } as unknown as Releases;
  const operations = new Operations(store, docker, releases, {} as Backups, [root], {
    validate: async () => ({ root: join(root, 'databases') }),
  } as unknown as PostgresStorage);
  operations.restoreReadyDelayMs = 0;
  const internal = operations as unknown as {
    fencing: {
      stop(): Promise<void>;
      verify(): Promise<void>;
      recover(fence: unknown, installation: unknown): Promise<void>;
    };
  };
  internal.fencing.stop = async () => {
    events.push('fence-stop');
    inventory[0].State.Running = false;
  };
  internal.fencing.verify = async () => void events.push('fence-verify');
  internal.fencing.recover = async () => void events.push('fence-recover');
  const settle = async (id: string) => {
    for (let tries = 0; tries < 200; tries++) {
      const operation = store.history().find((o) => o.id === id)!;
      if (operation.state !== 'running') return operation;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('operation did not settle');
  };
  return {
    root,
    store,
    app,
    db,
    events,
    inventory,
    docker,
    operations,
    settle,
  };
}

test('a MariaDB source is dumped after its app stops, restored into a disposable copy and inspected through it', async (t) => {
  const f = await photoAppFixture(t);
  const started = await f.operations.startCommonCapture(f.app.Id, 'capture-key');
  assert.equal((await f.operations.startCommonCapture(f.app.Id, 'capture-key')).id, started.id);
  const operation = await f.settle(started.id);
  assert.equal(operation.state, 'awaiting-review', operation.error ?? '');
  const name = sourceRestoreName(operation.id);
  assert.deepEqual(f.events, [
    'fence-stop',
    'dump:root',
    'fence-verify',
    `remove:${name}`,
    'restore-start',
    'ready?',
    'ready?',
    'restore-load',
    'restore-secure',
    'fence-verify',
    'fence-verify',
  ]);
  const capture = operation.receipts['capture-common-source'] as Record<string, any>;
  assert.equal(operation.receipts['photo-app-restore'], name);
  assert.deepEqual(capture.restore, {
    name,
    container: 'c'.repeat(64),
    engine: 'mysql',
    database: 'photoprism',
  });
  assert.equal(capture.source.kind, 'photoprism');
  assert.equal(capture.source.version, '240915');
  assert.equal(capture.source.identity, f.app.Id);
  assert.equal(capture.source.revision, capture.source.schemaSha256);
  assert.equal(capture.sourceRootPath, '/photoprism/originals');
  const journal = JSON.stringify(f.store.history());
  assert(!/root-secret|app-secret/u.test(journal));
  const secrets = f.store.get<{ root: string; reader: string }>(`photo-app-restore:${operation.id}`)!;
  assert(!journal.includes(secrets.root) && !journal.includes(secrets.reader));
  assert.deepEqual(f.operations.history().find((o) => o.id === operation.id)?.photoApp, {
    kind: 'photoprism',
    name: 'PhotoPrism',
  });

  const inspection: ImportInspection = {
    format: 'frameleaf-library-import-inspection',
    source: capture.source,
    tested: false,
    testedVersion: '231128',
    summary: { owners: 2, assets: 3, albums: 1, files: 3, bytes: '300' },
    owners: [
      {
        sourceId: 'u1',
        name: 'Admin',
        email: 'admin@example.com',
        assets: 2,
        restrictions: [],
      },
      {
        sourceId: 'u2',
        name: 'Guest',
        email: null,
        assets: 1,
        restrictions: ['second_factor_required'],
      },
    ],
    losses: [
      { code: 'SOURCE_VERSION_UNTESTED', count: 1 },
      { code: 'PHOTOPRISM_LABELS', count: 3 },
    ],
  };
  let inspections = 0;
  const staging = join(f.operations.directory(), `import-runtime-${operation.id}`);
  f.docker.inspectImportSource = async (directory, image, authority, media, restore) => {
    inspections++;
    assert.equal(directory, f.operations.directory());
    assert.equal(image, serverImage);
    assert.equal(restore, name);
    assert.deepEqual(media, [{ source: join(f.root, 'pp/originals'), target: '/import-media/source' }]);
    const request = JSON.parse(await readFile(join(staging, 'prepare.json'), 'utf8'));
    assert.deepEqual(request, {
      format: 'frameleaf-prepare-library-import',
      version: 2,
      action: 'inspect',
      operationId: operation.id,
      destinationId: authority.destinationId,
      source: capture.source,
      databaseUrl: `mysql://frameleaf_reader:${secrets.reader}@127.0.0.1:3306/photoprism`,
      originalsRoot: '/import-media/source',
      sourceRootPath: '/photoprism/originals',
      approvedLossCodes: [],
      owners: [],
    });
    await authority.verify();
    return inspection;
  };
  assert.deepEqual(await f.operations.inspectPhotoApp(operation.id), inspection);
  assert.deepEqual(await f.operations.inspectPhotoApp(operation.id), inspection);
  assert.equal(inspections, 1);

  const review = {
    tag: 'frameleaf-v1.2.4' as const,
    databaseRoot: join(f.root, 'databases'),
    mediaPath: join(f.root, 'destination'),
    port: 2390,
    ml: false,
  };
  const owners = [
    { sourceId: 'u1', email: 'admin@example.com' },
    {
      sourceId: 'u2',
      email: 'guest@example.com',
      acknowledgeRestrictions: true,
    },
  ];
  const approvedLossCodes = ['PHOTOPRISM_LABELS', 'SOURCE_VERSION_UNTESTED'];
  await assert.rejects(
    f.operations.preparePhotoApp({
      operationId: operation.id,
      owners: owners.slice(0, 1),
      approvedLossCodes,
      review,
    }),
    /photo_app_owner_unmapped/,
  );
  await assert.rejects(
    f.operations.preparePhotoApp({
      operationId: operation.id,
      owners: [owners[0], { ...owners[1], email: 'ADMIN@example.com' }],
      approvedLossCodes,
      review,
    }),
    /photo_app_owner_email_duplicate/,
  );
  await assert.rejects(
    f.operations.preparePhotoApp({
      operationId: operation.id,
      owners,
      approvedLossCodes: approvedLossCodes.slice(1),
      review,
    }),
    /photo_app_loss_unapproved/,
  );
  let prepared: Record<string, any> | undefined;
  f.docker.prepareImportBundle = async (_directory, _image, authority, media, restore) => {
    assert.equal(restore, name);
    assert.deepEqual(media, [
      { source: review.mediaPath, target: '/data', readOnly: false },
      {
        source: join(f.root, 'pp/originals'),
        target: '/import-media/source',
        readOnly: true,
      },
    ]);
    prepared = JSON.parse(await readFile(join(staging, 'prepare.json'), 'utf8'));
    await authority.verify();
    return {
      bundleName: `bundle-${operation.id}-aBc123`,
      binding: {
        operationId: operation.id,
        source: capture.source,
        manifestSha256: 'a'.repeat(64),
        planSha256: 'b'.repeat(64),
      },
      destinationId: authority.destinationId,
      requiredMediaBytes: 300,
      summary: {
        owners: 2,
        assets: 3,
        files: 3,
        albums: 1,
        preservationDifferences: 0,
      },
    };
  };
  const result = await f.operations.preparePhotoApp({
    operationId: operation.id,
    owners,
    approvedLossCodes,
    review,
  });
  assert.equal(result.id, operation.id);
  assert(result.approvalToken);
  assert.deepEqual(result.commonImport, {
    source: 'photoprism',
    version: '240915',
    requiresBootstrap: false,
    requiredMediaBytes: 300,
    summary: {
      owners: 2,
      assets: 3,
      files: 3,
      albums: 1,
      preservationDifferences: 0,
    },
  });
  assert.equal(prepared?.action, 'prepare');
  assert.deepEqual(prepared?.approvedLossCodes, ['SOURCE_VERSION_UNTESTED', 'PHOTOPRISM_LABELS']);
  // Every owner's destination folder exists, private and empty, before the read-only review runs.
  for (const { destinationId } of prepared?.owners ?? []) {
    const folder = join(review.mediaPath, 'library', destinationId);
    assert.equal((await stat(folder)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(folder), []);
  }
  assert.equal((await readdir(join(review.mediaPath, 'library'))).length, 2);
  assert.deepEqual(
    prepared?.owners.map((o: { sourceId: string }) => o.sourceId),
    ['u1', 'u2'],
  );
  assert(prepared?.owners.every((o: { destinationId: string }) => /^[a-f0-9-]{36}$/u.test(o.destinationId)));
  assert.equal(prepared?.owners[1].acknowledgeRestrictions, true);
  // The destination identities are stable across a repeated review.
  const first = prepared;
  await f.operations.preparePhotoApp({
    operationId: operation.id,
    owners,
    approvedLossCodes,
    review,
  });
  assert.equal(prepared?.destinationId, first?.destinationId);
  assert.deepEqual(prepared?.owners, first?.owners);
});

test('cancelling a captured photo app removes the copy and staging and starts the app again', async (t) => {
  const f = await photoAppFixture(t);
  const started = await f.operations.startCommonCapture(f.app.Id, 'capture-key');
  await assert.rejects(f.operations.cancelPhotoApp(started.id), /photo_app_cancel_unavailable/);
  const operation = await f.settle(started.id);
  assert.equal(operation.state, 'awaiting-review');
  const staging = join(f.operations.directory(), `import-runtime-${operation.id}`);
  await access(staging);
  f.events.length = 0;
  await f.operations.cancelPhotoApp(operation.id);
  const name = sourceRestoreName(operation.id);
  assert.deepEqual(f.events, ['fence-recover', `remove:${name}`, 'start:app']);
  await assert.rejects(access(staging), /ENOENT/);
  const cancelled = f.store.history().find((o) => o.id === operation.id) as Operation;
  assert.equal(cancelled.state, 'complete');
  assert.equal(cancelled.error, 'photo_app_import_cancelled');
  assert.equal(f.store.get(`photo-app-plan:${operation.id}`), null);
  assert.equal(f.store.get(`photo-app-restore:${operation.id}`), null);
  await assert.rejects(f.operations.cancelPhotoApp(operation.id), /photo_app_cancel_unavailable/);
  // The Manager is free for the next operation.
  assert.equal(f.store.start('install', 'next', {}).created, true);
});

test('a recognised app that cannot be imported is refused before any operation starts', async (t) => {
  const f = await photoAppFixture(t);
  f.inventory.splice(1, 1);
  await assert.rejects(
    f.operations.startCommonCapture(f.app.Id, 'capture-key'),
    (error: { code: string; detail: string }) =>
      error.code === 'photo_app_not_importable' && error.detail === 'database_container_not_found',
  );
  await assert.rejects(f.operations.startCommonCapture('9'.repeat(64), 'capture-key'), /photo_app_not_recognised/);
  assert.equal(f.store.history().length, 0);
  const listed = await f.operations.photoAppSources();
  assert.deepEqual(
    listed.sources.map(({ reason }) => reason),
    ['database_container_not_found'],
  );
});
