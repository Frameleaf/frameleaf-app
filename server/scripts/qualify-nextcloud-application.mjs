// Disposable Nextcloud 35 + Photos 8 + Memories 10.2 (SQLite) qualification: seed through native APIs, stop the
// application, capture its stopped state and import it through the common command in a fresh destination.
/* eslint-disable unicorn/name-replacements -- the qualification contract fixes this script's file name */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  cleanupQualification,
  qualificationFixture as fixture,
  qualificationImage as image,
} from './cleanup-nextcloud-qualification.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID;
if (!/^\d+-\d+$/u.test(runId ?? '') || path.basename(tmpdir()) !== `frameleaf-nextcloud-${runId}`)
  throw new Error('Invalid qualification cleanup scope');
const directory = mkdtempSync(path.join(tmpdir(), 'application-'));
const data = path.join(directory, 'data');
mkdirSync(data, { mode: 0o700 });
const container = `frameleaf-nextcloud-app-${runId}`;
const volume = `frameleaf-nextcloud-html-${runId}`;
const labels = [
  '--label',
  'app.frameleaf.qualification-family=nextcloud',
  '--label',
  `app.frameleaf.qualification-run=${runId}`,
];
const user = 'admin';
const password = randomBytes(32).toString('hex');
const albumName = 'Native private album';
const memoriesUrl = `https://github.com/pulsejet/memories/releases/download/v${fixture.source.memories.version}/memories.tar.gz`;
const command = (arguments_, options = {}) =>
  spawnSync('docker', arguments_, { cwd: root, encoding: 'utf8', timeout: 600_000, ...options });
