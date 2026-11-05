// eslint-disable-next-line unicorn/name-replacements -- the qualification family names this script.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chownSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  cleanupQualification,
  hasQualificationImage,
  qualificationImage as image,
} from './cleanup-lychee-qualification.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID;
if (!/^\d+-\d+$/u.test(runId ?? '') || path.basename(tmpdir()) !== `frameleaf-lychee-${runId}`)
  throw new Error('Invalid qualification cleanup scope');
const directory = mkdtempSync(path.join(tmpdir(), 'application-'));
const database = path.join(directory, 'database'),
  uploads = path.join(directory, 'uploads');
// The pinned image drops privileges to its www-data account (uid/gid 33) for the database and uploads disk.
const lycheeAccount = 33;
for (const path of [database, uploads]) {
  mkdirSync(path, { mode: 0o700 });
  chownSync(path, lycheeAccount, lycheeAccount);
}
const databasePath = path.join(database, 'database.sqlite');
writeFileSync(databasePath, '', { mode: 0o600 });
chownSync(databasePath, lycheeAccount, lycheeAccount);
const container = `frameleaf-lychee-app-${runId}`;
const username = 'fixture_admin';
const password = randomBytes(32).toString('hex');
const command = (arguments_, options = {}) =>
  spawnSync('docker', arguments_, { cwd: root, encoding: 'utf8', timeout: 600_000, ...options });
