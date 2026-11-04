import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Docker, SERVER_ADMIN } from '../src/docker.js';
import {
  encodeImportPreparationRequest,
  encodeImportSourceAuthorityRequest,
  parseImportSourceAuthorityResponse,
  type ImportSourceAuthority,
} from '../src/import-source-authority.js';

const sources = [
  'immich',
  'photoprism',
  'librephotos',
  'photoview',
  'piwigo',
  'lychee',
  'pigallery2',
  'ente',
  'nextcloud',
  'synology',
] as const;
const actions = ['preflight', 'run', 'status', 'resume', 'verify', 'rollback', 'abandon'] as const;
const project = 'frameleaf-aaaaaaaaaaaa';
const image = `ghcr.io/frameleaf/frameleaf-server@sha256:${'a'.repeat(64)}`;
const password = 'fixture:p@ss$word';
const media = [
  { source: '/fixtures/originals', target: '/import-media/source', readOnly: true },
  { source: '/fixtures/destination', target: '/data', readOnly: false },
];
// Synthetic argument/protocol checks only; this callback does not qualify real source access.
const authorityFor = (source: (typeof sources)[number], operationId: string): ImportSourceAuthority => ({
  installation: project.slice('frameleaf-'.length),
  binding: {
    operationId,
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    source: {
      kind: source,
      version: 'synthetic',
      identity: 'fixture',
      revision: 'frozen',
      schemaSha256: 'c'.repeat(64),
    },
  },
  destinationId: randomUUID(),
  verify: async () => {},
});

async function runtime(t: TestContext, operationId: string, directory?: string) {
  if (!directory) {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-import-command-'));
    const cleanup = directory;
    t.after(() => rm(cleanup, { recursive: true, force: true }));
  }
  await writeFile(
    join(directory, 'compose.json'),
    JSON.stringify({
      name: project,
      services: {
        'frameleaf-server': { image, ports: ['2283:2283'], environment: { PRIVATE_SETTING: 'excluded' } },
      },
    }),
  );
  await writeFile(join(directory, 'database-password'), password, { mode: 0o600 });
  const root = join(directory, `import-runtime-${operationId}`);
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, 'bundle'), { mode: 0o700 });
  return directory;
}

test('all ten source families use the same fixed common importer for all seven actions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-import-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: string[][] = [];
  let approvals = 0;
  let active: { action: (typeof actions)[number]; authority: ImportSourceAuthority };
  const docker = new Docker(async (_binary, args, options) => {
    calls.push(args);
    if (!args.includes('run')) return '';
    if (active.action !== 'status') {
      const nonce = randomUUID();
      const request = encodeImportSourceAuthorityRequest(active.action, active.authority, nonce);
      const response = await options?.reply?.(request.trimEnd());
      assert(response, 'The common command must route its live source checks through Manager');
      parseImportSourceAuthorityResponse(response.trimEnd(), nonce);
    }
    return '{"run":null,"execution":null}';
  });
  for (const source of sources)
    for (const action of actions) {
      const operation = randomUUID();
      const authority = authorityFor(source, operation);
      authority.verify = async () => {
        approvals++;
      };
      active = { action, authority };
      await runtime(t, operation, directory);
      await docker.importCommand(directory, project, operation, action, {
        source,
        destinationId: authority.destinationId,
        media,
        authority: action === 'status' ? undefined : authority,
      });
      const command = calls.at(-1)!;
      const overlay = join(directory, `import-runtime-${operation}`, 'compose.json');
      assert.deepEqual(command.slice(3, 6), ['--file', overlay, 'run']);
      const compose = JSON.parse(await readFile(overlay, 'utf8'));
      const app = compose.services['frameleaf-server'];
      assert.equal(app.image, image);
      assert.equal(app.restart, 'no');
      assert.equal(app.volumes.find((mount: { target: string }) => mount.target === '/data').read_only, false);
      assert.equal(app.ports, undefined);
      assert.equal(app.environment.PRIVATE_SETTING, undefined);
      assert.equal(app.environment.DB_URL_FILE, '/run/frameleaf/import-private/database-url');
      assert.equal(compose.networks.default.name, `${project}_default`);
      assert(!JSON.stringify(compose).includes(password));
      const url = new URL(
        await readFile(join(directory, `import-runtime-${operation}`, 'config', 'database-url'), 'utf8'),
      );
      assert.equal(url.hostname, 'database');
      assert.equal(decodeURIComponent(url.password), password);
      assert.equal(app.environment.FRAMELEAF_IMPORT_MANAGER_OPERATION_ID, operation);
      assert.equal(app.labels['app.frameleaf.manager.import'], operation);
      assert.equal(app.logging.driver, 'none');
      assert.deepEqual(
        app.volumes.map((mount: { read_only: boolean }) => mount.read_only),
        [true, true, false, true, false],
      );
      assert.deepEqual(command.slice(-8), [
        SERVER_ADMIN,
        'frameleaf-server',
        'import-library',
        action,
        '--source',
        source,
        '--config',
        '/run/frameleaf/import-private/command.json',
      ]);
      assert(command.includes(`${project}-import-${operation}`));
      assert(command.includes('--interactive'));
    }
  assert.equal(approvals, sources.length * (actions.length - 1));
});

