import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { applicationQualificationImage as image, cleanupQualification } from './cleanup-photoprism-qualification.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = process.env.FRAMELEAF_PHOTOPRISM_RUN_ID;
if (!/^\d+-\d+$/u.test(runId ?? '') || basename(tmpdir()) !== `frameleaf-photoprism-${runId}`)
  throw new Error('Invalid qualification cleanup scope');
const directory = mkdtempSync(join(tmpdir(), 'application-'));
const storage = join(directory, 'storage'),
  originals = join(directory, 'originals');
for (const path of [storage, originals]) mkdirSync(path, { mode: 0o700 });
const container = `frameleaf-photoprism-app-${runId}`;
const password = randomBytes(32).toString('hex');
const command = (args, options = {}) =>
  spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 600_000, ...options });
const run = (args) => {
  const result = command(args);
  if (result.status !== 0) throw new Error(`Fixture Docker operation failed: ${args[0]}`);
  return result.stdout.trim();
};
const failures = [];
let phase = 'initialization';
try {
  const hadImage = command(['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
  writeFileSync(join(tmpdir(), 'application-image.json'), JSON.stringify({ createdImage: !hadImage }), { mode: 0o600 });
  const seeds = [];
  mkdirSync(join(originals, 'camera'), { mode: 0o700 });
  for (const [name, color] of [
    ['blue', '#2850c8'],
    ['green', '#28b050'],
  ]) {
    const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: color } })
      .jpeg()
      .toBuffer();
    const path = 'camera/' + name + '.jpg';
    writeFileSync(join(originals, path), bytes, { mode: 0o600 });
    seeds.push({ name, path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: String(bytes.length) });
  }
  const environment = join(directory, 'application.env');
  writeFileSync(
    environment,
    [
      'PHOTOPRISM_AUTH_MODE=password',
      'PHOTOPRISM_PUBLIC=false',
      'PHOTOPRISM_DEMO=false',
      'PHOTOPRISM_ADMIN_USER=admin',
      `PHOTOPRISM_ADMIN_PASSWORD=${password}`,
      'PHOTOPRISM_DATABASE_DRIVER=sqlite',
      'PHOTOPRISM_DATABASE_DSN=/photoprism/storage/index.db',
      'PHOTOPRISM_CONFIG_PATH=/photoprism/storage/config',
      'PHOTOPRISM_STORAGE_PATH=/photoprism/storage',
      'PHOTOPRISM_ORIGINALS_PATH=/photoprism/originals',
      'PHOTOPRISM_HTTP_HOST=0.0.0.0',
      'PHOTOPRISM_HTTP_PORT=2342',
      'PHOTOPRISM_DISABLE_TLS=true',
      'PHOTOPRISM_DISABLE_TENSORFLOW=true',
      'PHOTOPRISM_DISABLE_FACES=true',
      'PHOTOPRISM_DISABLE_CLASSIFICATION=true',
      'PHOTOPRISM_DISABLE_WEBDAV=true',
      'PHOTOPRISM_WORKERS=1',
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
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--label',
    'app.frameleaf.qualification-family=photoprism',
    '--label',
    `app.frameleaf.qualification-run=${runId}`,
    '--env-file',
    environment,
    '-p',
    '127.0.0.1::2342',
    '--mount',
    `type=bind,source=${storage},target=/photoprism/storage`,
    '--mount',
    `type=bind,source=${originals},target=/photoprism/originals`,
    '--entrypoint',
    'photoprism',
    image,
    'start',
  ]);
  const waitReady = async () => {
    const port = Number(run(['port', container, '2342']).match(/^127\.0\.0\.1:(\d+)$/u)?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid fixture loopback port');
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(origin + '/api/v1/status', { signal: AbortSignal.timeout(2000) });
        await response.body?.cancel();
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* The listener is unavailable until startup completes. */
      }
      if (run(['inspect', '--format', '{{.State.Running}}', container]) !== 'true')
        throw new Error('Fixture application stopped during initialization');
      await setTimeout(1000);
    }
    if (!ready) throw new Error('Fixture application initialization timed out');
    return origin;
  };
  let origin = await waitReady();
  phase = 'source login';
  const login = (value) =>
    fetch(origin + '/api/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: value }),
      signal: AbortSignal.timeout(10_000),
    });
  const accepted = await login(password);
  if (accepted.status !== 200) throw new Error('Native local login refused');
  const session = await accepted.json();
  if (
    session.provider !== 'local' ||
    session.user?.Name !== 'admin' ||
    session.user?.ID !== 1 ||
    !/^u[a-z0-9]{15}$/u.test(session.user?.UID ?? '')
  )
    throw new Error('Native local login identity changed');
  phase = 'native media indexing';
  run(['exec', container, 'photoprism', 'index']);
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(origin + '/api/v1' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + session.access_token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('Native fixture API refused ' + method);
    return response.json();
  };
  const indexed = await request('/photos?count=100');
  if (
    !Array.isArray(indexed) ||
    indexed.length !== seeds.length ||
    typeof session.config?.downloadToken !== 'string' ||
    !session.config.downloadToken
  )
    throw new Error('Native media inventory or scoped download authority changed');
  const nativeLibrary = { photos: [], album: undefined };
  for (const photo of indexed) {
    if (!/^p[a-z0-9]{15}$/u.test(photo.UID)) throw new Error('Native photo identity changed');
    const download = await fetch(
      origin + '/api/v1/photos/' + photo.UID + '/dl?t=' + encodeURIComponent(session.config.downloadToken),
      {
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!download.ok) throw new Error('Native original download refused');
    const sha256 = createHash('sha256')
      .update(Buffer.from(await download.arrayBuffer()))
      .digest('hex');
    const seed = seeds.find((item) => item.sha256 === sha256);
    if (!seed || nativeLibrary.photos.some((item) => item.path === seed.path))
      throw new Error('Native download did not return a distinct seeded original');
    const favorite = seed.name === 'blue';
    const caption = 'Native ' + seed.name + ' caption';
    const edited = await request('/photos/' + photo.UID, 'PUT', {
      Title: 'Native ' + seed.name + ' title',
      TitleSrc: 'manual',
      Caption: caption,
      CaptionSrc: 'manual',
      Private: true,
      Favorite: favorite,
      TakenAt: '2020-06-10T18:30:00Z',
      TakenAtLocal: '2020-06-10T12:30:00Z',
      TakenSrc: 'manual',
      TimeZone: 'America/Edmonton',
      Lat: 53.5461,
      Lng: -113.4938,
      PlaceSrc: 'manual',
      Details: { Keywords: 'native, review', KeywordsSrc: 'manual' },
    });
    const observed = await request('/photos/' + photo.UID);
    if (
      edited.UID !== photo.UID ||
      observed.UID !== photo.UID ||
      observed.Caption !== caption ||
      observed.Private !== true ||
      observed.Favorite !== favorite ||
      observed.TimeZone !== 'America/Edmonton'
    )
      throw new Error('Native manual photo readback changed');
    nativeLibrary.photos.push({ ...seed, uid: photo.UID, caption, favorite });
  }
  const created = await request('/albums', 'POST', { Title: 'Native private album', Favorite: true });
  if (!/^a[a-z0-9]{15}$/u.test(created.UID)) throw new Error('Native album identity changed');
  await request('/albums/' + created.UID, 'PUT', {
    Title: 'Native private album',
    Description: 'Manually organized',
    Private: true,
    Favorite: true,
  });
  await request('/albums/' + created.UID + '/photos', 'POST', {
    photos: nativeLibrary.photos.map((photo) => photo.uid),
  });
  const album = await request('/albums/' + created.UID);
  if (
    album.UID !== created.UID ||
    album.Title !== 'Native private album' ||
    album.Description !== 'Manually organized' ||
    album.Private !== true
  )
    throw new Error('Native private album readback changed');
  nativeLibrary.album = { uid: album.UID, name: album.Title, description: album.Description };
  nativeLibrary.containerId = run(['inspect', '--format', '{{.Id}}', container]);
  nativeLibrary.imageId = run(['inspect', '--format', '{{.Image}}', container]);
  nativeLibrary.scope = session.scope;
  nativeLibrary.authMode = session.config.authMode;
  const rejected = await login('wrong-' + password);
  await rejected.body?.cancel();
  if (rejected.status !== 401) throw new Error('Native source accepted the wrong password');
  phase = 'source stop';
  run(['stop', '--time', '30', container]);
  if (run(['inspect', '--format', '{{.State.Running}}', container]) !== 'false')
    throw new Error('Fixture application did not stop');
  const baseline = join(directory, 'baseline-storage');
  cpSync(storage, baseline, { recursive: true });
  const cases = JSON.parse(
    readFileSync(new URL('../src/library-import/fixtures/photoprism/261029-login-cases.json', import.meta.url), 'utf8'),
  );
  const columns = ['auth_provider', 'auth_method', 'super_admin', 'can_login', 'expires_at', 'deleted_at'];
  for (const sourceCase of cases.cases) {
    phase = 'source account state: ' + sourceCase.name;
    // Restore the stopped fixture, including WAL files, so prior failed logins cannot trigger rate limiting.
    rmSync(storage, { recursive: true });
    cpSync(baseline, storage, { recursive: true });
    const fields = { ...cases.base, ...sourceCase.fields };
    if (Object.keys(fields).sort().join(',') !== [...columns].sort().join(','))
      throw new Error('Unknown native account field');
    const database = new DatabaseSync(join(storage, 'index.db'), { allowExtension: false });
    try {
      const updated = database
        .prepare(
          'UPDATE auth_users SET auth_provider=?,auth_method=?,super_admin=?,can_login=?,expires_at=?,deleted_at=? WHERE user_uid=? AND id=1',
        )
        .run(...columns.map((name) => fields[name]), session.user.UID);
      if (Number(updated.changes) !== 1) throw new Error('Native source account identity changed');
    } finally {
      database.close();
    }
    run(['start', container]);
    origin = await waitReady();
    const response = await login(password);
    phase = `source account ${sourceCase.name}: HTTP ${response.status}, expected ${sourceCase.status}`;
    if (response.status !== sourceCase.status) throw new Error('Native account login policy changed');
    if (sourceCase.status === 200) {
      const current = await response.json();
      if (current.provider !== 'local' || current.user?.UID !== session.user.UID)
        throw new Error('Native local login identity changed');
    } else await response.body?.cancel();
    run(['stop', '--time', '30', container]);
    if (run(['inspect', '--format', '{{.State.Running}}', container]) !== 'false')
      throw new Error('Fixture application did not stop');
    const config = join(directory, 'test.json');
    writeFileSync(
      config,
      JSON.stringify({
        databasePath: join(storage, 'index.db'),
        stagingRoot: directory,
        sourceUserId: session.user.UID,
        password,
        caseName: sourceCase.name,
        nativeLibrary,
      }),
      { mode: 0o600 },
    );
    phase = 'imported verifier and restrictions: ' + sourceCase.name;
    const tests = spawnSync(
      'pnpm',
      [
        '--dir',
        'server',
        'exec',
        'vitest',
        'run',
        '--config',
        'test/vitest.config.mjs',
        'src/library-import/photoprism-application.spec.ts',
        '--maxWorkers=1',
      ],
      { cwd: root, stdio: 'inherit', env: { ...process.env, FRAMELEAF_PHOTOPRISM_APPLICATION_CONFIG: config } },
    );
    if (tests.status !== 0) throw new Error('Native account extraction failed');
    console.log('Native PhotoPrism account case passed: ' + sourceCase.name);
  }
} catch {
  failures.push(new Error(`Native PhotoPrism application qualification failed during ${phase}`));
} finally {
  try {
    cleanupQualification(runId);
  } catch {
    failures.push(new Error('Native PhotoPrism application cleanup failed'));
  }
}
if (failures.length) throw new AggregateError(failures, 'Native application qualification or cleanup failed');
console.log('Native PhotoPrism local account qualification passed; disposable application and owned images removed.');
