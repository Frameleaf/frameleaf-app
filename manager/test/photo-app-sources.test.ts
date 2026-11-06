import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Container } from '../src/docker.js';
import {
  detectPhotoApps,
  identifyPhotoApp,
  imageRepository,
  type ContainerFileReader,
} from '../src/photo-app-sources.js';

let next = 0;
const id = () => (++next).toString(16).padStart(64, '0');
type Bind = [source: string, destination: string, type?: string];
function container(
  image: string,
  env: Record<string, string>,
  binds: Bind[],
  options: {
    project?: string;
    network?: string;
    aliases?: string[];
    name?: string;
    entrypoint?: string[];
    labels?: Record<string, string>;
  } = {},
): Container {
  const containerName = options.name ?? `app-${next + 1}`;
  return {
    Id: id(),
    Name: `/${containerName}`,
    Image: `sha256:${'e'.repeat(64)}`,
    State: { Running: true },
    Config: {
      Image: image,
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      Labels: {
        ...(options.project && {
          'com.docker.compose.project': options.project,
        }),
        ...options.labels,
      },
      Entrypoint: options.entrypoint ?? null,
      Cmd: null,
    },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      NetworkMode: 'bridge',
      PortBindings: {},
    },
    Mounts: binds.map(([source, destination, type]) => ({
      Type: type ?? 'bind',
      Source: source,
      ...(type === 'volume' && { Name: source.split('/').at(-2) }),
      Destination: destination,
      RW: true,
    })),
    NetworkSettings: {
      Networks: {
        [options.network ?? 'apps']: {
          IPAddress: '172.30.0.2',
          Aliases: options.aliases ?? [],
          DNSNames: [containerName],
        },
      },
    },
  } as Container;
}
const noFiles: ContainerFileReader = async () => null;
const files =
  (contents: Record<string, string>): ContainerFileReader =>
  async (_container, path) =>
    contents[path] ?? null;

test('image repositories ignore registry, tag and digest', () => {
  assert.deepEqual(imageRepository('ghcr.io/linuxserver/lychee:6.1.0@sha256:' + 'a'.repeat(64)), {
    repository: 'linuxserver/lychee',
    tag: '6.1.0',
  });
  assert.deepEqual(imageRepository('nextcloud'), {
    repository: 'nextcloud',
    tag: null,
  });
  assert.deepEqual(imageRepository('docker.io/library/nextcloud:29-apache'), {
    repository: 'nextcloud',
    tag: '29-apache',
  });
  assert.deepEqual(imageRepository('registry.local:5000/photoprism/photoprism'), {
    repository: 'photoprism/photoprism',
    tag: null,
  });
});