test('common import activation is explicit and limited to verify; invalid requests never invoke Docker', async (t) => {
  let calls = 0;
  const commands: string[][] = [];
  const docker = new Docker(async (_binary, args) => {
    calls++;
    commands.push(args);
    return args.includes('run') ? '{}' : '';
  });
  const operation = randomUUID();
  for (const [action, options] of [
    ['run', { source: 'photoprism', activate: true }],
    ['verify', { source: 'shell' }],
    ['verify', { source: 'photoprism', activate: 'yes' }],
    ['shell', { source: 'photoprism' }],
  ] as const) {
    await assert.rejects(
      docker.importCommand('/synthetic', project, operation, action as never, options as never),
      /invalid_import_command/,
    );
  }
  assert.equal(calls, 0);
  await assert.rejects(docker.importCommand('/synthetic', project, operation, 'rollback'), /invalid_import_command/);
  assert.equal(calls, 0);
  const authority = authorityFor('ente', operation);
  await docker.importCommand(await runtime(t, operation), project, operation, 'verify', {
    source: 'ente',
    destinationId: authority.destinationId,
    media,
    activate: true,
    authority,
  });
  assert.deepEqual(commands.at(-1)!.slice(-3), [
    '--config',
    '/run/frameleaf/import-private/command.json',
    '--activate',
  ]);
});

test('missing or substituted review authority is refused before Docker is invoked', async () => {
  let calls = 0;
  const docker = new Docker(async () => {
    calls++;
    return '{}';
  });
  const operation = randomUUID();
  const authority = authorityFor('photoprism', operation);
  await assert.rejects(
    docker.importCommand('/synthetic', project, operation, 'run', {
      source: 'photoprism',
      destinationId: authority.destinationId,
    }),
    {
      message: 'import_source_authority_required',
    },
  );
  for (const changed of [
    { ...authority, binding: { ...authority.binding, operationId: randomUUID() } },
    { ...authority, binding: { ...authority.binding, source: { ...authority.binding.source, kind: 'ente' } } },
    { ...authority, allowed: true },
    { ...authority, destinationId: randomUUID() },
  ]) {
    await assert.rejects(
      docker.importCommand('/synthetic', project, operation, 'run', {
        source: 'photoprism',
        destinationId: authority.destinationId,
        media,
        authority: changed as never,
      }),
      { message: 'import_source_authority_invalid' },
    );
  }
  assert.equal(calls, 0);
});

test('a reviewed import cannot be launched for another installation', async () => {
  let calls = 0;
  const docker = new Docker(async (_binary, args) => {
    calls++;
    return args.includes('run') ? '{}' : '';
  });
  const operation = randomUUID();
  const authority = authorityFor('photoprism', operation);
  await assert.rejects(
    docker.importCommand('/synthetic', 'frameleaf-bbbbbbbbbbbb', operation, 'run', {
      source: 'photoprism',
      destinationId: authority.destinationId,
      media,
      authority,
    }),
    { message: 'import_source_authority_invalid' },
  );
  assert.equal(calls, 0);
});

test('completes a reviewed import through the launcher and reuses its preflight receipt', async (t) => {
  const operation = randomUUID();
  const authority = authorityFor('photoprism', operation);
  const directory = await runtime(t, operation);
  const calls: string[] = [];
  let current: string | null = null;
  let phase = 'copying';
  const docker = new Docker(async (_binary, args, options) => {
    if (!args.includes('run')) return '';
    const action = args[args.indexOf('import-library') + 1] as (typeof actions)[number];
    calls.push(action);
    if (action !== 'status') {
      const nonce = randomUUID();
      const request = encodeImportSourceAuthorityRequest(action, authority, nonce);
      const reply = await options?.reply?.(request.trimEnd());
      assert(reply);
      parseImportSourceAuthorityResponse(reply.trimEnd(), nonce);
    }
    if (action === 'run') {
      current = 'copying';
      throw new Error('fixture interruption');
    }
    if (action === 'resume') current = phase = 'verifying';
    if (action === 'verify') {
      assert(args.includes('--activate'));
      current = phase = 'activated';
    }
    return JSON.stringify({
      run: current ? { operationId: operation, source: authority.binding.source, status: current } : null,
      execution: current ? { phase, abandoned: false, writersMayHaveStarted: current === 'activated' } : null,
    });
  });
  let preflightComplete = false;
  const preflight = async (run: () => Promise<void>) => {
    if (preflightComplete) return;
    await run();
    preflightComplete = true;
  };
  await assert.rejects(
    docker.completeReviewedImport(directory, project, authority, media, preflight),
    /fixture interruption/,
  );
  assert.deepEqual(calls, ['preflight', 'status', 'run']);
  calls.length = 0;
  await docker.completeReviewedImport(directory, project, authority, media, preflight);
  assert.deepEqual(calls, ['status', 'resume', 'status', 'verify', 'status']);
  calls.length = 0;
  await docker.completeReviewedImport(directory, project, authority, media, preflight);
  assert.deepEqual(calls, ['status']);
});

