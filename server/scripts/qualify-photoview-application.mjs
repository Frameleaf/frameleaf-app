import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  cleanupQualification,
  hasQualificationImage,
  qualificationImage as image,
} from './cleanup-photoview-qualification.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = process.env.FRAMELEAF_PHOTOVIEW_RUN_ID;
if (!/^\d+-\d+$/u.test(runId ?? '') || basename(tmpdir()) !== `frameleaf-photoview-${runId}`)
  throw new Error('Invalid qualification cleanup scope');
const directory = mkdtempSync(join(tmpdir(), 'application-'));
const storage = join(directory, 'storage'),
  originals = join(directory, 'originals');
for (const path of [storage, originals]) mkdirSync(path, { mode: 0o700 });
const container = `frameleaf-photoview-${runId}`;
const command = (args, options = {}) =>
  spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 600_000,
    ...options,
  });
const run = (args) => {
  const result = command(args);
  if (result.status !== 0) throw new Error('Fixture Docker operation failed');
  return result.stdout.trim();
};
let phase = 'initialization';
let failure = false;
try {
  const hadImage = hasQualificationImage(run);
  writeFileSync(join(tmpdir(), 'image.json'), JSON.stringify({ createdImage: !hadImage }), { mode: 0o600 });
  const seeds = [];
  for (const [owner, color] of [
    ['admin', '#d0a020'],
    ['alice', '#2850c8'],
    ['bob', '#28b050'],
    ['shared', '#2850c8'],
  ]) {
    const path = `${owner}/private/photo.jpg`;
    mkdirSync(join(originals, owner, 'private'), { recursive: true, mode: 0o700 });
    const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: color } })
      .jpeg()
      .toBuffer();
    writeFileSync(join(originals, path), bytes, { mode: 0o600 });
    seeds.push({ path, bytes: String(bytes.length), sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  phase = 'native startup';
  run([
    'run',
    '-d',
    '--name',
    container,
    '--restart=no',
    '--read-only',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--label',
    'app.frameleaf.qualification-family=photoview',
    '--label',
    `app.frameleaf.qualification-run=${runId}`,
    '--mount',
    `type=bind,source=${storage},target=/state`,
    '--mount',
    `type=bind,source=${originals},target=/photos,readonly`,
    '--tmpfs',
    '/tmp:rw,nosuid,size=256m',
    '-p',
    '127.0.0.1::4001',
    '--env',
    'PHOTOVIEW_DATABASE_DRIVER=sqlite',
    '--env',
    'PHOTOVIEW_SQLITE_PATH=/state/photoview.sqlite',
    '--env',
    'PHOTOVIEW_MEDIA_CACHE=/state/cache',
    '--env',
    'PHOTOVIEW_LISTEN_IP=0.0.0.0',
    '--env',
    'PHOTOVIEW_LISTEN_PORT=4001',
    '--env',
    'PHOTOVIEW_API_ENDPOINT=http://127.0.0.1:4001/api',
    '--env',
    'PHOTOVIEW_SERVE_UI=0',
    image,
  ]);
  const port = Number(run(['port', container, '4001']).match(/^127\.0\.0\.1:(\d+)$/u)?.[1]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const origin = `http://127.0.0.1:${port}`;
  const gql = async (query, variables = {}, token) => {
    const response = await fetch(origin + '/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token && { cookie: `auth-token=${token}` }) },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Fixture GraphQL HTTP failure');
    return response.json();
  };
  const data = async (...args) => {
    const result = await gql(...args);
    if (result.errors || !result.data) throw new Error('Fixture GraphQL refused request');
    return result.data;
  };
  const until = async (check) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await check()) return;
      if (run(['inspect', '--format', '{{.State.Running}}', container]) !== 'true')
        throw new Error('Fixture application stopped');
      await setTimeout(500);
    }
    throw new Error('Fixture application did not settle');
  };
  await until(async () => {
    try {
      return (await data('{siteInfo{initialSetup}}')).siteInfo.initialSetup === true;
    } catch {
      return false;
    }
  });
  const actors = {};
  const adminPassword = randomBytes(32).toString('hex');
  const setup = (
    await data(
      'mutation($u:String!,$p:String!,$r:String!){initialSetupWizard(username:$u,password:$p,rootPath:$r){success token}}',
      { u: 'fixture_admin', p: adminPassword, r: '/photos/admin' },
    )
  ).initialSetupWizard;
  assert.equal(setup.success, true);
  const adminToken = setup.token;
  const admin = (await data('{myUser{id username admin}}', {}, adminToken)).myUser;
  assert.equal(admin.admin, true);
  actors.admin = { id: admin.id, password: adminPassword, token: adminToken };
  phase = 'native users and directory grants';
  for (const actor of ['alice', 'bob', 'mallory']) {
    const password = randomBytes(32).toString('hex');
    const user = (
      await data(
        'mutation($u:String!,$p:String!){createUser(username:$u,password:$p,admin:false){id}}',
        { u: `fixture_${actor}`, p: password },
        adminToken,
      )
    ).createUser;
    const login = (
      await data('mutation($u:String!,$p:String!){authorizeUser(username:$u,password:$p){success token}}', {
        u: `fixture_${actor}`,
        p: password,
      })
    ).authorizeUser;
    assert.equal(login.success, true);
    actors[actor] = { id: user.id, password, token: login.token };
    if (actor !== 'mallory')
      for (const folder of [actor, 'shared'])
        await data(
          'mutation($u:ID!,$r:String!){userAddRootPath(id:$u,rootPath:$r){id}}',
          { u: user.id, r: `/photos/${folder}` },
          adminToken,
        );
  }
  const media = async (actor) =>
    (await data('{myMedia{id path favorite album{id title}}}', {}, actors[actor].token)).myMedia;
  phase = 'sequential native scans';
  for (const [actor, count] of [
    ['admin', 1],
    ['alice', 2],
    ['bob', 2],
  ]) {
    assert.equal(
      (await data('mutation($u:ID!){scanUser(userId:$u){success}}', { u: actors[actor].id }, adminToken)).scanUser
        .success,
      true,
    );
    await until(async () => (await media(actor)).length === count);
  }
  phase = 'native access and favourite assertions';
  const visible = {};
  for (const [actor, count] of [
    ['admin', 1],
    ['alice', 2],
    ['bob', 2],
    ['mallory', 0],
  ]) {
    visible[actor] = await media(actor);
    assert.equal(visible[actor].length, count);
  }
  const shared = visible.alice.find((row) => row.path.startsWith('/photos/shared/'));
  assert.ok(shared && visible.bob.some((row) => row.id === shared.id));
  await data('mutation($m:ID!){favoriteMedia(mediaId:$m,favorite:true){id}}', { m: shared.id }, actors.alice.token);
  for (const [actor, expected] of [
    ['alice', true],
    ['bob', false],
  ])
    assert.equal((await media(actor)).find((row) => row.id === shared.id).favorite, expected);
  const alicePrivate = visible.alice.find((row) => row.path.startsWith('/photos/alice/'));
  for (const actor of ['bob', 'mallory']) {
    const refused = await gql('query($m:ID!){media(id:$m){id path}}', { m: alicePrivate.id }, actors[actor].token);
    assert.ok(refused.errors?.length && !refused.data?.media);
  }
  const protection = [];
  for (const protectedShare of [false, true]) {
    const share = (
      await data(
        'mutation($m:ID!,$p:String){shareMedia(mediaId:$m,password:$p){id hasPassword}}',
        { m: visible.admin[0].id, p: protectedShare ? randomBytes(32).toString('hex') : null },
        adminToken,
      )
    ).shareMedia;
    assert.equal(share.hasPassword, protectedShare);
    protection.push({ id: share.id, protected: protectedShare });
  }
  phase = 'stopped source capture';
  run(['stop', '--time', '30', container]);
  assert.equal(
    run(['inspect', '--format', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}', container]),
    'false no',
  );
  const header = readFileSync(join(storage, 'photoview.sqlite')).subarray(0, 100);
  assert.equal(header.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(header.readUInt32BE(96), 3_045_001);
  const config = join(directory, 'test.json');
  writeFileSync(
    config,
    JSON.stringify({
      databasePath: join(storage, 'photoview.sqlite'),
      stagingRoot: directory,
      originals,
      actors: Object.fromEntries(Object.entries(actors).map(([actor, { id, password }]) => [actor, { id, password }])),
      visible,
      sharedMediaId: shared.id,
      protection,
      seeds,
    }),
    { mode: 0o600 },
  );
  phase = 'product snapshot reader, credentials and access comparison';
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
      'src/library-import/photoview-application.spec.ts',
      '--maxWorkers=1',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, FRAMELEAF_PHOTOVIEW_APPLICATION_CONFIG: config },
    },
  );
  assert.equal(tests.status, 0);
  console.log('Native Photoview accounts, directory access and reader comparison passed');
} catch {
  failure = true;
  console.error('Photoview native qualification failed during: ' + phase);
} finally {
  try {
    cleanupQualification(runId);
  } catch {
    failure = true;
    console.error('Photoview qualification cleanup failed');
  }
}
if (failure) process.exitCode = 1;