test('PhotoPrism SQLite is recognised by repository with any tag, keeping the reviewed mount checks', async () => {
  const app = container('photoprism/photoprism:latest', { PHOTOPRISM_DATABASE_DRIVER: 'sqlite' }, [
    ['/srv/pp/storage', '/photoprism/storage'],
    ['/srv/pp/originals', '/photoprism/originals'],
  ]);
  const plan = await identifyPhotoApp(app, [app], noFiles);
  assert.equal(plan.kind, 'photoprism');
  assert.equal(plan.database, 'sqlite');
  assert.equal(plan.version, null); // "latest" is not a version
  assert.equal(plan.sqlitePath, '/srv/pp/storage/index.db');
  assert.equal(plan.originalsPath, '/srv/pp/originals');
  assert.equal(plan.sourceRootPath, '/photoprism/originals');
  assert.deepEqual(plan.fence.workers, [app.Id]);
  assert.deepEqual(plan.fence.containers, [app.Id]);
  assert.deepEqual(
    plan.fence.mounts.map((m) => m.target),
    ['/photoprism/originals', '/photoprism/storage'],
  );
  assert.deepEqual(plan.running, [app.Id]);

  // An untested future build imports best effort: no digest or version pin.
  const future = container('photoprism/photoprism:991231-ffffffff@sha256:' + '9'.repeat(64), {}, [
    ['/srv/pp/storage', '/photoprism/storage'],
    ['/srv/pp/originals', '/photoprism/originals'],
  ]);
  const later = await identifyPhotoApp(future, [future], noFiles);
  assert.equal(later.version, '991231-ffffffff');
  assert.equal(later.database, 'sqlite');

  const nested = container('photoprism/photoprism', {}, [
    ['/srv/pp/storage', '/photoprism/storage'],
    ['/srv/pp/originals', '/photoprism/originals'],
    ['/srv/other', '/photoprism/originals/nested'],
  ]);
  await assert.rejects(identifyPhotoApp(nested, [nested], noFiles), /source_mount_unqualified/);
  const overlapping = container('photoprism/photoprism', {}, [
    ['/srv/pp', '/photoprism/storage'],
    ['/srv/pp/originals', '/photoprism/originals'],
  ]);
  await assert.rejects(identifyPhotoApp(overlapping, [overlapping], noFiles), /source_mount_unqualified/);
  const volume = container('photoprism/photoprism', {}, [
    ['/var/lib/docker/volumes/pp/_data', '/photoprism/storage', 'volume'],
    ['/srv/pp/originals', '/photoprism/originals'],
  ]);
  await assert.rejects(identifyPhotoApp(volume, [volume], noFiles), /source_mount_unsupported/);
  const unmapped = container('photoprism/photoprism', {}, [['/srv/pp/storage', '/photoprism/storage']]);
  await assert.rejects(identifyPhotoApp(unmapped, [unmapped], noFiles), /source_mount_missing/);
});

test('PhotoPrism on MariaDB fences only the app; the database container keeps running for the dump', async () => {
  const app = container(
    'photoprism/photoprism:240915',
    {
      PHOTOPRISM_DATABASE_DRIVER: 'mysql',
      PHOTOPRISM_DATABASE_SERVER: 'mariadb:3306',
      PHOTOPRISM_DATABASE_NAME: 'photoprism',
      PHOTOPRISM_DATABASE_USER: 'photoprism',
      PHOTOPRISM_DATABASE_PASSWORD: 'app-secret',
    },
    [
      ['/srv/pp/storage', '/photoprism/storage'],
      ['/srv/pp/originals', '/photoprism/originals'],
    ],
    { project: 'pp' },
  );
  const db = container('mariadb:11', { MARIADB_ROOT_PASSWORD: 'root-secret', MARIADB_DATABASE: 'photoprism' }, [], {
    project: 'pp',
    name: 'mariadb',
  });
  const plan = await identifyPhotoApp(app, [app, db], noFiles);
  assert.equal(plan.database, 'mysql');
  assert.deepEqual(plan.fence.workers, [app.Id]);
  assert.deepEqual(plan.fence.containers, [app.Id, db.Id]);
  assert.deepEqual(Object.keys(plan.fence.restart), [app.Id]);
  assert.deepEqual(
    plan.fence.mounts.map((m) => m.target),
    ['/photoprism/originals'],
  );
  assert.deepEqual(
    { ...plan.server, image: undefined },
    {
      engine: 'mysql',
      container: db.Id,
      image: undefined,
      name: 'photoprism',
      user: 'root',
      password: 'root-secret',
    },
  );
  // Credentials never reach the public listing.
  const [listed] = await detectPhotoApps([app, db], noFiles);
  assert.deepEqual(listed, {
    container: app.Id,
    kind: 'photoprism',
    name: 'PhotoPrism',
    version: '240915',
    database: 'mysql',
    importable: true,
  });
  assert(!JSON.stringify(listed).includes('secret'));

  await assert.rejects(identifyPhotoApp(app, [app], noFiles), /database_container_not_found/);
  const redis = container('redis:7', {}, [], { name: 'mariadb' });
  await assert.rejects(identifyPhotoApp(app, [app, redis], noFiles), /database_image_unsupported/);
  const locked = container('mariadb:11', { MARIADB_RANDOM_ROOT_PASSWORD: '1' }, [], { name: 'mariadb' });
  const anonymous = container(
    'photoprism/photoprism',
    {
      PHOTOPRISM_DATABASE_DRIVER: 'mysql',
      PHOTOPRISM_DATABASE_SERVER: 'mariadb:3306',
    },
    [
      ['/srv/pp/storage', '/photoprism/storage'],
      ['/srv/pp/originals', '/photoprism/originals'],
    ],
  );
  await assert.rejects(identifyPhotoApp(anonymous, [anonymous, locked], noFiles), /database_credentials_unavailable/);
});

