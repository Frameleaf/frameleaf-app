import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appdataDefaults, configuredAppdata } from '../src/appdata.js';
import { databaseMount, filesystemMounts, PostgresStorage } from '../src/postgres-storage.js';
import { renderCompose } from '../src/compose.js';
import type { Container } from '../src/docker.js';
import type { Installation } from '../src/contracts.js';
import type { VerifiedRelease } from '../src/releases.js';

test('Unraid defaults honor its actual setting and explicit administrator overrides', () => {
  assert.equal(configuredAppdata('DOCKER_APP_CONFIG_PATH="/mnt/user/appdata/"\n'), '/mnt/user/appdata');
  assert.equal(
    configuredAppdata('DOCKER_IMAGE_FILE="/mnt/user/system/docker.img"\nDOCKER_APP_CONFIG_PATH="/mnt/fast-pool/Apps/"'),
    '/mnt/fast-pool/Apps',
  );
  assert.equal(configuredAppdata("DOCKER_APP_CONFIG_PATH='/mnt/pool/Apps with spaces/'"), '/mnt/pool/Apps with spaces');
  assert.equal(appdataDefaults({}, 'DOCKER_APP_CONFIG_PATH="/mnt/user/custom/"').suggestedPath, '/mnt/user/custom');
  assert.equal(
    appdataDefaults({ DOCKER_APP_CONFIG_PATH: '/mnt/nvme/apps/' }, 'DOCKER_APP_CONFIG_PATH="/mnt/user/custom/"')
      .suggestedPath,
    '/mnt/nvme/apps',
  );
  const overridden = appdataDefaults(
    { MANAGER_APPDATA_ROOT: '/mnt/pool/selected', MANAGER_DATABASE_ROOTS: '/mnt/pool/selected' },
    'DOCKER_APP_CONFIG_PATH="/mnt/user/custom/"',
  );
  assert.equal(overridden.suggestedPath, '/mnt/pool/selected');
  assert.equal(overridden.detectedPath, '/mnt/user/custom');
  assert.equal(appdataDefaults({}, '').suggestedPath, '/mnt/user/appdata');
  assert.equal(appdataDefaults({}, null).suggestedPath, ''); // no Unraid guess on ordinary Linux
  for (const value of [
    'DOCKER_APP_CONFIG_PATH="/mnt/pool/$(command)"',
    'DOCKER_APP_CONFIG_PATH="/mnt/../etc"',
    'DOCKER_APP_CONFIG_PATH="/mnt/a"\nDOCKER_APP_CONFIG_PATH="/mnt/b"',
    'DOCKER_APP_CONFIG_PATH="/mnt/unclosed',
  ]) {
    assert.throws(() => configuredAppdata(value));
  }
});

const root = '/mnt/user/appdata';
const manager = { Mounts: [{ Type: 'bind', Source: root, Destination: root, RW: true }] } as Container;
const info = (type: string, source: string, mountRoot = '/appdata') =>
  filesystemMounts(
    '1 0 0:50 / / rw - overlay overlay rw\n2 1 8:1 ' +
      mountRoot +
      ' ' +
      root +
      ' rw - ' +
      type +
      ' ' +
      source +
      ' rw\n',
  );
