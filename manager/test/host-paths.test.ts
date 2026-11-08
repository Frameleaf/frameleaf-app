// Unraid's Community Applications rewrites only the host side of a template to a custom appdata location.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { storagePath } from '../src/compose.js';
import { adoptOwnMounts, containerView, dockerArguments, tidyLocations, toHost } from '../src/host-paths.js';

const manager = (env: string[], binds: [string, string][]) => ({
  State: { Running: true },
  Config: { Env: env, Labels: { 'app.frameleaf.manager.role': 'controller' } },
  Mounts: binds.map(([Source, Destination]) => ({ Type: 'bind', Source, Destination })),
});
const HOST = '/mnt/shaganappi/appdata';
const VIEW = '/mnt/user/appdata';
const STATE = `${VIEW}/frameleaf-manager`;
const binds: [string, string][] = [
  [`${HOST}/frameleaf-manager`, STATE],
  [`${HOST}/frameleaf-backups`, `${VIEW}/frameleaf-backups`],
  ['/proc/1/mountinfo', '/run/frameleaf-host/mountinfo'],
  ['/same', '/same'],
];

test('a folder mapped to another container path reaches Docker by its host path', async () => {
  const env: Record<string, string | undefined> = { MANAGER_BACKUP_ROOT: `${HOST}/frameleaf-backups` };
  adoptOwnMounts([manager([`MANAGER_DATA=${STATE}`], binds)], STATE, env);

  // A variable holding the host side is corrected to the path Manager can reach.
  assert.equal(env.MANAGER_BACKUP_ROOT, `${VIEW}/frameleaf-backups`);
  assert.equal(toHost(`${STATE}/stack/secret`), `${HOST}/frameleaf-manager/stack/secret`);
  assert.equal(toHost('/same/x'), '/same/x');

  // Manager's host-information mounts are not location mappings.
  const view = containerView(manager([], binds));
  assert.equal(view.Mounts[0].Source, STATE);
  assert.equal(view.Mounts[2].Source, '/proc/1/mountinfo');

  assert.deepEqual(await dockerArguments(['run', '--mount', `type=bind,src=${STATE}/a,dst=/a,readonly`]), [
    'run',
    '--mount',
    `type=bind,src=${HOST}/frameleaf-manager/a,dst=/a,readonly`,
  ]);

  const cwd = await mkdtemp(join(tmpdir(), 'host-paths-'));
  const original = JSON.stringify({
    services: { database: { volumes: [{ type: 'bind', source: `${STATE}/db`, target: '/x' }, { type: 'volume', source: 'cache' }] } },
  });
  await writeFile(join(cwd, 'compose.json'), original);
  const args = await dockerArguments(['compose', '--file', 'compose.json', 'up'], cwd);
  assert.deepEqual(args, ['compose', '--file', join(cwd, 'host-compose.json'), 'up']);
  const written = JSON.parse(await readFile(join(cwd, 'host-compose.json'), 'utf8'));
  assert.equal(written.services.database.volumes[0].source, `${HOST}/frameleaf-manager/db`);
  assert.equal(written.services.database.volumes[1].source, 'cache');
  assert.equal(await readFile(join(cwd, 'compose.json'), 'utf8'), original);
});

test('a trailing slash from the Unraid folder picker no longer makes a location invalid', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-paths-')));
  await assert.rejects(storagePath(`${root}/`, [root], 0), /invalid_storage_path/);
  const env: Record<string, string | undefined> = { MANAGER_STORAGE_ROOTS: `${root}/:/other//place/`, MANAGER_BACKUP_ROOT: '/backups/' };
  tidyLocations(env);
  assert.equal(env.MANAGER_STORAGE_ROOTS, `${root}:/other/place`);
  assert.equal(env.MANAGER_BACKUP_ROOT, '/backups');
  assert.equal(await storagePath(env.MANAGER_STORAGE_ROOTS!.split(':')[0], [root], 0), root);
});

test('one host folder mapped to two container paths keeps each path', () => {
  const twice: [string, string][] = [
    [`${HOST}/frameleaf-manager`, STATE],
    [`${HOST}/shared`, `${VIEW}/first`],
    [`${HOST}/shared`, `${VIEW}/second`],
  ];
  adoptOwnMounts([manager([`MANAGER_DATA=${STATE}`], twice)], STATE, {});
  assert.deepEqual(
    containerView(manager([], twice)).Mounts.map((m) => m.Source),
    [STATE, `${VIEW}/first`, `${VIEW}/second`],
  );
});

test('state set to the host side of its mapping is refused with the path to use', () => {
  const state = `${HOST}/frameleaf-manager`;
  assert.throws(
    () => adoptOwnMounts([manager([`MANAGER_DATA=${state}`], binds)], state, {}),
    new RegExp(`Set it to ${STATE}`),
  );
});
