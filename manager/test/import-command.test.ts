import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Docker, SERVER_ADMIN } from '../src/docker.js';

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
const actions = [
  'preflight',
  'run',
  'status',
  'resume',
  'verify',
  'rollback',
  'abandon',
] as const;
const project = 'frameleaf-aaaaaaaaaaaa';

test('all ten source families use the same fixed common importer for all seven actions', async () => {
  const calls: string[][] = [];
  const docker = new Docker(async (_binary, args) => {
    calls.push(args);
    return args.includes('run') ? '{"run":null,"execution":null}' : '';
  });
  for (const source of sources)
    for (const action of actions) {
      const operation = randomUUID();
      await docker.importCommand('/synthetic', project, operation, action, {
        source,
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
    }
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
      docker.importCommand(
        '/synthetic',
        project,
        operation,
        action as never,
        options as never,
      ),
      /invalid_import_command/,
    );
  }
  assert.equal(calls, 0);
  await assert.rejects(
    docker.importCommand('/synthetic', project, operation, 'rollback'),
    /invalid_import_command/,
  );
  assert.equal(calls, 0);
  await docker.importCommand('/synthetic', project, operation, 'verify', {
    source: 'ente',
    activate: true,
  });
  assert.deepEqual(commands.at(-1)!.slice(-3), [
    '--config',
    '/run/frameleaf/import-library.json',
    '--activate',
  ]);
});
