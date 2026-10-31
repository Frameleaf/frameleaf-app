import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, realpath, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createUserDto } from 'src/fixtures.js';
import { OwnerBackupOrigin } from 'src/fixtures/owner-backup-origin.js';
import { makeRandomImage } from 'src/generators.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, expect, it } from 'vitest';

const origin = new OwnerBackupOrigin();
const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);
const route = '/users/me/cloud-backup/restore';
const LARGE_BYTES = 2 ** 31;
const when = '2026-09-01T12:00:00.000Z';
const emptyDetails = {
  isFavorite: false,
  visibility: 'timeline',
  rating: null,
  description: '',
  dateTimeOriginal: null,
  timeZone: null,
  latitude: null,
  longitude: null,
  tags: [],
  albums: [],
  faces: [],
  stack: null,
  edits: [],
};
const fileSha = async (path: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
};

afterAll(async () => {
  await origin.close();
  await utils.disconnectDatabase();
});

/** Real auth/controllers/worker/files/PG. Only historical manifests and provider bytes are fixtures. */
it('qualifies bounded own restore publication, current authority and actual large-file lock boundaries', async () => {
  expect(process.env.FL234_OWNED_RUNTIME).toBe('true');
  expect(process.env.PLAYWRIGHT_BASE_URL).toMatch(/^https?:\/\/127\.0\.0\.1:\d+$/);
  const mediaRoot = resolve(process.env.FL234_MEDIA_ROOT ?? '');
  expect(isAbsolute(mediaRoot) && mediaRoot.endsWith('/fl234-owner-restore/runtime/media')).toBe(true);
  expect(await realpath(mediaRoot)).toBe(mediaRoot);
  const container = process.env.FL234_SERVER_CONTAINER!;
  expect(container).toMatch(/^frameleaf-fl234-owner-restore-server-\d+$/);
  const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
  const inspect = await run(docker, [
    '--context',
    'desktop-linux',
    'inspect',
    '--format',
    '{{index .Config.Labels "com.docker.compose.project"}}',
    container,
  ]);
  expect(inspect.stdout.trim()).toBe('frameleaf-fl234-owner-restore');
  const local = (serverPath: string) => {
    expect(serverPath.startsWith('/data/')).toBe(true);
    const path = resolve(mediaRoot, serverPath.slice('/data/'.length));
    const below = relative(mediaRoot, path);
    expect(below && !below.startsWith('..') && !isAbsolute(below)).toBeTruthy();
    return path;
  };
  const endpoint = await origin.start();
  await utils.resetDatabase();
  const admin = await utils.adminSetup({ onboarding: false });
  const owner = await utils.userSetup(admin.accessToken, createUserDto.user1);
  const foreign = await utils.userSetup(admin.accessToken, createUserDto.user2);
  const db = await utils.connectDatabase();
  const pin = { pinCode: '123456' };
  for (const account of [owner, admin]) {
    await request(app).post('/auth/pin-code').set(bearer(account.accessToken)).send(pin).expect(204);
    await request(app).post('/auth/session/unlock').set(bearer(account.accessToken)).send(pin).expect(204);
  }
  const unlock = () => request(app).post('/auth/session/unlock').set(bearer(owner.accessToken)).send(pin).expect(204);
  const bucketKey = randomBytes(32).toString('base64');
  await request(app)
    .post('/admin/cloud/backup/setup')
    .set(bearer(admin.accessToken))
    .send({
      target: 'byo-s3',
      keyMode: 'own-memory',
      key: bucketKey,
      acknowledgement: 'I understand',
      s3: {
        endpoint,
        region: 'us-east-1',
        bucket: 'fl234-fixture',
        accessKeyId: 'FL234FIXTURE',
        secretAccessKey: 'fixture-only-secret',
      },
    })
    .expect(200);
  const stored = await db.query('SELECT value FROM system_metadata WHERE key=$1', ['frameleaf-cloud-backup']);
  const metadata = stored.rows[0].value;
  let sequence = 0;
  let assertions = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    await fn();
    expect(origin.errors, 'Provider-hook failure cannot count as app refusal').toEqual([]);
    assertions++;
    console.log('PASS ' + name);
  };
  const asset = async (name: string, credentials = owner.accessToken) => {
    const bytes = makeRandomImage();
    const made = await utils.createAsset(credentials, { assetData: { bytes, filename: name } });
    await db.query('UPDATE asset SET checksum=$1,"checksumAlgorithm"=$2 WHERE id=$3', [
      Buffer.from(sha(bytes), 'hex'),
      'sha256',
      made.id,
    ]);
    const saved = await db.query('SELECT "originalPath" FROM asset WHERE id=$1', [made.id]);
    const path = saved.rows[0].originalPath;
    return {
      id: made.id,
      path: path as string,
      bytes,
      hash: sha(bytes),
      size: bytes.length,
      details: {} as Record<string, unknown>,
    };
  };
  type Item = Awaited<ReturnType<typeof asset>>;
  const seed = async (items: Item[], extra: Record<string, unknown> = {}) => {
    const key = 'm/20260901T1200' + String(++sequence).padStart(2, '0') + 'Z.json.gz';
    const value = {
      format: 'frameleaf-backup-manifest',
      version: 2,
      instanceId: metadata.instanceId,
      createdAt: when,
      database: null,
      profiles: {},
      albums: {},
      people: {},
      assets: Object.fromEntries(
        items.map((item) => [
          item.id,
          {
            owner: owner.userId,
            type: 'IMAGE',
            originalFileName: 'own-older.png',
            fileCreatedAt: when,
            fileModifiedAt: when,
            localDateTime: when,
            duration: null,
            details: { ...emptyDetails, isFavorite: true, description: 'Own older backup', ...item.details },
            files: [{ role: 'original', path: item.path, sha256: item.hash, size: item.size, mtime: when }],
          },
        ]),
      ),
      ...extra,
    };
    origin.objects.set(key, gzipSync(Buffer.from(JSON.stringify(value))));
    await db.query(
      'INSERT INTO cloud_backup_manifest (bucket,key,status,"finishedAt") VALUES ($1,$2,$3,clock_timestamp())',
      [metadata.bucketRef, key, 'complete'],
    );
    for (const item of items) {
      if (item.size < LARGE_BYTES) {
        origin.objects.set('o/' + item.hash, item.bytes);
      }
      await db.query('UPDATE asset SET status=$1,"deletedAt"=clock_timestamp() WHERE id=$2', ['trashed', item.id]);
    }
    return key;
  };
  const start = (key: string, ids: string[], credentials: Record<string, string> = bearer(owner.accessToken)) =>
    request(app).post(route).set(credentials).send({ manifestKey: key, assetIds: ids });
  const finish = async (id: string) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const response = await request(app)
        .get('/media-operations/' + id)
        .set(bearer(owner.accessToken))
        .expect(200);
      if (['completed', 'failed', 'cancelled'].includes(response.body.status)) {
        return response.body;
      }
      await delay(200);
    }
    throw new Error('Own restore did not reach terminal status within 180s');
  };
  const occupied = async (item: Item) => {
    const bytes = makeRandomImage();
    await writeFile(local(item.path), bytes);
    return bytes;
  };
  const restore = async (key: string, items: Item[]) => {
    const response = await start(
      key,
      items.map((item) => item.id),
    ).expect(201);
    expect(Object.keys(response.body).toSorted((a, b) => a.localeCompare(b))).toEqual(['operationId', 'status']);
    return finish(response.body.operationId);
  };
  const first = await asset('owner-current.png');
  const missing = await asset('owner-recreate.png');
  const outside = await asset('foreign.png', foreign.accessToken);
  const album = await request(app)
    .post('/albums')
    .set(bearer(owner.accessToken))
    .send({ albumName: 'Own older album' })
    .expect(201);
  const person = await request(app)
    .post('/people')
    .set(bearer(owner.accessToken))
    .send({ name: 'Own older person' })
    .expect(201);
  for (const item of [first, missing]) {
    item.details = {
      albums: [{ id: album.body.id, name: 'Own older album' }],
      faces: [{ personId: person.body.id, box: [0, 0, 1, 1], imageWidth: 1, imageHeight: 1, isHidden: false }],
    };
  }
  const key = await seed([first, missing, outside], {
    albums: {
      [album.body.id]: {
        name: 'Own older album',
        description: 'Own backup album',
        ownerId: owner.userId,
        coverAssetId: first.id,
        order: 'desc',
        sharedUsers: [],
      },
    },
    people: {
      [person.body.id]: {
        ownerId: owner.userId,
        name: 'Own older person',
        birthDate: null,
        isHidden: false,
        isFavorite: false,
      },
    },
  });
  await check('read and update API keys refuse durable owner restore without a real elevated session', async () => {
    for (const permission of ['asset.read', 'asset.update']) {
      const apiKey = await request(app)
        .post('/api-keys')
        .set(bearer(owner.accessToken))
        .send({ name: 'restore fixture', permissions: [permission] })
        .expect(201);
      await start(key, [first.id], { 'x-api-key': apiKey.body.secret }).expect(403);
    }
  });
  await check('current elevation and owner facts refuse foreign selection and nonowner admin', async () => {
    await start(key, [outside.id]).expect(404);
    await start(key, [first.id], bearer(admin.accessToken)).expect(404);
    await request(app).post('/auth/session/lock').set(bearer(owner.accessToken)).expect(204);
    await start(key, [first.id]).expect(403);
    await unlock();
  });
  await check('older chosen backup restores multiple own files/details and retains occupied bytes', async () => {
    const old = await occupied(first);
    await db.query('DELETE FROM asset WHERE id=$1', [missing.id]);
    const result = await restore(key, [first, missing]);
    expect(result.status).toBe('completed');
    expect(result.snapshot).toEqual({ version: 1, scope: 'asset', assetCount: 2 });
    expect(result.settings).toEqual({});
    expect(result.destinationDetail).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/originalPath|sessionId|keyFingerprint|secretAccessKey|\/data\//);
    for (const item of [first, missing]) {
      expect(await fileSha(local(item.path))).toBe(item.hash);
      const info = await request(app)
        .get('/assets/' + item.id)
        .set(bearer(owner.accessToken))
        .expect(200);
      expect(info.body.isFavorite).toBe(true);
      expect(info.body.exifInfo.description).toBe('Own older backup');
    }
    const albumLinks = await db.query(
      'SELECT COUNT(*) AS n FROM album_asset WHERE "albumId"=$1 AND "assetId"=ANY($2::uuid[])',
      [album.body.id, [first.id, missing.id]],
    );
    expect(albumLinks.rows[0].n).toBe('2');
    const faces = await db.query(
      'SELECT COUNT(*) AS n FROM asset_face WHERE "personGroupId"=$1 AND "assetId"=ANY($2::uuid[])',
      [person.body.id, [first.id, missing.id]],
    );
    expect(faces.rows[0].n).toBe('2');
    const asideRoot = join(mediaRoot, 'frameleaf/restore/replaced', result.id);
    const copies: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else {
          copies.push(path);
        }
      }
    };
    await walk(asideRoot);
    expect(await Promise.all(copies.map((path) => fileSha(path)))).toContain(sha(old));
  });
  const refused = async (
    name: string,
    change: (item: Item, id: () => string) => Promise<void>,
    credentials: Record<string, string> = bearer(owner.accessToken),
  ) => {
    const item = await asset(name + '.png');
    const manifest = await seed([item]);
    const old = await occupied(item);
    let operationId = '';
    origin.beforeRead = { key: 'o/' + item.hash, run: () => change(item, () => operationId) };
    const response = await start(manifest, [item.id], credentials).expect(201);
    operationId = response.body.operationId;
    const result = await finish(operationId);
    expect(['failed', 'cancelled']).toContain(result.status);
    expect(origin.beforeRead).toBeNull();
    expect(await readFile(local(item.path))).toEqual(old);
    expect(JSON.stringify(result)).not.toMatch(/originalPath|sessionId|keyFingerprint|secretAccessKey|\/data\//);
    return { item, manifest, result };
  };
  await check('normal relock during signed object transfer refuses publication', async () => {
    await refused('relock', async () => {
      await request(app).post('/auth/session/lock').set(bearer(owner.accessToken)).expect(204);
    });
    await unlock();
  });
  await check('normal cancellation during transfer refuses publication', async () => {
    await refused('cancel', async (_item, id) => {
      await request(app)
        .post('/media-operations/' + id() + '/cancel')
        .set(bearer(owner.accessToken))
        .expect(200);
    });
  });
  await check('normal session revocation during transfer refuses its persisted owner claim', async () => {
    const secondary = await request(app)
      .post('/auth/login')
      .send({ email: createUserDto.user1.email, password: createUserDto.user1.password })
      .expect(201);
    const credentials = bearer(secondary.body.accessToken);
    await request(app).post('/auth/session/unlock').set(credentials).send(pin).expect(204);
    const sessions = await request(app).get('/sessions').set(credentials).expect(200);
    const id = sessions.body.find((entry: { current: boolean }) => entry.current).id;
    await refused(
      'revoke',
      async () => {
        await request(app)
          .delete('/sessions/' + id)
          .set(bearer(owner.accessToken))
          .expect(204);
      },
      credentials,
    );
  });
  await check('actual current configuration and loaded-key identity are rechecked after transfer', async () => {
    const configuration = await request(app).get('/system-config').set(bearer(admin.accessToken)).expect(200);
    const originalConfig = configuration.body;
    await refused('disabled', async () => {
      const config = structuredClone(originalConfig);
      config.frameleafCloud.cloudBackup.enabled = false;
      await request(app).put('/system-config').set(bearer(admin.accessToken)).send(config).expect(200);
    });
    await request(app).put('/system-config').set(bearer(admin.accessToken)).send(originalConfig).expect(200);
    await refused('changed-key', async () => {
      // Controlled persisted claim fixture mutation, never an auth/session flag or loaded secret substitute.
      await db.query('UPDATE system_metadata SET value=jsonb_set(value,$1,$2::jsonb) WHERE key=$3', [
        '{keyFingerprint}',
        JSON.stringify('unloaded-fixture-fingerprint'),
        'frameleaf-cloud-backup',
      ]);
    });
    await db.query('UPDATE system_metadata SET value=jsonb_set(value,$1,$2::jsonb) WHERE key=$3', [
      '{keyFingerprint}',
      JSON.stringify(metadata.keyFingerprint),
      'frameleaf-cloud-backup',
    ]);
  });
  await check('normal suppression follows PIN reveal semantics during transfer', async () => {
    const tag = await request(app)
      .post('/tags')
      .set(bearer(owner.accessToken))
      .send({ name: 'Suppressed fixture' })
      .expect(201);
    await refused('privacy', async (item) => {
      await db.query('INSERT INTO tag_asset ("tagId","assetId") VALUES ($1,$2)', [tag.body.id, item.id]);
      await request(app)
        .put('/users/me/preferences')
        .set(bearer(owner.accessToken))
        .send({ privacy: { suppression: { tagIds: [tag.body.id] } } })
        .expect(200);
      await request(app)
        .get('/tags/' + tag.body.id)
        .set(bearer(owner.accessToken))
        .expect(200);
      await request(app).post('/auth/session/lock').set(bearer(owner.accessToken)).expect(204);
      await request(app)
        .get('/tags/' + tag.body.id)
        .set(bearer(owner.accessToken))
        .expect(404);
    });
    await unlock();
    await request(app)
      .put('/users/me/preferences')
      .set(bearer(owner.accessToken))
      .send({ privacy: { suppression: { tagIds: [] } } })
      .expect(200);
  });
  await check('current foreign owner and foreign physical destination reference refuse publication', async () => {
    await refused('foreign-owner', async (item) => {
      await db.query('UPDATE asset SET "ownerId"=$1 WHERE id=$2', [foreign.userId, item.id]);
    });
    await refused('foreign-reference', async (item) => {
      await db.query('UPDATE asset SET "originalPath"=$1 WHERE id=$2', [item.path, outside.id]);
    });
  });
  await check('kept membership lost during object transfer refuses publication', async () => {
    await refused('pruned', async () => {
      await db.query('UPDATE cloud_backup_manifest SET status=$1 WHERE bucket=$2', ['failed', metadata.bucketRef]);
    });
  });
  await check('symlinked destination refuses without touching its outside bytes', async () => {
    const item = await asset('symlink.png');
    const manifest = await seed([item]);
    const outsidePath = join(mediaRoot, 'owned-fixture-outside.png');
    const bytes = makeRandomImage();
    await writeFile(outsidePath, bytes);
    await rm(local(item.path));
    await symlink('/data/owned-fixture-outside.png', local(item.path));
    const result = await restore(manifest, [item]);
    expect(result.status).toBe('failed');
    expect(await readFile(outsidePath)).toEqual(bytes);
    await rm(local(item.path));
  });
  await check('actual corrupt and short provider streams refuse before original move-aside', async () => {
    for (const corrupt of [false, true]) {
      const item = await asset('bad-stream.png');
      const manifest = await seed([item]);
      const old = await occupied(item);
      origin.objects.set('o/' + item.hash, corrupt ? Buffer.alloc(item.size, 42) : item.bytes.subarray(0, -1));
      const result = await restore(manifest, [item]);
      expect(result.status).toBe('failed');
      expect(await readFile(local(item.path))).toEqual(old);
    }
  });
  await check('real owned restart unloads the memory key and normal key unlock restores availability', async () => {
    const item = await asset('restart-key.png');
    const manifest = await seed([item]);
    await run(docker, ['--context', 'desktop-linux', 'restart', container]);
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await request(app).get('/server/ping');
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* Only owned runtime startup; preserve a bounded wait. */
      }
      await delay(250);
    }
    expect(ready, 'Own app must restart normally').toBe(true);
    await start(manifest, [item.id]).expect(409);
    await request(app)
      .post('/admin/cloud/backup/key/unlock')
      .set(bearer(admin.accessToken))
      .send({ key: bucketKey })
      .expect(200);
    const restored = await restore(manifest, [item]);
    expect(restored.status).toBe('completed');
  });
  await check('real2GiB whole-file hashing and streaming keep publication transactions short', async () => {
    const capacity = await statfs(mediaRoot, { bigint: true });
    expect(capacity.bavail * capacity.bsize, 'At least10GiB before owned 2GiB+stage fixture').toBeGreaterThanOrEqual(
      10n * 1024n ** 3n,
    );
    const item = await asset('large-whole-file.png');
    const target = local(item.path);
    const file = await open(target, 'w');
    const hash = createHash('sha256');
    let written = item.bytes.length;
    try {
      await file.writeFile(item.bytes);
      hash.update(item.bytes);
      const slab = Buffer.alloc(1024 * 1024);
      while (written < LARGE_BYTES) {
        const chunk = slab.subarray(0, Math.min(slab.length, LARGE_BYTES - written));
        await file.writeFile(chunk);
        hash.update(chunk);
        written += chunk.length;
      }
    } finally {
      await file.close();
    }
    item.size = written;
    item.hash = hash.digest('hex');
    const info = await stat(target);
    expect(info.size).toBe(LARGE_BYTES);
    await db.query('UPDATE asset SET checksum=$1 WHERE id=$2', [Buffer.from(item.hash, 'hex'), item.id]);
    origin.files.set('o/' + item.hash, { path: target, size: LARGE_BYTES });
    const manifest = await seed([item]);
    // Read-only FD signal, not a function profiler; never reads environment or nonfixture file bytes.
    const monitorProgram = [
      'const fs=require("node:fs");const target=process.argv[1];',
      String.raw`const tick=()=>{for(const p of fs.readdirSync("/proc").filter(x=>/^\d+$/.test(x))){`,
      'let f;try{f=fs.readdirSync("/proc/"+p+"/fd")}catch{continue}',
      'for(const n of f){let x;try{x=fs.readlinkSync("/proc/"+p+"/fd/"+n)}catch{continue}',
      'if(x===target||x.startsWith("/data/frameleaf/restore/"))console.log(JSON.stringify({time:Date.now(),pid:Number(p),kind:x===target?"original":"stage"}));}}};',
      'const t=setInterval(tick,100);tick();process.stdin.resume();process.stdin.on("end",()=>{clearInterval(t);process.exit(0)});',
      'setTimeout(()=>process.exit(2),180000);',
    ].join('');
    const monitor = spawn(
      docker,
      ['--context', 'desktop-linux', 'exec', '-i', container, 'node', '-e', monitorProgram, item.path],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let fdOutput = '';
    let fdErrors = '';
    monitor.stdout.on('data', (bytes: Buffer) => {
      fdOutput += bytes.toString();
    });
    monitor.stderr.on('data', (bytes: Buffer) => {
      fdErrors += bytes.toString();
    });
    const ended = new Promise<number | null>((resolve, reject) => {
      monitor.once('exit', resolve);
      monitor.once('error', reject);
    });
    const activity: Array<{ time: number; ageMs: number }> = [];
    let observing = true;
    const observe = (async () => {
      while (observing) {
        const current = await db.query(
          'SELECT COALESCE(MAX(EXTRACT(EPOCH FROM clock_timestamp()-xact_start)*1000),0) AS age FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL',
        );
        activity.push({ time: Date.now(), ageMs: Number(current.rows[0].age) });
        await delay(100);
      }
    })();
    const started = Date.now();
    try {
      const restored = await restore(manifest, [item]);
      expect(restored.status).toBe('completed');
    } finally {
      observing = false;
      await observe;
      monitor.stdin.end();
      expect(await ended).toBe(0);
    }
    expect(fdErrors).toBe('');
    const fd = fdOutput
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { time: number; kind: string; pid: number });
    const overlap = activity.filter((sample) => fd.some((event) => Math.abs(event.time - sample.time) <= 150));
    expect(fd.filter((event) => event.kind === 'original').length).toBeGreaterThanOrEqual(5);
    expect(fd.filter((event) => event.kind === 'stage').length).toBeGreaterThanOrEqual(5);
    expect(overlap.length).toBeGreaterThanOrEqual(5);
    const maximum = Math.max(...overlap.map((sample) => sample.ageMs));
    expect(maximum, 'Actual whole-file I/O must not hold a >=1s publication transaction').toBeLessThan(1000);
    expect(await fileSha(target)).toBe(item.hash);
    console.log(
      JSON.stringify({
        bytes: LARGE_BYTES,
        prefix: 'valid PNG plus deterministic padding',
        elapsedMs: Date.now() - started,
        maxConcurrentTransactionAgeMs: maximum,
        fdSamples: fd,
        transactionSamples: activity,
        functionProfiler: false,
        imageFidelityQualified: false,
      }),
    );
  });
  expect(
    origin.seen.some((seen) => seen.method === 'GET' && seen.key.startsWith('o/') && seen.signed && seen.customerKey),
  ).toBe(true);
  console.log(
    JSON.stringify({
      assertions,
      realAuth: true,
      seededProviderOnly: true,
      fullFL234: false,
      naturalPinExpiry: false,
      externalAtomicRestore: false,
    }),
  );
});