test('each supported app is recognised with its database and originals folder', async () => {
  const photoview = container(
    'photoview/photoview:2.4.0',
    {
      PHOTOVIEW_DATABASE_DRIVER: 'sqlite',
      PHOTOVIEW_SQLITE_PATH: '/state/photoview.sqlite',
    },
    [
      ['/srv/pv/state', '/state'],
      ['/srv/pv/photos', '/photos'],
    ],
  );
  const pigallery = container('bpatrik/pigallery2:3.5.2', {}, [
    ['/srv/pg/db', '/app/data/db'],
    ['/srv/pg/config', '/app/data/config'],
    ['/srv/pg/images', '/app/data/images'],
  ]);
  const lychee = container(
    'lycheeorg/lychee:v7.12.0',
    { DB_CONNECTION: 'sqlite', DB_DATABASE: '/lychee-db/database.sqlite' },
    [
      ['/srv/ly/db', '/lychee-db'],
      ['/srv/ly/uploads', '/app/public/uploads'],
    ],
  );
  const nextcloud = container(
    'nextcloud:30-apache',
    {},
    [
      ['/srv/nc/html', '/var/www/html'],
      ['/srv/nc/data', '/var/www/html/data'],
    ],
    {
      project: 'nc',
    },
  );
  const cron = container(
    'nextcloud:30-apache',
    {},
    [
      ['/srv/nc/html', '/var/www/html'],
      ['/srv/nc/data', '/var/www/html/data'],
    ],
    {
      project: 'nc',
      entrypoint: ['/cron.sh'],
    },
  );
  const piwigo = container(
    'lscr.io/linuxserver/piwigo:16.4.0',
    {},
    [
      ['/srv/pw/config', '/config'],
      ['/srv/pw/gallery', '/gallery'],
    ],
    {
      project: 'pw',
    },
  );
  const piwigoDb = container('lscr.io/linuxserver/mariadb', { MYSQL_ROOT_PASSWORD: 'pw-root' }, [], {
    project: 'pw',
    name: 'piwigo-db',
  });
  const librephotos = container(
    'reallibrephotos/librephotos:2024w39',
    {
      DB_HOST: 'db',
      DB_NAME: 'librephotos',
      DB_USER: 'docker',
      DB_PASS: 'lp-secret',
    },
    [
      ['/srv/lp/photos', '/data'],
      ['/srv/lp/protected', '/protected_media'],
    ],
    { project: 'lp' },
  );
  const librephotosDb = container(
    'postgres:13',
    {
      POSTGRES_USER: 'docker',
      POSTGRES_PASSWORD: 'pg-secret',
      POSTGRES_DB: 'librephotos',
    },
    [],
    {
      project: 'lp',
      name: 'db',
    },
  );
  const frontend = container('reallibrephotos/librephotos-frontend:latest', {}, []);
  const read = files({
    '/var/www/html/config/config.php': `<?php\n$CONFIG = array (\n  'dbtype' => 'sqlite3',\n  'dbname' => 'nextcloud',\n  'datadirectory' => '/var/www/html/data',\n);`,
    '/gallery/local/config/database.inc.php': `<?php\n$conf['dblayer'] = 'mysqli';\n$conf['db_base'] = 'piwigo';\n$conf['db_user'] = 'piwigo';\n$conf['db_password'] = 'pw-app';\n$conf['db_host'] = 'piwigo-db';\n`,
  });
  const all = [photoview, pigallery, lychee, nextcloud, cron, piwigo, piwigoDb, librephotos, librephotosDb, frontend];
  const listed = await detectPhotoApps(all, read);
  assert.deepEqual(
    listed.map(({ kind, database, importable, version }) => ({
      kind,
      database,
      importable,
      version,
    })),
    [
      {
        kind: 'librephotos',
        database: 'postgres',
        importable: true,
        version: '2024w39',
      },
      {
        kind: 'lychee',
        database: 'sqlite',
        importable: true,
        version: 'v7.12.0',
      },
      {
        kind: 'nextcloud',
        database: 'sqlite',
        importable: true,
        version: '30-apache',
      },
      {
        kind: 'photoview',
        database: 'sqlite',
        importable: true,
        version: '2.4.0',
      },
      {
        kind: 'pigallery2',
        database: 'sqlite',
        importable: true,
        version: '3.5.2',
      },
      {
        kind: 'piwigo',
        database: 'mysql',
        importable: true,
        version: '16.4.0',
      },
    ],
  );
  const plan = async (app: Container) => identifyPhotoApp(app, all, read);
  assert.equal((await plan(photoview)).sqlitePath, '/srv/pv/state/photoview.sqlite');
  assert.equal((await plan(photoview)).sourceRootPath, '/photos');
  assert.equal((await plan(pigallery)).sqlitePath, '/srv/pg/db/sqlite.db');
  assert.equal((await plan(pigallery)).originalsPath, '/srv/pg/images');
  assert.equal((await plan(lychee)).sqlitePath, '/srv/ly/db/database.sqlite');
  assert.equal((await plan(lychee)).sourceRootPath, '/app/public/uploads');
  const cloud = await plan(nextcloud);
  assert.equal(cloud.sqlitePath, '/srv/nc/data/nextcloud.db');
  assert.equal(cloud.originalsPath, '/srv/nc/data');
  // Nextcloud's cron container writes the same library: it is fenced with the app, not listed separately.
  assert.deepEqual(cloud.fence.workers, [nextcloud.Id, cron.Id]);
  const gallery = await plan(piwigo);
  assert.equal(gallery.sourceRootPath, '/gallery');
  assert.deepEqual(
    { ...gallery.server, image: undefined },
    {
      engine: 'mysql',
      container: piwigoDb.Id,
      image: undefined,
      name: 'piwigo',
      user: 'root',
      password: 'pw-root',
    },
  );
  const photos = await plan(librephotos);
  assert.equal(photos.sourceRootPath, '/data');
  assert.equal(photos.originalsPath, '/srv/lp/photos');
  assert.deepEqual(
    { ...photos.server, image: undefined },
    {
      engine: 'postgres',
      container: librephotosDb.Id,
      image: undefined,
      name: 'librephotos',
      user: 'docker',
      password: 'pg-secret',
    },
  );
  assert.deepEqual(photos.fence.workers, [librephotos.Id]);
});

