import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Docker, SERVER_ADMIN } from '../src/docker.js';
import {
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

test('all ten source families use the same fixed common importer for all seven actions', async () => {
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
      await docker.importCommand('/synthetic', project, operation, action, {
        source,
        authority: action === 'status' ? undefined : authority,
      });
      const command = calls.at(-1)!;
      assert.deepEqual(command.slice(-8), [
        SERVER_ADMIN,
        'frameleaf-server',
        'import-library',
        action,
        '--source',
        source,
        '--config',
        '/run/frameleaf/import-library.json',
      ]);
      assert(command.includes(`${project}-import-${operation}`));
      assert(command.includes('--interactive'));
    }
  assert.equal(approvals, sources.length * (actions.length - 1));
});

test('common import activation is explicit and limited to verify; invalid requests never invoke Docker', async () => {
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
  await docker.importCommand('/synthetic', project, operation, 'verify', {
    source: 'ente',
    activate: true,
    authority: authorityFor('ente', operation),
  });
  assert.deepEqual(commands.at(-1)!.slice(-3), ['--config', '/run/frameleaf/import-library.json', '--activate']);
});

test('missing or substituted review authority is refused before Docker is invoked', async () => {
  let calls = 0;
  const docker = new Docker(async () => {
    calls++;
    return '{}';
  });
  const operation = randomUUID();
  const authority = authorityFor('photoprism', operation);
  await assert.rejects(docker.importCommand('/synthetic', project, operation, 'run', { source: 'photoprism' }), {
    message: 'import_source_authority_required',
  });
  for (const changed of [
    { ...authority, binding: { ...authority.binding, operationId: randomUUID() } },
    { ...authority, binding: { ...authority.binding, source: { ...authority.binding.source, kind: 'ente' } } },
    { ...authority, allowed: true },
  ]) {
    await assert.rejects(
      docker.importCommand('/synthetic', project, operation, 'run', {
        source: 'photoprism',
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
  await assert.rejects(
    docker.importCommand('/synthetic', 'frameleaf-bbbbbbbbbbbb', operation, 'run', {
      source: 'photoprism',
      authority: authorityFor('photoprism', operation),
    }),
    { message: 'import_source_authority_invalid' },
  );
  assert.equal(calls, 0);
});