test('preparation uses read-only media, live fencing and the exact receipt binding', async () => {
  const operationId = randomUUID();
  const runtimeAuthority = authorityFor('photoprism', operationId);
  let checks = 0;
  const seal = {
    operationId,
    destinationId: runtimeAuthority.destinationId,
    source: runtimeAuthority.binding.source,
    preparationSha256: 'd'.repeat(64),
  };
  const authority = {
    ...seal,
    verify: async () => {
      checks++;
    },
  };
  const receipt = {
    bundleName: `bundle-${operationId}-aBc123`,
    binding: runtimeAuthority.binding,
    destinationId: runtimeAuthority.destinationId,
    requiredMediaBytes: 123,
    summary: { owners: 1, assets: 1, files: 1, albums: 0, preservationDifferences: 0 },
  };
  let returned = receipt;
  const docker = new Docker(async (binary, args, options) => {
    assert.equal(binary, 'docker');
    assert(args.includes('none'));
    assert(args.includes(`frameleaf-import-prepare-${operationId}`));
    assert(args.includes('type=bind,src=/fixtures/originals,dst=/import-media/source,readonly'));
    assert(args.includes('type=bind,src=/fixtures/destination,dst=/data,readonly'));
    assert.deepEqual(args.slice(-3), [
      'prepare-library-import',
      '--config',
      '/run/frameleaf/import-preparation/prepare.json',
    ]);
    const nonce = randomUUID();
    const reply = await options?.reply?.(encodeImportPreparationRequest(seal, nonce).trimEnd());
    assert(reply);
    parseImportSourceAuthorityResponse(reply.trimEnd(), nonce);
    return JSON.stringify(returned);
  });
  assert.deepEqual(await docker.prepareImportBundle('/private/manager', image, authority, media), receipt);
  assert.equal(checks, 3);
  returned = { ...receipt, bundleName: '../wrong-bundle' };
  await assert.rejects(
    docker.prepareImportBundle('/private/manager', image, authority, media),
    /invalid_import_response/,
  );
});

test('inventory inspection mounts only private staging read-only and refuses a substituted source receipt', async () => {
  const operationId = randomUUID();
  const approved = authorityFor('photoprism', operationId);
  const authority = {
    operationId,
    destinationId: approved.destinationId,
    source: approved.binding.source,
    preparationSha256: 'd'.repeat(64),
    verify: async () => {},
  };
  const inventory = {
    photos: 2, privatePhotos: 1, albums: 1, originals: 2, sidecars: 0,
    accounts: [{ id: 'owner', name: 'Owner', role: 'admin', canLogin: true }],
    albumsRequiringSnapshot: [],
  };
  let source = authority.source;
  let returned: unknown = inventory;
  const docker = new Docker(async (_binary, args) => {
    const mounts = args.flatMap((arg, index) => arg === '--mount' ? [args[index + 1]] : []);
    assert.deepEqual(mounts, [
      `type=bind,src=/private/manager/import-runtime-${operationId},dst=/run/frameleaf/import-preparation,readonly`,
    ]);
    return JSON.stringify({ operationId, destinationId: authority.destinationId, source, inventory: returned });
  });
  assert.deepEqual(await docker.inspectImportSource('/private/manager', image, authority), inventory);
  const photoview = {
    assets: 2, albums: 1, assetsWithAlbumGrants: 1, accounts: [{ id: '1', name: 'Owner', role: 'admin' }],
  };
  source = { ...authority.source, kind: 'photoview' };
  const photoviewAuthority = { ...authority, source };
  returned = photoview;
  assert.deepEqual(await docker.inspectImportSource('/private/manager', image, photoviewAuthority), photoview);
  returned = { ...photoview, accounts: [{ ...photoview.accounts[0], password: 'forbidden' }] };
  await assert.rejects(docker.inspectImportSource('/private/manager', image, photoviewAuthority), /invalid_import_response/);
  returned = inventory;
  await assert.rejects(docker.inspectImportSource('/private/manager', image, photoviewAuthority), /invalid_import_response/);
  source = authority.source;
  source = { ...source, revision: 'substituted' };
  await assert.rejects(docker.inspectImportSource('/private/manager', image, authority), /invalid_import_response/);
});