const run = (arguments_, options) => {
  const result = command(arguments_, options);
  if (result.status !== 0) throw new Error(`Fixture Docker operation failed: ${arguments_[0]}`);
  return result.stdout.trim();
};
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
let phase = 'initialization';
let hasFailed = false;
try {
  writeFileSync(
    path.join(tmpdir(), 'application-image.json'),
    JSON.stringify({ createdImage: !hasQualificationImage(run) }),
    {
      mode: 0o600,
    },
  );
  const seeds = [];
  for (const [name, color] of [
    ['blue', '#2850c8'],
    ['green', '#28b050'],
  ]) {
    const bytes = await sharp({ create: { width: 640, height: 480, channels: 3, background: color } })
      .png()
      .toBuffer();
    seeds.push({
      name,
      bytes,
      size: String(bytes.length),
      sha256: digest('sha256', bytes),
      sha1: digest('sha1', bytes),
      title: `Native ${name} title`,
      caption: `Native ${name} caption`,
      favorite: name === 'blue',
      rating: name === 'blue' ? 4 : 2,
    });
  }
  const environment = path.join(directory, 'application.env');
  writeFileSync(
    environment,
    [
      `APP_KEY=base64:${randomBytes(32).toString('base64')}`,
      'APP_ENV=production',
      'APP_URL=http://127.0.0.1',
      'DB_CONNECTION=sqlite',
      'DB_DATABASE=/lychee-db/database.sqlite',
      'LOG_CHANNEL=stderr',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  phase = 'application startup';
  run([
    'run',
    '-d',
    '--name',
    container,
    '--restart=no',
    '--label',
    'app.frameleaf.qualification-family=lychee',
    '--label',
    `app.frameleaf.qualification-run=${runId}`,
    '--env-file',
    environment,
    '-p',
    '127.0.0.1::8000',
    '--mount',
    `type=bind,source=${database},target=/lychee-db`,
    '--mount',
    `type=bind,source=${uploads},target=/app/public/uploads`,
    image,
  ]);
  const port = Number(run(['port', container, '8000']).match(/^127\.0\.0\.1:(\d+)$/mu)?.[1]);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535, 'Invalid fixture loopback port');
  const origin = `http://127.0.0.1:${port}`;
  let isReady = false;
  for (let attempt = 0; !isReady && attempt < 180; attempt++) {
    try {
      // Before an administrator exists the application redirects every page to its installer.
      const response = await fetch(origin + '/', { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      isReady =
        response.status === 307 &&
        new URL(response.headers.get('location') ?? '', origin).pathname === '/install/admin';
    } catch {
      // The listener is unavailable until migrations and caches complete.
    }
    if (isReady) continue;
    if (run(['inspect', '--format', '{{.State.Running}}', container]) !== 'true')
      throw new Error('Fixture application stopped during initialization');
    await setTimeout(1000);
  }
  if (!isReady) throw new Error('Fixture application initialization timed out');

  phase = 'native administrator bootstrap';
  // The image's own bootstrap command; the password travels through the exec environment, never argv.
  run(
    [
      'exec',
      '--user',
      'www-data',
      '-e',
      'LYCHEE_FIXTURE_PASSWORD',
      container,
      'sh',
      '-c',
      `php artisan lychee:create_user ${username} "$LYCHEE_FIXTURE_PASSWORD"`,
    ],
    { env: { ...process.env, LYCHEE_FIXTURE_PASSWORD: password } },
  );

  const session = () => {
    const jar = new Map();
    const store = (response) => {
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';', 1);
        const index = pair.indexOf('=');
        jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
    };
    const request = async (method, path, body) => {
      const isForm = body instanceof FormData;
      const response = await fetch(origin + '/api/v2/' + path, {
        method,
        headers: {
          accept: 'application/json',
          // The API's content-type middleware also applies to body-less JSON reads.
          ...(!isForm && { 'content-type': 'application/json' }),
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
          'x-xsrf-token': decodeURIComponent(jar.get('XSRF-TOKEN') ?? ''),
        },
        body: isForm || body === undefined ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      store(response);
      const text = await response.text();
      let value = text;
      try {
        value = text ? JSON.parse(text) : undefined;
      } catch {
        // Some endpoints answer with a bare identifier.
      }
      return { status: response.status, value };
    };
    return {
      async open() {
        const response = await fetch(origin + '/', { signal: AbortSignal.timeout(10_000) });
        await response.body?.cancel();
        store(response);
        if (!jar.has('XSRF-TOKEN')) throw new Error('Native session cookie missing');
      },
      request,
      async api(method, path, body) {
        const result = await request(method, path, body);
        if (result.status < 200 || result.status > 299)
          throw new Error(`Native fixture API refused ${method} ${path}: HTTP ${result.status}`);
        return result.value;
      },
    };
  };
  phase = 'native login';
  const admin = session();
  await admin.open();
  const login = await admin.request('POST', 'Auth::login', { username, password });
  assert.equal(login.status, 204);
  const user = await admin.api('GET', 'Auth::user');
  assert.equal(user.id, 1);
  assert.equal(user.username, username);
  assert.equal(user.may_administrate, true);
  assert.equal(user.is_ldap, false);
  const intruder = session();
  await intruder.open();
  const rejected = await intruder.request('POST', 'Auth::login', { username, password: 'wrong-' + password });
  assert.ok(rejected.status >= 400 && rejected.status < 500, 'Native source accepted the wrong password');

  phase = 'native private album';
  const album = { name: 'Native private album', description: 'Manually organized' };
  // eslint-disable-next-line unicorn/no-null -- a top-level album has an explicit null parent.
  album.id = await admin.api('POST', 'Album', { parent_id: null, title: album.name });
  assert.match(album.id, /^[\w-]{24}$/u);
  /* eslint-disable unicorn/no-null -- Lychee requires these optional album settings as explicit JSON nulls. */
  await admin.api('PATCH', 'Album', {
    album_id: album.id,
    title: album.name,
    license: 'none',
    description: album.description,
    photo_sorting_column: null,
    photo_sorting_order: null,
    album_sorting_column: null,
    album_sorting_order: null,
    album_aspect_ratio: null,
    photo_layout: null,
    copyright: null,
    is_compact: false,
    is_map_header: false,
    is_pinned: false,
    header_id: null,
    cover_id: null,
    album_timeline: null,
    photo_timeline: null,
  });
  /* eslint-enable unicorn/no-null */

  phase = 'native uploads';
  for (const seed of seeds) {
    const form = new FormData();
    form.append('album_id', album.id);
    form.append('file_last_modified_time', String(Date.parse('2020-06-11T00:00:00Z')));
    form.append('file_name', `${seed.name}.png`);
    form.append('uuid_name', '');
    form.append('extension', '');
    form.append('chunk_number', '1');
    form.append('total_chunks', '1');
    form.append('file', new Blob([seed.bytes], { type: 'image/png' }), `${seed.name}.png`);
    const uploaded = await admin.api('POST', 'Photo', form);
    assert.equal(uploaded.stage, 'done');
  }
  let listed = [];
  for (let attempt = 0; attempt < 60 && listed.length !== seeds.length; attempt++) {
    const page = await admin.api('GET', `Album::photos?album_id=${encodeURIComponent(album.id)}`);
    listed = page.photos;
    if (listed.length !== seeds.length) await setTimeout(1000);
  }
  assert.equal(listed.length, seeds.length, 'Native upload inventory changed');

  phase = 'native manual photo edits';
  const photos = [];
  for (const seed of seeds) {
    const photo = listed.find((item) => item.original_checksum === seed.sha1);
    assert.ok(photo && photos.every((item) => item.id !== photo.id), 'Native photo identity changed');
    phase = 'native original-byte readback';
    const original = await fetch(origin + new URL(photo.size_variants.original.url).pathname, {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(original.status, 200);
    const downloaded = Buffer.from(await original.arrayBuffer());
    assert.equal(digest('sha256', downloaded), seed.sha256);
    phase = 'native manual photo edits';
    await admin.api('PATCH', 'Photo', {
      photo_id: photo.id,
      title: seed.title,
      description: seed.caption,
      tags: [],
      license: 'none',
      upload_date: photo.created_at,
      taken_at: '2020-06-10T12:30:00-06:00',
      from_id: album.id,
    });
    if (seed.favorite) await admin.api('POST', 'Photo::highlight', { photo_ids: [photo.id], is_highlighted: true });
    const rated = await admin.api('POST', 'Photo::setRating', { photo_id: photo.id, rating: seed.rating });
    assert.equal(rated.id, photo.id);
    assert.equal(rated.title, seed.title);
    assert.equal(rated.description, seed.caption);
    assert.equal(rated.is_highlighted, seed.favorite);
    photos.push({ id: photo.id, seed });
  }

  phase = 'stopped source capture';
  const containerId = run(['inspect', '--format', '{{.Id}}', container]);
  const imageId = run(['inspect', '--format', '{{.Image}}', container]);
  run(['stop', '--time', '30', container]);
  assert.equal(
    run(['inspect', '--format', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}', container]),
    'false no',
  );
  phase = 'stopped source readback';
  const source = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
  const expected = [];
  try {
    source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    assert.equal(source.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    const stored = source.prepare('SELECT title,description FROM base_albums WHERE id=?').get(album.id);
    assert.deepEqual({ ...stored }, { title: album.name, description: album.description });
    for (const { id, seed } of photos) {
      const row = source
        .prepare(
          `SELECT p.owner_id,p.title,p.description,p.is_highlighted,p.taken_at,p.taken_at_orig_tz,
             v.short_path,v.filesize,v.storage_disk,r.rating
           FROM photos p JOIN size_variants v ON v.photo_id=p.id AND v.type=1
           LEFT JOIN photo_ratings r ON r.photo_id=p.id AND r.user_id=p.owner_id WHERE p.id=?`,
        )
        .get(id);
      assert.equal(row.owner_id, 1);
      assert.equal(row.title, seed.title);
      assert.equal(row.description, seed.caption);
      assert.equal(row.is_highlighted, seed.favorite ? 1 : 0);
      assert.equal(row.rating, seed.rating);
      assert.equal(row.taken_at, '2020-06-10 18:30:00.000000');
      assert.equal(row.taken_at_orig_tz, '-06:00');
      assert.equal(row.storage_disk, 'images');
      assert.equal(String(row.filesize), seed.size);
      expected.push({
        id,
        name: seed.name,
        path: row.short_path,
        sha256: seed.sha256,
        bytes: seed.size,
        title: seed.title,
        caption: seed.caption,
        favorite: seed.favorite,
        rating: seed.rating,
        takenAt: '2020-06-10T18:30:00.000Z',
        localDateTime: '2020-06-10T12:30:00.000Z',
      });
    }
  } finally {
    source.close();
  }
  const config = path.join(directory, 'test.json');
  writeFileSync(
    config,
    JSON.stringify({
      containers: [{ id: containerId, image: imageId, name: container }],
      databasePath,
      uploadsRoot: uploads,
      sourceUserId: String(user.id),
      username,
      password,
      album,
      photos: expected,
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
      '--testNamePattern=native-lychee',
      '--maxWorkers=1',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        FRAMELEAF_NATIVE_IMPORT_SOURCE: 'lychee',
        FRAMELEAF_NATIVE_IMPORT_CONFIG: config,
        FRAMELEAF_NATIVE_IMPORT_RUN_ID: runId,
      },
    },
  );
  assert.equal(acceptance.status, 0, 'Native common import acceptance failed');
  console.log('Native Lychee application import qualification passed');
} catch (error) {
  hasFailed = true;
  // Fixture errors carry only synthetic values; credentials never enter an assertion or error message.
  console.error(
    `Lychee native qualification failed during: ${phase}: ${error instanceof Error ? error.message : 'unknown'}`,
  );
} finally {
  try {
    cleanupQualification(runId);
  } catch {
    hasFailed = true;
    console.error('Lychee qualification cleanup failed');
  }
}
if (hasFailed) process.exitCode = 1;