const hostInfo = filesystemMounts(
  '1 0 8:2 / / rw - ext4 /dev/sdb1 rw\n2 1 8:1 /appdata ' + root + ' rw - xfs /dev/sda1 rw\n',
);
test('PostgreSQL accepts physical host binds and Unraid appdata shares outside docker.img', () => {
  for (const [type, source] of [
    ['ext4', '/dev/sda1'],
    ['btrfs', '/dev/nvme0n1p1'],
    ['xfs', '/dev/mapper/vg-apps'],
    ['zfs', 'fast/apps'],
  ]) {
    assert.equal(
      databaseMount(root, [root], '/var/lib/docker', manager, info(type, source), hostInfo, false).type,
      type,
    );
  }
  assert.equal(
    databaseMount(root, [root], '/var/lib/docker', manager, info('fuse.shfs', 'shfs'), hostInfo, true).type,
    'fuse.shfs',
  );
  assert.throws(() =>
    databaseMount(root, [root], '/var/lib/docker', manager, info('fuse.shfs', 'shfs'), hostInfo, false),
  );
});
test('PostgreSQL rejects docker.img, Docker data aliases, named volumes, RAM and network filesystems', () => {
  for (const [type, source] of [
    ['btrfs', '/dev/loop2'],
    ['xfs', '/dev/loop0'],
    ['tmpfs', 'tmpfs'],
    ['overlay', 'overlay'],
    ['nfs4', 'server:/apps'],
    ['cifs', '//server/apps'],
  ]) {
    assert.throws(() => databaseMount(root, [root], '/var/lib/docker', manager, info(type, source), hostInfo, true));
  }
  assert.throws(
    () => databaseMount(root, [root], root, manager, info('ext4', '/dev/sda1'), hostInfo, false),
    /database_in_docker_storage/,
  );
  const aliasHost = filesystemMounts(
    '1 0 8:2 / / rw - ext4 /dev/sdb1 rw\n2 1 8:1 / /mnt/docker rw - ext4 /dev/sda1 rw\n3 1 8:1 /volumes/unused/_data ' +
      root +
      ' rw - ext4 /dev/sda1 rw\n',
  );
  assert.throws(
    () =>
      databaseMount(
        root,
        [root],
        '/mnt/docker',
        manager,
        info('ext4', '/dev/sda1', '/volumes/unused/_data'),
        aliasHost,
        false,
      ),
    /database_in_docker_storage/,
  );
  const volume = { Mounts: [{ Type: 'volume', Source: root, Destination: root, RW: true }] } as Container;
  assert.throws(
    () => databaseMount(root, [root], '/var/lib/docker', volume, info('ext4', '/dev/sda1'), hostInfo, false),
    /database_requires_host_bind/,
  );
  assert.throws(
    () => databaseMount(root, ['/mnt/other'], '/var/lib/docker', manager, info('ext4', '/dev/sda1'), hostInfo, false),
    /database_path_not_mounted/,
  );
  const mismatch = { Mounts: [{ Type: 'bind', Source: '/host/apps', Destination: root, RW: true }] } as Container;
  assert.throws(
    () => databaseMount(root, [root], '/var/lib/docker', mismatch, info('ext4', '/dev/sda1'), hostInfo, false),
    /database_requires_host_bind/,
  );
});
test('rendered PostgreSQL uses its new host directory; media volume identity stays intact', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'manager-storage-'));
  try {
    const bundle = join(folder, 'bundle'),
      stack = join(folder, 'stack');
    await mkdir(bundle);
    await writeFile(
      join(bundle, 'docker-compose.yml'),
      JSON.stringify({ services: { database: {}, 'frameleaf-server': {}, 'immich-machine-learning': {} } }),
    );
    const image = 'ghcr.io/frameleaf/test@sha256:' + 'a'.repeat(64);
    const release = {
      directory: bundle,
      nas: { images: { server: image, machineLearning: image, postgres: image } },
    } as VerifiedRelease;
    const installation: Installation = {
      id: 'a'.repeat(12),
      project: 'frameleaf-' + 'a'.repeat(12),
      release: 'frameleaf-v3.1.0-1',
      port: 2283,
      ml: false,
      origin: 'new_import',
      sourceId: 'source',
      mayHaveWrittenMedia: false,
      databaseRoot: root,
      databasePath: root + '/frameleaf-aaaaaaaaaaaa-postgres-ABcd12',
      mounts: [
        { type: 'volume', source: 'immich-media', target: '/data', readOnly: false },
        { type: 'bind', source: '/fixtures/encoded', target: '/data/encoded-video', readOnly: false },
        { type: 'bind', source: '/fixtures/external', target: '/gallery/family', readOnly: true },
      ],
    };
    await renderCompose(release, installation, 'disposable-password', stack);
    const compose = JSON.parse(await readFile(join(stack, 'compose.json'), 'utf8'));
    assert.deepEqual(compose.services.database.volumes, [
      {
        type: 'bind',
        source: installation.databasePath,
        target: '/var/lib/postgresql',
        bind: { create_host_path: false },
      },
    ]);
    assert.equal(compose.volumes.database, undefined);
    assert.equal(compose.services.redis, undefined);
    assert.equal(compose.services['frameleaf-server'].environment.REDIS_HOSTNAME, undefined);
    assert.deepEqual(compose.services['frameleaf-server'].depends_on, { database: { condition: 'service_healthy' } });
    assert.equal(compose.services['frameleaf-server'].environment.IMMICH_CONFIG_FILE, undefined);
    assert.equal(compose.services['frameleaf-server'].environment.FRAMELEAF_MANAGER_ML_ENABLED, 'false');
    assert.deepEqual(compose.volumes['source-media-0'], { external: true, name: 'immich-media' });
    assert.deepEqual(compose.services['frameleaf-server'].volumes.slice(0, 3), [
      { type: 'volume', source: 'source-media-0', target: '/data', read_only: false, volume: { nocopy: true } },
      {
        type: 'bind',
        source: '/fixtures/encoded',
        target: '/data/encoded-video',
        read_only: false,
        bind: { create_host_path: false },
      },
      {
        type: 'bind',
        source: '/fixtures/external',
        target: '/gallery/family',
        read_only: true,
        bind: { create_host_path: false },
      },
    ]);
    await assert.rejects(
      renderCompose(
        {
          ...release,
          nas: { ...release.nas, images: { ...release.nas.images, postgres: 'postgres:19' } },
        },
        installation,
        'disposable-password',
        stack,
      ),
    );
    const application = {
      authority: 'file' as const,
      environment: { IMMICH_MEDIA_LOCATION: '/custom/library', TZ: 'America/Edmonton' },
      settings: { image: { quality: 80 } },
    };
    await renderCompose(release, installation, 'new-database-password', stack, application);
    const restored = JSON.parse(await readFile(join(stack, 'compose.json'), 'utf8'));
    assert.equal(restored.services['frameleaf-server'].environment.IMMICH_MEDIA_LOCATION, '/custom/library');
    assert.equal(restored.services['frameleaf-server'].environment.DB_PASSWORD, 'new-database-password');
    const settings = JSON.parse(await readFile(join(stack, 'application-settings.json'), 'utf8'));
    assert.deepEqual(settings.image, application.settings.image);
    assert.equal(settings.machineLearning.enabled, false);
    const literalInstallation = {
      ...installation,
      databasePath: installation.databasePath + '-$tenant',
      mounts: [{ type: 'bind' as const, source: '/fixtures/$tenant/${library}', target: '/data', readOnly: false }],
    };
    await renderCompose(release, literalInstallation, 'secret$VALUE${TOKEN}$$tail', stack);
    const literal = JSON.parse(await readFile(join(stack, 'compose.json'), 'utf8'));
    assert.equal(literal.services.database.volumes[0].source, installation.databasePath + '-$$tenant');
    assert.equal(literal.services['frameleaf-server'].volumes[0].source, '/fixtures/$$tenant/$${library}');
    assert.equal(literal.services.database.environment.POSTGRES_PASSWORD, 'secret$$VALUE$${TOKEN}$$$$tail');
    assert.equal(literal.services['frameleaf-server'].environment.DB_PASSWORD, 'secret$$VALUE$${TOKEN}$$$$tail');
    await assert.rejects(
      renderCompose(release, installation, 'new-database-password', stack, {
        ...application,
        environment: { ...application.environment, DB_HOSTNAME: 'old-source' },
      } as never),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('fresh PG19 bind parents allow traversal while withholding listing and write permissions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'manager-pg-parent-')));
  const storage = new PostgresStorage({} as never, root, [root], false);
  // Filesystem admission is covered separately; exercise the real exclusive allocation and permissions.
  Object.assign(storage, { validate: async () => ({ root, filesystem: 'ext4', device: '/fixture' }) });
  try {
    const first = await storage.allocate(root, 'a'.repeat(12), 1);
    const second = await storage.allocate(root, 'a'.repeat(12), 1);
    assert.notEqual(first, second);
    assert.equal((await stat(first)).mode & 0o777, 0o711);
    assert.equal((await stat(second)).mode & 0o777, 0o711);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