test('a recognised app on a database its importer cannot read is listed with a reason', async () => {
  const lychee = container('linuxserver/lychee:latest', { DB_CONNECTION: 'mysql', DB_HOST: 'lychee-db' }, [
    ['/srv/ly', '/pictures'],
  ]);
  const photoview = container('photoview/photoview', { PHOTOVIEW_MYSQL_URL: 'pv:pw@tcp(db:3306)/photoview' }, [
    ['/srv/pv', '/photos'],
  ]);
  const nextcloud = container('nextcloud', { POSTGRES_HOST: 'db' }, [['/srv/nc', '/var/www/html']]);
  const mystery = container('lycheeorg/lychee', {}, [['/srv/ly2', '/app/public/uploads']]);
  const listed = await detectPhotoApps([lychee, photoview, nextcloud, mystery], noFiles);
  assert.deepEqual(
    listed.map(({ kind, database, importable, reason }) => ({
      kind,
      database,
      importable,
      reason,
    })),
    [
      {
        kind: 'lychee',
        database: 'mysql',
        importable: false,
        reason: 'database_unsupported',
      },
      {
        kind: 'lychee',
        database: 'unknown',
        importable: false,
        reason: 'database_unknown',
      },
      {
        kind: 'nextcloud',
        database: 'postgres',
        importable: false,
        reason: 'database_unsupported',
      },
      {
        kind: 'photoview',
        database: 'mysql',
        importable: false,
        reason: 'database_unsupported',
      },
    ],
  );
});
