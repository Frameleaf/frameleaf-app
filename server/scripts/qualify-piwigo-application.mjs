// Native Piwigo 16.4.0 qualification: a disposable PHP image built from the pinned base and the pinned source
// commit, seeded through Piwigo's own installer and web API, stopped, captured with a locked MariaDB dump and
// restored into an isolated read-only server for the product restore reader inside the common import lifecycle.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  baseImage,
  builtImage,
  cleanupQualification,
  databaseImage,
  hasImage,
} from './cleanup-piwigo-qualification.mjs';
import { shareWithContainer } from './qualification-directory.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('../src/library-import/fixtures/piwigo/16.4.0-mariadb.json', import.meta.url), 'utf8'),
);
const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID;
if (!/^\d+-\d+$/u.test(runId ?? '') || basename(tmpdir()) !== `frameleaf-piwigo-${runId}`)
  throw new Error('Invalid qualification cleanup scope');
const directory = mkdtempSync(join(tmpdir(), 'application-'));
const sourceRoot = join(directory, 'www'),
  upload = join(sourceRoot, 'upload'),
  databaseDirectory = join(directory, 'mariadb');
for (const path of [sourceRoot, upload, databaseDirectory]) mkdirSync(path, { mode: 0o700 });
// The pinned PHP base runs Apache as www-data (33); only the original-upload tree is shared with it.
shareWithContainer(upload);
const image = builtImage(runId);
const names = {
  network: `frameleaf-piwigo-${runId}`,
  app: `frameleaf-piwigo-app-${runId}`,
  database: `frameleaf-piwigo-db-${runId}`,
  restore: `frameleaf-piwigo-restore-${runId}`,
};
const labels = [
  '--label',
  'app.frameleaf.qualification-family=piwigo',
  '--label',
  `app.frameleaf.qualification-run=${runId}`,
];
// Per-run synthetic secrets travel to Docker through the environment, never through argv or output.
const secrets = {
  MARIADB_ROOT_PASSWORD: randomBytes(32).toString('hex'),
  MARIADB_PASSWORD: randomBytes(32).toString('hex'),
};
const adminPassword = randomBytes(32).toString('hex');
const readerPassword = randomBytes(32).toString('hex');
const command = (args, options = {}) =>
  spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    env: { ...process.env, ...secrets, MYSQL_PWD: secrets.MARIADB_ROOT_PASSWORD, ...options.env },
  });
const run = (args, options) => {
  const result = command(args, options);
  if (result.status !== 0) throw new Error(`Fixture Docker operation failed: ${args[0]}`);
  return typeof result.stdout === 'string' ? result.stdout.trim() : result.stdout;
};
const sql = (container, statements, database = '') =>
  run(['exec', '-i', '-e', 'MYSQL_PWD', container, 'mariadb', '-uroot', '-N', '-B', ...(database ? [database] : [])], {
    input: statements,
  });
