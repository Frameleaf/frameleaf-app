// Unraid's Community Applications rewrites only the host side of a template to a custom appdata location.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { storagePath } from '../src/compose.js';
import { adoptOwnMounts, containerView, dockerArguments, ownControllers, tidyLocations, toHost } from '../src/host-paths.js';

const manager = (env: string[], binds: [string, string][], Id = 'abc123def456') => ({
  Id,
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

test('a nested same-path mount wins over a differing parent', () => {
  const nested: [string, string][] = [[`${HOST}/frameleaf-manager`, STATE], ['/mnt', '/data'], ['/data/private', '/data/private']];
  adoptOwnMounts([manager([`MANAGER_DATA=${STATE}`], nested)], STATE, {});
  assert.equal(toHost('/data/private/library'), '/data/private/library');
  assert.equal(toHost('/data/other'), '/mnt/other');
});

test('a container path is kept even when a host folder has the same name', () => {
  const clash: [string, string][] = [[`${HOST}/frameleaf-manager`, STATE], ['/data', '/other'], ['/photos', '/data']];
  const env: Record<string, string | undefined> = { MANAGER_STORAGE_ROOTS: '/data/media' };
  adoptOwnMounts([manager([`MANAGER_DATA=${STATE}`], clash)], STATE, env);
  assert.equal(env.MANAGER_STORAGE_ROOTS, '/data/media');
});

test('two Managers sharing a container path are told apart by hostname', () => {
  const mine = manager([`MANAGER_DATA=${STATE}`], binds, 'aaaaaaaaaaaa1111');
  const other = manager([`MANAGER_DATA=${STATE}`], [[`${HOST}/second`, STATE]], 'bbbbbbbbbbbb2222');
  assert.deepEqual(ownControllers([mine, other], STATE, 'aaaaaaaaaaaa'), [mine]);
  assert.equal(ownControllers([mine, other], STATE, undefined).length, 2);
  adoptOwnMounts([mine, other], STATE, { HOSTNAME: 'aaaaaaaaaaaa' });
  assert.equal(toHost(STATE), `${HOST}/frameleaf-manager`);
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

test('the real Unraid shape: variables hold host paths, container paths were left at the template default', () => {
  const H = '/mnt/shaganappi/appdata/frameleaf-manager-app-reviews';
  const shaganappi: [string, string][] = [
    [`${H}/frameleaf-media`, `${VIEW}/frameleaf-media`],
    [`${H}/frameleaf-databases`, `${VIEW}/frameleaf-databases`],
    [`${H}/frameleaf-backups`, `${VIEW}/frameleaf-backups`],
    ['/var/run/docker.sock', '/var/run/docker.sock'],
    ['/proc/1/mountinfo', '/run/frameleaf-host/mountinfo'],
    [H, `${VIEW}/frameleaf-manager`],
  ];
  const env: Record<string, string | undefined> = {
    MANAGER_DATA: H,
    MANAGER_BACKUP_ROOT: `${H}/frameleaf-backups`,
    MANAGER_STORAGE_ROOTS: `${H}/frameleaf-media`,
    MANAGER_DATABASE_ROOTS: `${H}/frameleaf-databases`,
    MANAGER_APPDATA_ROOT: `${H}/frameleaf-databases`,
  };
  const self = manager([`MANAGER_DATA=${H}`], shaganappi);
  adoptOwnMounts([self], H, env);
  assert.deepEqual(env, {
    MANAGER_DATA: `${VIEW}/frameleaf-manager`,
    MANAGER_BACKUP_ROOT: `${VIEW}/frameleaf-backups`,
    MANAGER_STORAGE_ROOTS: `${VIEW}/frameleaf-media`,
    MANAGER_DATABASE_ROOTS: `${VIEW}/frameleaf-databases`,
    MANAGER_APPDATA_ROOT: `${VIEW}/frameleaf-databases`,
  });
  assert.equal(toHost(`${VIEW}/frameleaf-databases/pg`), `${H}/frameleaf-databases/pg`);
  // Later checks find this Manager by its corrected state path.
  assert.deepEqual(ownControllers([containerView(self)], `${VIEW}/frameleaf-manager`).length, 1);
});
