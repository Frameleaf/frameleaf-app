// Native LibrePhotos 1.5.1 qualification on its official PostgreSQL deployment: the unified application and its
// pinned PostgreSQL run on a private network, are seeded through the application's own API and CLI, then the
// application is stopped while the database stays up (restart disabled) for the read-only snapshot reader.
// eslint-disable-next-line unicorn/name-replacements -- the qualification contract fixes this script's filename
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { appImage, cleanupQualification, databaseImage, hasImage } from './cleanup-librephotos-qualification.mjs';

const family = 'librephotos';
const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID;
if (!/^\d+-\d+$/u.test(runId ?? '') || path.basename(tmpdir()) !== `frameleaf-${family}-${runId}`)
  throw new Error('Invalid qualification cleanup scope');
const directory = mkdtempSync(path.join(tmpdir(), 'application-'));
const originals = path.join(directory, 'originals'),
  media = path.join(directory, 'protected_media'),
  logs = path.join(directory, 'logs');
for (const folder of [originals, media, logs]) mkdirSync(folder, { mode: 0o700 });
const names = {
  network: `frameleaf-${family}-net-${runId}`,
  volume: `frameleaf-${family}-db-${runId}`,
  database: `frameleaf-${family}-db-${runId}`,
  app: `frameleaf-${family}-app-${runId}`,
};
const labels = [
  '--label',
  `app.frameleaf.qualification-family=${family}`,
  '--label',
  `app.frameleaf.qualification-run=${runId}`,
];
const database = { name: 'librephotos', user: 'librephotos', reader: 'frameleaf_reader' };
const secrets = {
  admin: randomBytes(32).toString('hex'),
  database: randomBytes(32).toString('hex'),
  reader: randomBytes(32).toString('hex'),
  django: randomBytes(48).toString('hex'),
};
const command = (arguments_, options = {}) =>
  spawnSync('docker', arguments_, {
    cwd: root,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
const run = (arguments_, options) => {
  const result = command(arguments_, options);
  if (result.status !== 0) throw new Error(`Fixture Docker operation failed: ${arguments_[0]}`);
  return result.stdout.trim();
};
const state = (container) =>
  run(['inspect', '--format', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}', container]);
const port = (container, inner) => {
  const value = Number(run(['port', container, inner]).match(/^127\.0\.0\.1:(\d+)$/mu)?.[1]);
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 65_535, 'Invalid fixture loopback port');
  return value;
};
const until = async (label, check, containers = [names.database, names.app]) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    for (const container of containers)
      if (state(container) !== 'true no') throw new Error(`Fixture ${label}: a source service stopped`);
    await setTimeout(2000);
  }
  throw new Error(`Fixture ${label} timed out`);
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let phase = 'initialization';
let hasFailed = false;
try {
  writeFileSync(
    path.join(tmpdir(), 'application-image.json'),
    JSON.stringify({
      application: !hasImage(run, appImage),
      database: !hasImage(run, databaseImage),
    }),
    { mode: 0o600 },
  );
  phase = 'synthetic originals';
  const seeds = [];
  mkdirSync(path.join(originals, 'camera'), { mode: 0o755 });
  for (const [name, color, favorite] of [
    ['blue', '#2850c8', true],
    ['green', '#28b050', false],
  ]) {
    // A recorded capture offset gives the source an exact instant (2020-06-10T18:30:00Z) and wall clock.
    const bytes = await sharp({ create: { width: 512, height: 384, channels: 3, background: color } })
      .withExif({
        IFD0: { Make: 'Frameleaf', Model: 'Synthetic' },
        IFD2: { DateTimeOriginal: '2020:06:10 12:30:00', OffsetTimeOriginal: '-06:00' },
      })
      .jpeg()
      .toBuffer();
    const relative = `camera/${name}.jpg`;
    writeFileSync(path.join(originals, relative), bytes, { mode: 0o644 });
    seeds.push({
      name,
      path: relative,
      sha256: digest(bytes),
      bytes: String(bytes.length),
      caption: `Native ${name} caption`,
      favorite,
    });
  }
  phase = 'private network and database startup';
  run(['network', 'create', ...labels, names.network]);
  run(['volume', 'create', ...labels, names.volume]);
  const databaseEnvironment = path.join(directory, 'database.env');
  writeFileSync(
    databaseEnvironment,
    [
      `POSTGRES_USER=${database.user}`,
      `POSTGRES_PASSWORD=${secrets.database}`,
      `POSTGRES_DB=${database.name}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  run([
    'run',
    '-d',
    '--name',
    names.database,
    '--restart=no',
    ...labels,
    '--network',
    names.network,
    '--network-alias',
    'db',
    '--env-file',
    databaseEnvironment,
    '--mount',
    `type=volume,source=${names.volume},target=/var/lib/postgresql`,
    '-p',
    '127.0.0.1::5432',
    databaseImage,
  ]);
  const psql = (sql, variables = {}) =>
    run(
      [
        'exec',
        '-i',
        ...Object.keys(variables).flatMap((name) => ['-e', name]),
        names.database,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-X',
        '-qAt',
        '-U',
        database.user,
        '-d',
        database.name,
      ],
      { input: sql, env: { ...process.env, ...variables } },
    );
  await until(
    'database startup',
    () => command(['exec', names.database, 'pg_isready', '-U', database.user]).status === 0,
    [names.database],
  );
  phase = 'application startup';
  const appEnvironment = path.join(directory, 'application.env');
  writeFileSync(
    appEnvironment,
    [
      // The unified image's documented settings with its PostgreSQL backend.
      'SERVE_FRONTEND=true',
      'DB_BACKEND=postgresql',
      `DB_NAME=${database.name}`,
      `DB_USER=${database.user}`,
      `DB_PASS=${secrets.database}`,
      'DB_HOST=db',
      'DB_PORT=5432',
      `SECRET_KEY=${secrets.django}`,
      'ADMIN_USERNAME=fixture_admin',
      'ADMIN_EMAIL=admin@example.test',
      `ADMIN_PASSWORD=${secrets.admin}`,
      'UPDATE_CHECK=false',
      'WEB_CONCURRENCY=1',
      'FEATURE_PROCESS_EMBEDDED_MEDIA=false',
      'FEATURE_VIDEO=false',
      'FEATURE_VIDEO_PREVIEWS=false',
      'FEATURE_FACE_DETECTION=false',
      'FEATURE_FACE_DETECTION_IN_VIDEOS=false',
      'FEATURE_FACE_CLUSTER=false',
      'FEATURE_IMAGE_CAPTIONING=false',
      'FEATURE_REVERSE_GEOCODING=false',
      'FEATURE_SCENE_CLASSIFICATION=false',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  run([
    'run',
    '-d',
    '--name',
    names.app,
    '--restart=no',
    ...labels,
    '--network',
    names.network,
    '--env-file',
    appEnvironment,
    '--mount',
    `type=bind,source=${originals},target=/data,readonly`,
    '--mount',
    `type=bind,source=${media},target=/protected_media`,
    '--mount',
    `type=bind,source=${logs},target=/logs`,
    '-p',
    '127.0.0.1::8001',
    appImage,
  ]);
  const origin = `http://127.0.0.1:${port(names.app, '8001')}`;
  const login = (password) =>
    fetch(origin + '/api/auth/token/obtain/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fixture_admin', password }),
      signal: AbortSignal.timeout(20_000),
    });
  // The startup page answers 503 until migrations, createadmin and the application server have finished.
  let token;
  await until('application startup', async () => {
    try {
      const response = await login(secrets.admin);
      if (response.status !== 200) {
        await response.body?.cancel();
        return false;
      }
      const issued = await response.json();
      token = issued.access;
      return typeof token === 'string';
    } catch {
      return false;
    }
  });
  const claims = JSON.parse(Buffer.from(token.split('.', 2)[1], 'base64url').toString('utf8'));
  assert.equal(claims.name, 'fixture_admin');
  assert.equal(claims.is_admin, true);
  const sourceUserId = String(claims.user_id);
  assert.match(sourceUserId, /^[1-9]\d*$/u);
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(origin + route, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Native fixture API refused ${method} (HTTP ${response.status})`);
    }
    return response.json();
  };
  const settled = async (label) =>
    until(label, async () => {
      const { results: jobs } = await request('/api/jobs/');
      return jobs.length > 0 && jobs.every((job) => job.finished || job.failed || job.cancelled);
    });

  phase = 'native library scan';
  const scanned = await request(`/api/manage/user/${sourceUserId}/`, 'PATCH', { scan_directory: '/data' });
  assert.equal(scanned.scan_directory, '/data');
  assert.equal(scanned.save_metadata_to_disk, 'OFF', 'Source edits must not rewrite originals');
  const scan = await request('/api/scanphotos/', 'POST');
  assert.equal(scan.status, true);
  await settled('library scan');
  const { results: jobs } = await request('/api/jobs/');
  assert.ok(
    jobs.some((job) => job.job_type_str === 'Scan Photos' && job.finished && !job.failed),
    'Native scan did not finish',
  );

  phase = 'native photo inventory and original readback';
  const { results: indexed } = await request('/api/photos/recentlyadded/');
  assert.equal(indexed.length, seeds.length);
  const photos = [];
  for (const photo of indexed) {
    assert.match(photo.id, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u);
    assert.equal(String(photo.owner.id), sourceUserId);
    const detail = await request(`/api/photos/${photo.image_hash}/`);
    assert.equal(detail.image_path.length, 1);
    const seed = seeds.find((item) => detail.image_path[0] === '/data/' + item.path);
    assert.ok(seed && photos.every((item) => item.path !== seed.path), 'Native photo did not map to one seed');
    const download = await fetch(origin + `/api/photos/${photo.image_hash}/file/${photo.image_hash}/`, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(download.status, 200);
    const original = Buffer.from(await download.arrayBuffer());
    assert.equal(digest(original), seed.sha256, 'Native original readback changed');
    const anonymous = await fetch(origin + `/api/photos/${photo.image_hash}/file/${photo.image_hash}/`, {
      signal: AbortSignal.timeout(30_000),
    });
    await anonymous.body?.cancel();
    assert.equal(anonymous.status, 401, 'Native original must refuse anonymous access');
    assert.equal(detail.exif_timestamp_offset, -360);
    photos.push({ ...seed, photoId: photo.id, imageHash: photo.image_hash });
  }

  phase = 'native manual edits';
  for (const photo of photos) {
    const saved = await request('/api/photosedit/savecaption/', 'POST', {
      image_hash: photo.imageHash,
      caption: photo.caption,
    });
    assert.equal(saved.status, true);
  }
  const favourites = photos.filter((photo) => photo.favorite).map((photo) => photo.imageHash);
  const favourited = await request('/api/photosedit/favorite/', 'POST', { image_hashes: favourites, favorite: true });
  assert.deepEqual(favourited.updated_hashes, favourites);
  for (const photo of photos) {
    const detail = await request(`/api/photos/${photo.imageHash}/`);
    assert.equal(detail.captions_json?.user_caption, photo.caption);
    photo.rating = detail.rating;
    assert.equal(detail.rating >= 4, photo.favorite, 'Native favourite readback changed');
    assert.equal(detail.hidden || detail.archived || detail.in_trashcan || detail.removed, false);
  }
  phase = 'native album';
  const albumName = 'Native album';
  const created = await request('/api/albums/user/edit/', 'POST', {
    title: albumName,
    photos: photos.map((photo) => photo.photoId),
  });
  const album = await request(`/api/albums/user/${created.id}/`);
  assert.equal(album.title, albumName);
  await settled('edit jobs');

  phase = 'native credential';
  const refused = await login('wrong-' + secrets.admin);
  await refused.body?.cancel();
  assert.equal(refused.status, 401, 'Native source accepted the wrong password');
  // LibrePhotos 1.5.1 stores passwords with Django's default Argon2 hasher; the import must preserve that format.
  // Confirm it with Django's own verifier, read-only (a login could rehash it).
  const hasher = run(
    [
      'exec',
      '-e',
      'FRAMELEAF_FIXTURE_PASSWORD',
      names.app,
      'python',
      'manage.py',
      'shell',
      '-c',
      [
        'import os',
        'from api.models import User',
        'from django.contrib.auth.hashers import check_password',
        "secret = os.environ['FRAMELEAF_FIXTURE_PASSWORD']",
        `user = User.objects.get(pk=${Number(sourceUserId)})`,
        "print('FRAMELEAF', user.password.split('$', 1)[0], check_password(secret, user.password), check_password('wrong-' + secret, user.password))",
      ].join('\n'),
    ],
    { env: { ...process.env, FRAMELEAF_FIXTURE_PASSWORD: secrets.admin } },
  );
  assert.equal(
    hasher.split('\n').findLast((line) => line.startsWith('FRAMELEAF ')),
    'FRAMELEAF argon2 True False',
  );

  phase = 'application stop';
  const appId = run(['inspect', '--format', '{{.Id}}', names.app]);
  const appImageId = run(['inspect', '--format', '{{.Image}}', names.app]);
  run(['stop', '--time', '30', names.app]);
  assert.equal(state(names.app), 'false no');

  phase = 'read-only source role';
  // A non-owner login with SELECT only; the reader refuses elevated or writable roles and other clients.
  psql(
    [
      String.raw`\getenv reader_password FRAMELEAF_READER_PASSWORD`,
      `CREATE ROLE ${database.reader} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'reader_password';`,
      `GRANT CONNECT ON DATABASE ${database.name} TO ${database.reader};`,
      `GRANT USAGE ON SCHEMA public TO ${database.reader};`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${database.reader};`,
      '',
    ].join('\n'),
    { FRAMELEAF_READER_PASSWORD: secrets.reader },
  );
  assert.equal(
    psql(
      "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
    ),
    '0',
  );
  const dumped = command(
    // pg_dump 18 writes a random psql \restrict key unless one is given; a fixed key keeps the dump deterministic.
    [
      'exec',
      names.database,
      'pg_dump',
      '-U',
      database.user,
      '-d',
      database.name,
      '--no-password',
      '--restrict-key=frameleafLibrephotosQualification',
    ],
    {
      encoding: 'buffer',
    },
  );
  assert.equal(dumped.status, 0, 'Native database dump failed');
  const dump = digest(dumped.stdout);
  const databasePort = port(names.database, '5432');
  const config = path.join(directory, 'test.json');
  writeFileSync(
    config,
    JSON.stringify({
      application: { id: appId, image: appImageId, name: names.app },
      database: {
        id: run(['inspect', '--format', '{{.Id}}', names.database]),
        image: run(['inspect', '--format', '{{.Image}}', names.database]),
        name: names.database,
        user: database.user,
        database: database.name,
        dumpSha256: dump,
        url: `postgres://${database.reader}:${secrets.reader}@127.0.0.1:${databasePort}/${database.name}`,
      },
      sourceRoot: originals,
      containerSourceRoot: '/data',
      sourceUserId,
      password: secrets.admin,
      photos,
      album: { name: albumName, photoIds: photos.map((photo) => photo.photoId) },
      capture: { takenAt: '2020-06-10T18:30:00.000Z', localDateTime: '2020-06-10T12:30:00.000Z' },
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
      `--testNamePattern=native-${family}`,
      '--maxWorkers=1',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        FRAMELEAF_NATIVE_IMPORT_SOURCE: family,
        FRAMELEAF_NATIVE_IMPORT_CONFIG: config,
        FRAMELEAF_NATIVE_IMPORT_RUN_ID: runId,
      },
    },
  );
  assert.equal(acceptance.status, 0, 'Native common import acceptance failed');
  console.log('Native LibrePhotos PostgreSQL import qualification passed');
} catch (error) {
  hasFailed = true;
  console.error(`LibrePhotos native qualification failed during: ${phase}`);
  if (error instanceof assert.AssertionError || /^(Native|Fixture)/u.test(error?.message ?? ''))
    console.error(error.message);
} finally {
  try {
    cleanupQualification(runId);
  } catch {
    hasFailed = true;
    console.error('LibrePhotos qualification cleanup failed');
  }
}
if (hasFailed) process.exitCode = 1;