const waitDatabase = async (container) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    // TCP succeeds only on the final server; the entrypoint's initialization server skips networking.
    const probe = command(
      ['exec', '-e', 'MYSQL_PWD', container, 'mariadb', '-uroot', '--protocol=tcp', '-h127.0.0.1', '-e', 'SELECT 1'],
      { stdio: 'ignore', timeout: 10_000 },
    );
    if (probe.status === 0) return;
    if (run(['inspect', '--format', '{{.State.Running}}', container]) !== 'true')
      throw new Error('Fixture database stopped during initialization');
    await setTimeout(1000);
  }
  throw new Error('Fixture database initialization timed out');
};
const loopbackPort = (container, port) => {
  const published = Number(
    run(['port', container, String(port)])
      .split('\n')
      .map((line) => line.match(/^127\.0\.0\.1:(\d+)$/u)?.[1])
      .find(Boolean),
  );
  if (!Number.isInteger(published) || published < 1 || published > 65_535) throw new Error('Invalid loopback port');
  return published;
};
const stopped = (container) => {
  run(['stop', '--time', '30', container]);
  assert.equal(
    run(['inspect', '--format', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}', container]),
    'false no',
  );
};
const identity = (container) => ({
  id: run(['inspect', '--format', '{{.Id}}', container]),
  image: run(['inspect', '--format', '{{.Image}}', container]),
  name: container,
});
const byText = (a, b) => a.localeCompare(b);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dockerfile = [
  `FROM ${baseImage}`,
  'ARG PIWIGO_COMMIT',
  'RUN set -eux; \\',
  '  apt-get update; \\',
  '  apt-get install -y --no-install-recommends git ca-certificates libpng-dev libjpeg62-turbo-dev libfreetype-dev; \\',
  '  docker-php-ext-configure gd --with-jpeg --with-freetype; \\',
  '  docker-php-ext-install -j"$(nproc)" mysqli gd exif; \\',
  '  git init -q /tmp/piwigo; \\',
  '  git -C /tmp/piwigo fetch -q --depth 1 https://github.com/Piwigo/Piwigo.git "$PIWIGO_COMMIT"; \\',
  // The commit id content-addresses the whole tree; the recorded archive checksum is not reproducible upstream.
  '  test "$(git -C /tmp/piwigo rev-parse FETCH_HEAD)" = "$PIWIGO_COMMIT"; \\',
  '  git -C /tmp/piwigo archive FETCH_HEAD | tar -x -C /var/www/html; \\',
  '  rm -rf /tmp/piwigo; apt-get purge -y git; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \\',
  `  grep -qF "define('PHPWG_VERSION', '${fixture.source.version}');" /var/www/html/include/constants.php; \\`,
  '  php -m | grep -qx mysqli; php -m | grep -qx gd; php -m | grep -qx exif; \\',
  '  chown -R www-data:www-data /var/www/html',
  '',
].join('\n');

let phase = 'initialization';
let failure = false;
try {
  for (const [marker, reference] of [
    ['base-image.json', baseImage],
    ['database-image.json', databaseImage],
  ])
    writeFileSync(join(tmpdir(), marker), JSON.stringify({ createdImage: !hasImage(run, reference) }), { mode: 0o600 });
  phase = 'pinned image pull';
  run(['pull', databaseImage]);
  run(['pull', baseImage]);
  phase = 'disposable PHP image build';
  run(
    ['build', '--pull=false', '--tag', image, ...labels, '--build-arg', `PIWIGO_COMMIT=${fixture.source.commit}`, '-'],
    { input: dockerfile, timeout: 1_200_000 },
  );

  phase = 'source database startup';
  run(['network', 'create', ...labels, names.network]);
  run([
    'run',
    '-d',
    '--name',
    names.database,
    '--restart=no',
    ...labels,
    '--network',
    names.network,
    '--mount',
    `type=bind,source=${databaseDirectory},target=/var/lib/mysql`,
    '-e',
    'MARIADB_ROOT_PASSWORD',
    '-e',
    'MARIADB_PASSWORD',
    '-e',
    'MARIADB_USER=piwigo',
    '-e',
    'MARIADB_DATABASE=piwigo',
    databaseImage,
  ]);
  await waitDatabase(names.database);
  assert.equal(sql(names.database, 'SELECT VERSION();'), fixture.runtime.databaseVersion);

  phase = 'application startup';
  run([
    'run',
    '-d',
    '--name',
    names.app,
    '--restart=no',
    ...labels,
    '--network',
    names.network,
    '-p',
    '127.0.0.1::80',
    '--mount',
    `type=bind,source=${upload},target=/var/www/html/upload`,
    image,
  ]);
  const origin = `http://127.0.0.1:${loopbackPort(names.app, 80)}`;
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt++) {
    try {
      const response = await fetch(origin + '/install.php', { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      ready = response.ok;
    } catch {
      /* Apache is unavailable until startup completes. */
    }
    if (!ready) {
      if (run(['inspect', '--format', '{{.State.Running}}', names.app]) !== 'true')
        throw new Error('Fixture application stopped during initialization');
      await setTimeout(1000);
    }
  }
  if (!ready) throw new Error('Fixture application initialization timed out');

  phase = 'native web installer';
  const adminName = 'fixture_admin';
  const installed = await fetch(origin + '/install.php?language=en_UK', {
    method: 'POST',
    body: new URLSearchParams({
      install: 'Start installation',
      dbhost: names.database,
      dbuser: 'piwigo',
      dbpasswd: secrets.MARIADB_PASSWORD,
      dbname: 'piwigo',
      prefix: fixture.tablePrefix,
      admin_name: adminName,
      admin_pass1: adminPassword,
      admin_pass2: adminPassword,
      admin_mail: 'fixture-admin@example.test',
    }),
    signal: AbortSignal.timeout(120_000),
  });
  await installed.body?.cancel();
  if (!installed.ok) throw new Error('Native installer refused');
  assert.equal(
    Number(sql(names.database, `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='piwigo';`)),
    fixture.schema.tables.length,
  );

  // A cookie-session client for Piwigo's own web API (ws.php) and its administration forms.
  const client = () => {
    const cookies = new Map();
    const post = async (path, body) => {
      const response = await fetch(origin + path, {
        method: 'POST',
        headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const index = pair.indexOf('=');
        const [key, value] = [pair.slice(0, index).trim(), pair.slice(index + 1)];
        if (value === 'deleted' || value === '') cookies.delete(key);
        else cookies.set(key, value);
      }
      return response;
    };
    const ws = async (method, params = {}, file) => {
      const body = new FormData();
      for (const [key, value] of Object.entries(params)) body.append(key, String(value));
      if (file) body.append('image', new Blob([file.bytes], { type: 'image/jpeg' }), file.name);
      const response = await post(`/ws.php?format=json&method=${encodeURIComponent(method)}`, body);
      const json = await response.json();
      if (json.stat !== 'ok') {
        phase += `: ${method} refused (${json.err ?? response.status})`;
        throw new Error('Native web API refused');
      }
      return json.result;
    };
    ws.form = async (path, entries) => {
      const response = await post(path, new URLSearchParams(entries));
      const html = await response.text();
      if (!response.ok) throw new Error('Native administration form refused');
      return html;
    };
    return ws;
  };
  phase = 'native login';
  const ws = client();
  assert.equal(await ws('pwg.session.login', { username: adminName, password: adminPassword }), true);
  const status = await ws('pwg.session.getStatus');
  assert.equal(status.username, adminName);
  assert.equal(status.status, 'webmaster');
  assert.equal(status.version, fixture.source.version);
  const token = status.pwg_token;
  assert.match(token, /^[a-f0-9]{32}$/u);
  const denied = client();
  await assert.rejects(denied('pwg.session.login', { username: adminName, password: 'wrong-' + adminPassword }));

  // Rating ships disabled; enable it through the native main configuration form, keeping every other main
  // option at its installer default (the form writes absent checkboxes as false).
  phase = 'native rating configuration';
  await ws.form('/admin.php?page=configuration&section=main', [
    ['pwg_token', token],
    ['submit', 'Save Settings'],
    ['order_by[]', 'date_available DESC'],
    ['order_by[]', 'file ASC'],
    ['order_by[]', 'id ASC'],
    ...[
      'rate',
      'rate_anonymous',
      'log',
      'history_guest',
      'allow_user_registration',
      'allow_user_customization',
      'show_mobile_app_banner_in_admin',
      'upload_detect_duplicate',
    ].map((name) => [name, 'on']),
  ]);
  assert.equal(sql(names.database, `SELECT value FROM flq_config WHERE param='rate';`, 'piwigo'), 'true');

  phase = 'native album';
  const album = { name: 'Native Piwigo album', description: 'Manually organized album' };
  album.id = String((await ws('pwg.categories.add', { name: album.name, comment: album.description })).id);
  assert.match(album.id, /^[1-9]\d*$/u);

  phase = 'native uploads and manual edits';
  const seeds = [];
  for (const [name, color, favorite, rating, dateCreation] of [
    ['blue', '#2850c8', true, 4, '2019-03-17 14:15:16'],
    ['green', '#28b050', false, null, '2020-06-10 12:30:00'],
  ]) {
    const bytes = await sharp({ create: { width: 640, height: 480, channels: 3, background: color } })
      .jpeg()
      .toBuffer();
    const title = `Native ${name} title`;
    const uploaded = await ws(
      'pwg.images.addSimple',
      { category: album.id, name: title, comment: `Uploaded ${name} caption` },
      { bytes, name: `${name}.jpg` },
    );
    const imageId = String(uploaded.image_id);
    assert.match(imageId, /^[1-9]\d*$/u);
    seeds.push({
      name,
      imageId,
      fileName: `${name}.jpg`,
      sha256: digest(bytes),
      bytes: String(bytes.length),
      title,
      caption: `Manually edited ${name} caption`,
      favorite,
      rating,
      dateCreation,
    });
  }
  // Uploads wait in the lounge once the gallery holds a photo; launch them before the source is fenced.
  await ws('pwg.images.emptyLounge');
  for (const seed of seeds) {
    await ws('pwg.images.setInfo', {
      image_id: seed.imageId,
      comment: seed.caption,
      date_creation: seed.dateCreation,
      single_value_mode: 'replace',
      pwg_token: token,
    });
    if (seed.favorite) await ws('pwg.users.favorites.add', { image_id: seed.imageId });
    if (seed.rating !== null) await ws('pwg.images.rate', { image_id: seed.imageId, rate: seed.rating });
  }

  phase = 'native readback';
  const members = await ws('pwg.categories.getImages', { cat_id: album.id, per_page: 100 });
  assert.deepEqual(
    members.images.map((row) => String(row.id)).toSorted(byText),
    seeds.map((seed) => seed.imageId).toSorted(byText),
  );
  const favourites = await ws('pwg.users.favorites.getList', { per_page: 100 });
  assert.deepEqual(
    favourites.images.map((row) => String(row.id)),
    seeds.filter((seed) => seed.favorite).map((seed) => seed.imageId),
  );
  for (const seed of seeds) {
    const info = await ws('pwg.images.getInfo', { image_id: seed.imageId });
    assert.equal(info.name, seed.title);
    assert.equal(info.comment, seed.caption);
    assert.equal(info.date_creation, seed.dateCreation);
    assert.equal(info.file, seed.fileName);
    assert.equal(Number(info.rates?.count ?? 0), seed.rating === null ? 0 : 1);
    assert.deepEqual(
      info.categories.map((row) => String(row.id)),
      [album.id],
    );
  }

  phase = 'source stop';
  const app = identity(names.app);
  stopped(names.app);
  // Install stored MD5; the native login above rehashed the webmaster to Piwigo's portable PHPass format.
  assert.equal(sql(names.database, `SELECT LEFT(password,4) FROM flq_users WHERE id=1;`, 'piwigo'), '$P$G');
  assert.equal(sql(names.database, 'SELECT COUNT(*) FROM flq_lounge;', 'piwigo'), '0');

  phase = 'original-byte evidence';
  const found = new Map();
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('pwg_')) walk(child);
      // Piwigo protects every upload directory with an empty index.htm; it is not media.
      else if (entry.isFile() && entry.name !== 'index.htm')
        found.set(digest(readFileSync(child)), relative(sourceRoot, child));
    }
  };
  walk(upload);
  assert.equal(found.size, seeds.length, 'Each seeded upload must be one distinct stored original');
  for (const seed of seeds) {
    seed.path = found.get(seed.sha256);
    assert.match(seed.path ?? '', /^upload\/\d{4}\/\d{2}\/\d{2}\/[0-9]{14}-[a-f0-9]{8}\.jpg$/u);
  }

  phase = 'locked native capture';
  const dump = run(
    [
      'exec',
      '-e',
      'MYSQL_PWD',
      names.database,
      'mariadb-dump',
      '-uroot',
      '--lock-all-tables',
      '--routines',
      '--events',
      '--triggers',
      '--hex-blob',
      '--databases',
      'piwigo',
    ],
    { encoding: 'buffer' },
  );
  const dumpPath = join(directory, 'piwigo.sql');
  writeFileSync(dumpPath, dump, { mode: 0o600 });
  const database = identity(names.database);
  stopped(names.database);

  phase = 'isolated read-only restore';
  run([
    'run',
    '-d',
    '--name',
    names.restore,
    '--restart=no',
    ...labels,
    '-p',
    '127.0.0.1::3306',
    '-e',
    'MARIADB_ROOT_PASSWORD',
    databaseImage,
  ]);
  await waitDatabase(names.restore);
  sql(names.restore, dump);
  sql(
    names.restore,
    [
      `CREATE USER 'fl_reader'@'%' IDENTIFIED BY '${readerPassword}';`,
      `GRANT SELECT, LOCK TABLES, TRIGGER, EVENT, SHOW VIEW, SHOW CREATE ROUTINE ON *.* TO 'fl_reader'@'%';`,
      'SET GLOBAL read_only=1;',
    ].join('\n'),
  );
  assert.equal(sql(names.restore, 'SELECT @@global.read_only, VERSION();'), `1\t${fixture.runtime.databaseVersion}`);
  const restore = {
    container: identity(names.restore),
    host: '127.0.0.1',
    port: loopbackPort(names.restore, 3306),
    user: 'fl_reader',
    password: readerPassword,
    database: 'piwigo',
  };

  const config = join(directory, 'test.json');
  writeFileSync(
    config,
    JSON.stringify({
      containers: { app, database },
      restore,
      dumpPath,
      dumpSha256: digest(dump),
      databaseDirectory,
      sourceRoot,
      stagingRoot: directory,
      sourceUserId: '1',
      username: adminName,
      password: adminPassword,
      album: { ...album, imageIds: seeds.map((seed) => seed.imageId) },
      seeds,
    }),
    { mode: 0o600 },
  );
  phase = 'native source-to-destination import';
  const acceptance = spawnSync(
    'pnpm',
    [
      '--dir',
      'server',
      'exec',
      'vitest',
      'run',
      '--config',
      'test/vitest.config.medium.mjs',
      'test/medium/specs/repositories/library-import-lifecycle.spec.ts',
      '--testNamePattern=native-piwigo',
      '--maxWorkers=1',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        FRAMELEAF_NATIVE_IMPORT_SOURCE: 'piwigo',
        FRAMELEAF_NATIVE_IMPORT_CONFIG: config,
        FRAMELEAF_NATIVE_IMPORT_RUN_ID: runId,
      },
    },
  );
  assert.equal(acceptance.status, 0);
  console.log('Native Piwigo source-to-destination import passed');
} catch (error) {
  failure = true;
  console.error('Piwigo native qualification failed during: ' + phase);
  if (process.env.FRAMELEAF_QUALIFICATION_DEBUG === '1')
    console.error(
      String(error?.stack ?? error)
        .replaceAll(adminPassword, '***')
        .replaceAll(readerPassword, '***'),
    );
} finally {
  try {
    cleanupQualification(runId);
  } catch {
    failure = true;
    console.error('Piwigo qualification cleanup failed');
  }
}
if (failure) process.exitCode = 1;
