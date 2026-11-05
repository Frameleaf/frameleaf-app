/* eslint-disable unicorn/name-replacements -- the qualification harness fixes this script's file name */
// Native PiGallery2 3.5.2 (SQLite) qualification: start the pinned image, seed a folder album through its own
// indexer and user API, stop it, then import its stopped database through the common command.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  cleanupQualification,
  hasQualificationImage,
  qualificationImage as image,
} from './cleanup-pigallery2-qualification.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID;
if (!/^\d+-\d+$/u.test(runId ?? '') || path.basename(tmpdir()) !== `frameleaf-pigallery2-${runId}`)
  throw new Error('Invalid qualification cleanup scope');
const directory = mkdtempSync(path.join(tmpdir(), 'application-'));
const database = path.join(directory, 'db'),
  config = path.join(directory, 'config'),
  originals = path.join(directory, 'originals');
for (const path of [database, config, originals]) mkdirSync(path, { mode: 0o700 });
const name = `frameleaf-pigallery2-${runId}`;
const run = (parameters) => {
  const result = spawnSync('docker', parameters, { cwd: root, encoding: 'utf8', timeout: 600_000 });
  if (result.status !== 0) throw new Error('Fixture Docker operation failed');
  return result.stdout.trim();
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const xmp = (description, rating) =>
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${rating}">` +
  (description
    ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${description}</rdf:li></rdf:Alt></dc:description>`
    : '') +
  '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
let phase = 'initialization';
let isFailed = false;
try {
  const hadImage = hasQualificationImage(run);
  writeFileSync(path.join(tmpdir(), 'image.json'), JSON.stringify({ createdImage: !hadImage }), { mode: 0o600 });
  // One folder album; one caption is embedded EXIF with an embedded XMP rating, the other comes from an XMP sidecar.
  const album = 'Trip';
  mkdirSync(path.join(originals, album), { mode: 0o755 });
  const seeds = [
    {
      path: `${album}/harbour.jpg`,
      color: '#2850c8',
      exif: { IFD0: { ImageDescription: 'Harbour at dawn' } },
      clock: ['2024:05:06 07:08:09', '-06:00'],
      embedded: xmp(undefined, 5),
      caption: 'Harbour at dawn',
      rating: 5,
      takenAt: '2024-05-06T13:08:09.000Z',
      localDateTime: '2024-05-06T07:08:09.000Z',
      offsetMinutes: -360,
    },
    {
      path: `${album}/meadow.jpg`,
      color: '#28b050',
      exif: {},
      clock: ['2024:05:07 10:11:12', '+02:00'],
      sidecar: xmp('Meadow at noon', 4),
      caption: 'Meadow at noon',
      rating: 4,
      takenAt: '2024-05-07T08:11:12.000Z',
      localDateTime: '2024-05-07T10:11:12.000Z',
      offsetMinutes: 120,
    },
  ];
  const sidecars = [];
  for (const seed of seeds) {
    let pipeline = sharp({ create: { width: 640, height: 480, channels: 3, background: seed.color } })
      .jpeg()
      .withExif({ ...seed.exif, IFD2: { DateTimeOriginal: seed.clock[0], OffsetTimeOriginal: seed.clock[1] } });
    if (seed.embedded) pipeline = pipeline.withXmp(seed.embedded);
    const bytes = await pipeline.toBuffer();
    writeFileSync(path.join(originals, seed.path), bytes, { mode: 0o644 });
    Object.assign(seed, { bytes: String(bytes.length), sha256: digest(bytes) });
    if (seed.sidecar) {
      const content = Buffer.from(seed.sidecar);
      writeFileSync(path.join(originals, seed.path + '.xmp'), content, { mode: 0o644 });
      sidecars.push({ path: seed.path + '.xmp', bytes: String(content.length), sha256: digest(content) });
    }
    delete seed.color;
    delete seed.exif;
    delete seed.embedded;
    delete seed.sidecar;
  }
  phase = 'native startup';
  run([
    'run',
    '-d',
    '--name',
    name,
    '--restart=no',
    '--label',
    'app.frameleaf.qualification-family=pigallery2',
    '--label',
    `app.frameleaf.qualification-run=${runId}`,
    '--mount',
    `type=bind,source=${database},target=/app/data/db`,
    '--mount',
    `type=bind,source=${config},target=/app/data/config`,
    '--mount',
    `type=bind,source=${originals},target=/app/data/images,readonly`,
    '--tmpfs',
    '/app/data/tmp:rw,nosuid,size=256m',
    '-p',
    '127.0.0.1::80',
    image,
  ]);
  const container = {
    id: run(['inspect', '--format', '{{.Id}}', name]),
    image: run(['inspect', '--format', '{{.Image}}', name]),
    name,
  };
  assert.equal(container.image, image.split('@', 2)[1]);
  const port = Number(run(['port', name, '80']).match(/^127\.0\.0\.1:(\d+)$/mu)?.[1]);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535);
  const origin = `http://127.0.0.1:${port}`;
  const request = async (method, path, { cookie, body } = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: { ...(body && { 'content-type': 'application/json' }), ...(cookie && { cookie }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return response;
  };
  const api = async (method, path, options) => {
    const response = await request(method, '/pgapi' + path, options);
    if (!response.ok) throw new Error('Fixture PiGallery2 HTTP failure');
    const result = await response.json();
    if (result.error) throw new Error('Fixture PiGallery2 refused request');
    return result.result;
  };
  const until = async (check) => {
    for (let attempt = 0; attempt < 240; attempt++) {
      let isReady;
      try {
        isReady = await check();
      } catch {
        isReady = false;
      }
      if (isReady) return;
      if (run(['inspect', '--format', '{{.State.Running}}', name]) !== 'true')
        throw new Error('Fixture application stopped');
      await setTimeout(500);
    }
    throw new Error('Fixture application did not settle');
  };
  await until(async () => {
    const response = await request('GET', '/heartbeat');
    return response.ok;
  });
  const login = async (username, password) => {
    const response = await request('POST', '/pgapi/user/login', {
      body: { loginCredential: { username, password, rememberMe: false } },
    });
    if (!response.ok) return;
    const result = await response.json();
    if (result.error) return;
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');
    return { user: result.result, cookie };
  };
  phase = 'native owner account';
  // A fresh installation only has the dummy admin/admin account; replace it with a generated administrator.
  const dummy = await login('admin', 'admin');
  assert.ok(dummy);
  const username = 'fixture_owner';
  const password = randomBytes(32).toString('hex');
  await api('PUT', '/user', { cookie: dummy.cookie, body: { newUser: { name: username, password, role: 4 } } });
  const owner = await login(username, password);
  assert.ok(owner && owner.user.name === username && owner.user.role === 4);
  await api('DELETE', `/user/${dummy.user.id}`, { cookie: owner.cookie });
  assert.equal(await login('admin', 'admin'), undefined);
  const users = await api('GET', '/user/list', { cookie: owner.cookie });
  assert.deepEqual(
    users.map((user) => [user.id, user.name, user.role]),
    [[owner.user.id, username, 4]],
  );
  phase = 'native indexing';
  await api('POST', '/admin/jobs/scheduled/Indexing/start', {
    cookie: owner.cookie,
    body: { config: { indexChangesOnly: false }, soloRun: true, allowParallelRun: false },
  });
  await until(async () => {
    const progress = Object.values(await api('GET', '/admin/jobs/scheduled/progress', { cookie: owner.cookie }));
    return progress.some((job) => job.jobName === 'Indexing' && job.state === 5);
  });
  let listing;
  await until(async () => {
    const content = await api('GET', `/gallery/content/${album}`, { cookie: owner.cookie });
    listing = content.directory;
    return listing.media?.length === seeds.length;
  });
  phase = 'native metadata and original-download inventory';
  const inventory = [];
  for (const seed of seeds) {
    const media = listing.media.find((row) => `${album}/${row.n}` === seed.path);
    assert.ok(media);
    assert.equal(media.m.a, seed.caption);
    assert.equal(media.m.r, seed.rating);
    assert.equal(media.m.o, seed.offsetMinutes);
    assert.equal(media.m.t * 1000, Date.parse(seed.takenAt));
    assert.equal(String(media.m.s), seed.bytes);
    const download = await request('GET', `/pgapi/gallery/content/${seed.path}`, { cookie: owner.cookie });
    assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(digest(bytes), seed.sha256);
    inventory.push({ path: seed.path, sha256: digest(bytes) });
  }
  const anonymous = await request('GET', `/pgapi/gallery/content/${seeds[0].path}`);
  assert.ok(anonymous.status === 401 || anonymous.status === 403);
  phase = 'stopped source capture';
  run(['stop', '--time', '30', name]);
  assert.equal(run(['inspect', '--format', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}', name]), 'false no');
  const databasePath = path.join(database, 'sqlite.db');
  assert.equal(readFileSync(databasePath).subarray(0, 16).toString(), 'SQLite format 3\0');
  const input = path.join(directory, 'test.json');
  writeFileSync(
    input,
    JSON.stringify({
      container,
      databasePath,
      originals,
      album,
      sourceUserId: String(owner.user.id),
      username,
      password,
      seeds,
      sidecars,
      inventory,
    }),
    { mode: 0o600 },
  );
  phase = 'common import of the stopped capture';
  const tests = spawnSync(
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
      '--testNamePattern=native-pigallery2',
      '--maxWorkers=1',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        FRAMELEAF_NATIVE_IMPORT_SOURCE: 'pigallery2',
        FRAMELEAF_NATIVE_IMPORT_CONFIG: input,
        FRAMELEAF_NATIVE_IMPORT_RUN_ID: runId,
      },
    },
  );
  assert.equal(tests.status, 0);
  console.log('Native PiGallery2 folder album, captions, ratings, sidecar and owner import passed');
} catch (error) {
  isFailed = true;
  console.error('PiGallery2 native qualification failed during: ' + phase);
  if (process.env.FRAMELEAF_QUALIFICATION_DEBUG === '1') console.error(error);
} finally {
  try {
    cleanupQualification(runId);
  } catch {
    isFailed = true;
    console.error('PiGallery2 qualification cleanup failed');
  }
}
if (isFailed) process.exitCode = 1;