const run = (arguments_) => {
  const result = command(arguments_);
  if (result.status !== 0)
    throw new Error(
      `Fixture Docker operation failed: ${arguments_[0]} ${arguments_.at(-1)}: ${String(result.stderr || result.stdout).slice(-400)}`,
    );
  return result.stdout.trim();
};
const occ = (...arguments_) =>
  run(['exec', '-u', 'www-data', container, 'php', 'occ', '--no-interaction', ...arguments_]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
let phase = 'initialization';
try {
  const hasImage = command(['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
  writeFileSync(path.join(tmpdir(), 'image.json'), JSON.stringify({ createdImage: !hasImage }), { mode: 0o600 });
  if (!hasImage) run(['pull', image]);

  phase = 'Memories package download';
  const download = await fetch(memoriesUrl, { signal: AbortSignal.timeout(300_000) });
  if (!download.ok) throw new Error('Memories package download refused');
  const archive = Buffer.from(await download.arrayBuffer());
  if (sha256(archive) !== fixture.runtime.memoriesArchiveSha256) throw new Error('Memories package checksum changed');
  const archivePath = path.join(directory, 'memories.tar.gz');
  writeFileSync(archivePath, archive, { mode: 0o644 });

  phase = 'synthetic originals';
  const seeds = [];
  for (const [name, color] of [
    ['blue', '#2850c8'],
    ['green', '#28b050'],
  ]) {
    const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: color } })
      .jpeg()
      .toBuffer();
    seeds.push({
      name,
      bytes,
      generatedSha256: sha256(bytes),
      caption: `Native ${name} caption`,
      title: `Native ${name} title`,
      favorite: name === 'blue',
    });
  }

  phase = 'application startup';
  const environment = path.join(directory, 'application.env');
  writeFileSync(
    environment,
    [
      'SQLITE_DATABASE=nextcloud',
      `NEXTCLOUD_ADMIN_USER=${user}`,
      `NEXTCLOUD_ADMIN_PASSWORD=${password}`,
      'NEXTCLOUD_TRUSTED_DOMAINS=127.0.0.1 localhost',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  // Keep the admin home limited to seeded originals (no stock skeleton or template media) and install only the
  // pinned, checksummed Memories package (no app store resolution to a newer release).
  // The image's pre-installation hook runs after its stock configuration is in place and before installation.
  const hooks = path.join(directory, 'pre-installation');
  mkdirSync(hooks, { mode: 0o755 });
  writeFileSync(
    path.join(hooks, 'frameleaf-qualification.sh'),
    [
      '#!/bin/sh',
      'set -eu',
      "cat > /var/www/html/config/frameleaf-qualification.config.php <<'PHP'",
      '<?php',
      "$CONFIG = array('skeletondirectory' => '', 'templatedirectory' => '', 'appstoreenabled' => false);",
      'PHP',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  run(['volume', 'create', ...labels, volume]);
  run([
    'create',
    '--name',
    container,
    '--restart=no',
    ...labels,
    '--env-file',
    environment,
    '-p',
    '127.0.0.1::80',
    '--mount',
    `type=volume,source=${volume},target=/var/www/html`,
    image,
  ]);
  run(['cp', hooks, `${container}:/docker-entrypoint-hooks.d/`]);
  run(['start', container]);
  const port = Number(run(['port', container, '80']).match(/^127\.0\.0\.1:(\d+)$/mu)?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid fixture loopback port');
  const origin = `http://127.0.0.1:${port}`;
  // Installation runs before Apache listens, so connection failures mean "not yet".
  const installed = async () => {
    try {
      const response = await fetch(origin + '/status.php', { signal: AbortSignal.timeout(5000) });
      const status = response.ok ? await response.json() : undefined;
      return status?.installed === true;
    } catch {
      return false;
    }
  };
  let isReady = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await installed()) {
      isReady = true;
      break;
    }
    if (run(['inspect', '--format', '{{.State.Running}}', container]) !== 'true')
      throw new Error('Fixture application stopped during initialization');
    await setTimeout(1000);
  }
  if (!isReady) throw new Error('Fixture application initialization timed out');

  phase = 'Memories installation';
  run(['cp', archivePath, `${container}:/tmp/memories.tar.gz`]);
  run([
    'exec',
    container,
    'sh',
    '-c',
    'tar -xzf /tmp/memories.tar.gz -C /var/www/html/custom_apps && chown -R www-data:www-data /var/www/html/custom_apps/memories && rm /tmp/memories.tar.gz',
  ]);
  occ('app:enable', 'memories');
  for (const app of ['photos', 'memories']) {
    const state = [occ('config:app:get', app, 'installed_version'), occ('config:app:get', app, 'enabled')];
    if (state[0] !== fixture.source[app].version || state[1] !== 'yes')
      throw new Error(`Photos/Memories installation changed: ${app} ${JSON.stringify(state).slice(0, 200)}`);
  }

  const authorization = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  const request = async (route, { method = 'GET', headers = {}, body, expect = [200] } = {}) => {
    const response = await fetch(origin + route, {
      method,
      headers: { Authorization: authorization, 'OCS-APIRequest': 'true', ...headers },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!expect.includes(response.status)) {
      await response.body?.cancel();
      throw new Error(`Native fixture API refused ${method}: HTTP ${response.status}`);
    }
    return response;
  };
  const files = `/remote.php/dav/files/${user}`;
  const property = (xml, name) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'u'))?.[1];

  phase = 'WebDAV upload';
  await request(files + '/camera', { method: 'MKCOL', expect: [201] });
  for (const seed of seeds) {
    seed.path = `camera/${seed.name}.jpg`;
    await request(`${files}/${seed.path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'X-OC-MTime': '1591813800' },
      body: seed.bytes,
      expect: [201],
    });
    const listing = await request(`${files}/${seed.path}`, {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>',
      expect: [207],
    });
    const found = await listing.text();
    seed.fileId = property(found, 'oc:fileid');
    if (!/^[1-9]\d*$/u.test(seed.fileId ?? '')) throw new Error('Native file identity changed');
  }

  phase = 'WebDAV favourite';
  for (const seed of seeds) {
    if (!seed.favorite) continue;
    await request(`${files}/${seed.path}`, {
      method: 'PROPPATCH',
      headers: { 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set></d:propertyupdate>',
      expect: [207],
    });
  }

  phase = 'Memories metadata edits';
  for (const seed of seeds) {
    // Memories' own editor writes these tags into the original and reindexes it; it exposes no rating editor.
    const response = await request(`/index.php/apps/memories/api/image/set-exif/${seed.fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw: { Description: seed.caption, Title: seed.title, AllDates: '2020:06:10 12:30:00' },
      }),
    });
    const edited = await response.json();
    if (String(edited.fileid) !== seed.fileId) throw new Error('Native metadata edit identity changed');
  }

  phase = 'Photos album';
  const album = `/remote.php/dav/photos/${user}/albums/${encodeURIComponent(albumName)}`;
  await request(album, { method: 'MKCOL', expect: [201] });
  for (const seed of seeds)
    await request(`${files}/${seed.path}`, {
      method: 'COPY',
      headers: { Destination: `${origin}${album}/${seed.name}.jpg` },
      expect: [201],
    });
  const albumListing = await request(album, { method: 'PROPFIND', headers: { Depth: '1' }, expect: [207] });
  const members = await albumListing.text();
  for (const seed of seeds)
    if (!members.includes(`${encodeURIComponent(albumName)}/${seed.fileId}-${seed.name}.jpg`))
      throw new Error('Native album membership changed');

  phase = 'Memories indexing';
  occ('memories:index');

  phase = 'native readback';
  for (const seed of seeds) {
    const original = await request(`${files}/${seed.path}`);
    const download = Buffer.from(await original.arrayBuffer());
    seed.sha256 = sha256(download);
    seed.size = String(download.length);
    const propertyListing = await request(`${files}/${seed.path}`, {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/><oc:favorite/></d:prop></d:propfind>',
      expect: [207],
    });
    const properties = await propertyListing.text();
    if (property(properties, 'oc:favorite') !== (seed.favorite ? '1' : '0'))
      throw new Error('Native favourite changed');
    const infoResponse = await request(`/index.php/apps/memories/api/image/info/${seed.fileId}`);
    const info = await infoResponse.json();
    if (info.exif?.Description !== seed.caption || !Number.isSafeInteger(info.datetaken))
      throw new Error('Native Memories readback changed');
    seed.datetaken = info.datetaken;
  }
  const rejected = await fetch(origin + files, {
    method: 'PROPFIND',
    headers: { Authorization: 'Basic ' + Buffer.from(`${user}:wrong-${password}`).toString('base64'), Depth: '0' },
    signal: AbortSignal.timeout(30_000),
  });
  await rejected.body?.cancel();
  if (rejected.status !== 401) throw new Error('Native source accepted the wrong password');

  phase = 'source stop';
  const containerId = run(['inspect', '--format', '{{.Id}}', container]);
  const imageId = run(['inspect', '--format', '{{.Image}}', container]);
  run(['stop', '--time', '30', container]);
  if (run(['inspect', '--format', '{{.State.Running}}', container]) !== 'false')
    throw new Error('Fixture application did not stop');
  if (run(['inspect', '--format', '{{.HostConfig.RestartPolicy.Name}}', container]) !== 'no')
    throw new Error('Fixture application restart is enabled');

  phase = 'stopped source capture';
  const database = path.join(data, 'nextcloud.db');
  run(['cp', `${container}:/var/www/html/data/nextcloud.db`, database]);
  // Committed WAL pages belong to the stopped state; a hot journal would mean an interrupted writer.
  if (command(['cp', `${container}:/var/www/html/data/nextcloud.db-journal`, database + '-journal']).status === 0)
    throw new Error('Stopped source left a hot rollback journal');
  command(['cp', `${container}:/var/www/html/data/nextcloud.db-wal`, database + '-wal']);
  mkdirSync(path.join(data, user), { mode: 0o700 });
  run(['cp', `${container}:/var/www/html/data/${user}/files`, path.join(data, user, 'files')]);
  const restrict = (target) => {
    const info = statSync(target);
    chmodSync(target, info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) for (const name of readdirSync(target)) restrict(path.join(target, name));
  };
  restrict(data);

  const config = path.join(directory, 'test.json');
  writeFileSync(
    config,
    JSON.stringify({
      container: { id: containerId, image: imageId, name: container },
      databasePath: database,
      sourceRoot: data,
      sourceUserId: user,
      password,
      album: { name: albumName },
      seeds: seeds.map((seed) => ({ ...seed, bytes: undefined })),
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
      '--testNamePattern=native-nextcloud',
      '--maxWorkers=1',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        FRAMELEAF_NATIVE_IMPORT_SOURCE: 'nextcloud',
        FRAMELEAF_NATIVE_IMPORT_CONFIG: config,
        FRAMELEAF_NATIVE_IMPORT_RUN_ID: runId,
      },
    },
  );
  if (acceptance.status !== 0) throw new Error('Native common import acceptance failed');
  console.log(readFileSync(path.join(directory, 'result.json'), 'utf8').trim());
} catch (error) {
  failures.push(new Error(`Native Nextcloud application qualification failed during ${phase}`, { cause: error }));
} finally {
  try {
    cleanupQualification(runId);
  } catch (error) {
    failures.push(new Error('Native Nextcloud application cleanup failed', { cause: error }));
  }
}
if (failures.length > 0) {
  for (const failure of failures) console.error(failure.message + ': ' + String(failure.cause?.message ?? ''));
  throw new AggregateError(failures, 'Native application qualification or cleanup failed');
}
console.log('Native Nextcloud local account qualification passed; disposable application and owned images removed.');
