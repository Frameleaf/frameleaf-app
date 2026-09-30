import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createUserDto } from 'src/fixtures.js';
import { OwnerBackupOrigin } from 'src/fixtures/owner-backup-origin.js';
import { makeRandomImage } from 'src/generators.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, expect, it } from 'vitest';

const origin = new OwnerBackupOrigin();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const route = '/users/me/cloud-backup';
const now = '2026-09-30T12:00:00.000Z';
const manifestKey = 'm/20260930T120000Z.json.gz';
const preview = makeRandomImage();
const previewKey = `o/${sha(preview)}`;
const details = {
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

afterAll(async () => {
  await origin.close();
  await utils.disconnectDatabase();
});

/** Actual app HTTP/auth/DB/S3 transport; only historical metadata and known provider bytes are fixtures. */
it('qualifies owner history and verifies/rechecks streamed previews across genuine privacy/auth boundaries', async () => {
  expect(process.env.FL234_OWNED_RUNTIME, 'Explicit own disposable runtime opt-in is required').toBe('true');
  expect(process.env.PLAYWRIGHT_BASE_URL, 'Explicit loopback URL for the own runtime is required').toMatch(
    /^https?:\/\/127\.0\.0\.1:\d+$/,
  );
  const endpoint = await origin.start();
  await utils.resetDatabase();
  const admin = await utils.adminSetup({ onboarding: false });
  const owner = await utils.userSetup(admin.accessToken, createUserDto.user1);
  const foreign = await utils.userSetup(admin.accessToken, createUserDto.user2);
  const db = await utils.connectDatabase();
  let assertions = 0;
  const check = async (name: string, run: () => Promise<void>) => {
    await run();
    expect(origin.errors, 'provider assertion errors must never masquerade as app refusals').toEqual([]);
    assertions++;
    console.log(`PASS ${name}`);
  };
  const token = owner.accessToken;
  const pin = { pinCode: '123456' };
  await request(app).post('/auth/pin-code').set(bearer(token)).send(pin).expect(204);
  const unlock = () => request(app).post('/auth/session/unlock').set(bearer(token)).send(pin).expect(204);
  const lock = () => request(app).post('/auth/session/lock').set(bearer(token)).expect(204);
  await unlock();
  // This is a genuine normal setup/claim, never a fabricated capability or session row.
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
  const entry = (id: string, ownerId: string, bytes: Buffer, name: string, visibility = 'timeline') => ({
    owner: ownerId,
    type: 'IMAGE',
    originalFileName: name,
    fileCreatedAt: now,
    fileModifiedAt: now,
    localDateTime: now,
    duration: null,
    details: { ...details, visibility },
    files: [
      { role: 'original', path: `/fixture/original/${id}`, sha256: sha(bytes), size: bytes.length, mtime: now },
      { role: 'thumbnail', path: `/fixture/thumb/${id}`, sha256: sha(preview), size: preview.length, mtime: now },
    ],
  });
  const asset = async (name: string, ownerToken = token) => {
    const bytes = makeRandomImage();
    const result = await utils.createAsset(ownerToken, { assetData: { bytes, filename: name } });
    // SHA256 source identity fixture uses the exact uploaded bytes; no auth/ownership flags are changed.
    await db.query('UPDATE asset SET checksum=$1,"checksumAlgorithm"=$2 WHERE id=$3', [
      Buffer.from(sha(bytes), 'hex'),
      'sha256',
      result.id,
    ]);
    return { id: result.id, bytes };
  };
  const ordinary = await asset('owner-trash.png');
  const locked = await asset('owner-locked.png');
  const deleted = await asset('owner-deleted.png');
  const outsider = await asset('foreign-name.png', foreign.accessToken);
  await request(app)
    .post('/assets/lock')
    .set(bearer(token))
    .send({ ids: [locked.id] })
    .expect(204);
  // Seed current trash and actual physical deletion through real table/trigger; backup production is out of scope.
  await db.query('UPDATE asset SET status=$1,"deletedAt"=clock_timestamp() WHERE id=ANY($2::uuid[])', [
    'trashed',
    [ordinary.id, locked.id, outsider.id],
  ]);
  await db.query('DELETE FROM asset WHERE id=$1', [deleted.id]);
  const unknown = randomUUID();
  const manifest = {
    format: 'frameleaf-backup-manifest',
    version: 2,
    instanceId: metadata.instanceId,
    createdAt: now,
    database: null,
    profiles: {},
    albums: {},
    people: {},
    assets: {
      [ordinary.id]: entry(ordinary.id, owner.userId, ordinary.bytes, 'owner-trash.png'),
      [locked.id]: entry(locked.id, owner.userId, locked.bytes, 'owner-locked.png', 'locked'),
      [deleted.id]: entry(deleted.id, owner.userId, deleted.bytes, 'owner-deleted.png'),
      // A lying historical owner does not override the actual current foreign owner.
      [outsider.id]: entry(outsider.id, owner.userId, outsider.bytes, 'foreign-name.png'),
      [unknown]: entry(unknown, owner.userId, preview, 'unknown-date.png'),
    },
  };
  const seed = async (key: string, value: unknown = manifest) => {
    origin.objects.set(key, gzipSync(Buffer.from(JSON.stringify(value))));
    await db.query(
      'INSERT INTO cloud_backup_manifest (bucket,key,status,"finishedAt") VALUES ($1,$2,$3,clock_timestamp())',
      [metadata.bucketRef, key, 'complete'],
    );
  };
  await seed(manifestKey);
  origin.objects.set(previewKey, preview);
  const history = (credentials: Record<string, string> = bearer(token), key = manifestKey, query = '') =>
    request(app).get(`${route}/history`).set(credentials).query({ manifestKey: key, query });
  const thumb = (id = ordinary.id, credentials: Record<string, string> = bearer(token), key = manifestKey) =>
    request(app).get(`${route}/history/${id}/thumbnail`).set(credentials).query({ manifestKey: key }).buffer(true);
  await lock();

  await check('owner discovery/history filters before count/search/page and exposes actual/unknown dates', async () => {
    const response = await history().expect(200);
    expect(response.body.total).toBe(2);
    expect(
      response.body.items
        .map((item: { assetId: string }) => item.assetId)
        .toSorted((a: string, b: string) => a.localeCompare(b)),
    ).toEqual([ordinary.id, deleted.id].toSorted((a: string, b: string) => a.localeCompare(b)));
    expect(
      response.body.items.find((item: { assetId: string }) => item.assetId === deleted.id).deletionDate,
    ).toMatchObject({ state: 'available', at: expect.any(String) });
    expect(response.body.items.find((item: { assetId: string }) => item.assetId === ordinary.id).deletionDate).toEqual({
      state: 'unavailable',
      at: null,
    });
    const search = await history(bearer(token), manifestKey, 'foreign-name').expect(200);
    expect(search.body.total).toBe(0);
    const firstPage = await history().query({ limit: 1 }).expect(200);
    expect(firstPage.body.items).toHaveLength(1);
    const discovery = await request(app).get(`${route}/backups`).set(bearer(token)).expect(200);
    expect(discovery.body).toEqual({
      backups: [{ manifestKey, backupDate: now, status: 'complete' }],
      nextOffset: null,
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /fixture\/|keyFingerprint|secretAccessKey|foreign-name|unknown-date/,
    );
  });
  await check('foreign and nonowner admin never inherit names/counts/thumb access', async () => {
    for (const account of [foreign, admin]) {
      const foreignHistory = await history(bearer(account.accessToken)).expect(200);
      expect(foreignHistory.body).toEqual({
        items: [],
        total: 0,
        nextOffset: null,
      });
      const foreignBackups = await request(app).get(`${route}/backups`).set(bearer(account.accessToken)).expect(200);
      expect(foreignBackups.body).toEqual({
        backups: [],
        nextOffset: null,
      });
      await thumb(ordinary.id, bearer(account.accessToken)).expect(404);
    }
  });
  await check(
    'genuine read key can read metadata but cannot obtain bytes; view key obtains only owned bytes',
    async () => {
      const read = await request(app)
        .post('/api-keys')
        .set(bearer(token))
        .send({ name: 'history read', permissions: ['asset.read'] })
        .expect(201);
      const view = await request(app)
        .post('/api-keys')
        .set(bearer(token))
        .send({ name: 'history preview', permissions: ['asset.view'] })
        .expect(201);
      await history({ 'x-api-key': read.body.secret }).expect(200);
      await thumb(ordinary.id, { 'x-api-key': read.body.secret }).expect(403);
      const bytes = await thumb(ordinary.id, { 'x-api-key': view.body.secret }).expect(200);
      expect(bytes.body).toEqual(preview);
      expect(bytes.headers['cache-control']).toBe('private, no-store');
      expect(bytes.headers['x-content-type-options']).toBe('nosniff');
      await thumb(locked.id, { 'x-api-key': view.body.secret }).expect(404);
    },
  );
  await check(
    'normal PIN unlock admits Locked; browse never refreshes real expiry; normal relock refuses',
    async () => {
      await unlock();
      const { body: sessions } = await request(app).get('/sessions').set(bearer(token)).expect(200);
      const id = sessions.find((session: { current: boolean }) => session.current).id;
      const beforeRow = await db.query('SELECT "pinExpiresAt" FROM session WHERE id=$1', [id]);
      const before = beforeRow.rows[0].pinExpiresAt;
      const unlockedHistory = await history().expect(200);
      expect(unlockedHistory.body.total).toBe(3);
      await thumb(locked.id).expect(200);
      const afterRow = await db.query('SELECT "pinExpiresAt" FROM session WHERE id=$1', [id]);
      const after = afterRow.rows[0].pinExpiresAt;
      expect(after).toEqual(before);
      await lock();
      await thumb(locked.id).expect(404);
    },
  );
  const interleave = async (
    name: string,
    id: string,
    run: () => Promise<void>,
    status: number,
    credentials: Record<string, string> = bearer(token),
  ) =>
    check(name, async () => {
      origin.beforeRead = { key: previewKey, run };
      const response = await thumb(id, credentials);
      expect(origin.errors, 'Provider hook must succeed before asserting app refusal').toEqual([]);
      expect(response.status).toBe(status);
      expect(origin.beforeRead).toBeNull();
    });
  await unlock();
  await interleave(
    'normal relock during actual provider I/O refuses stale Locked bytes',
    locked.id,
    async () => {
      await lock();
    },
    404,
  );
  await unlock();
  await interleave(
    'normal PIN change during actual provider I/O revokes old elevation',
    locked.id,
    async () => {
      await request(app)
        .put('/auth/pin-code')
        .set(bearer(token))
        .send({ pinCode: '123456', newPinCode: '123457' })
        .expect(204);
    },
    404,
  );
  await request(app)
    .put('/auth/pin-code')
    .set(bearer(token))
    .send({ pinCode: '123457', newPinCode: '123456' })
    .expect(204);
  const coordinator = await request(app)
    .post('/auth/login')
    .send({ email: createUserDto.user1.email, password: createUserDto.user1.password })
    .expect(201);
  const coordinatorAuth = bearer(coordinator.body.accessToken);
  await request(app).post('/auth/session/unlock').set(coordinatorAuth).send(pin).expect(204);
  await interleave(
    'normal suppression update during I/O refuses absent historical classification',
    deleted.id,
    async () => {
      await request(app)
        .put('/users/me/preferences')
        .set(coordinatorAuth)
        .send({ privacy: { suppression: { tagIds: [randomUUID()] } } })
        .expect(200);
    },
    404,
  );
  await request(app)
    .put('/users/me/preferences')
    .set(coordinatorAuth)
    .send({ privacy: { suppression: { tagIds: [] } } })
    .expect(200);
  const secondary = await request(app)
    .post('/auth/login')
    .send({ email: createUserDto.user1.email, password: createUserDto.user1.password })
    .expect(201);
  const revokedToken = secondary.body.accessToken;
  const { body: revokeSessions } = await request(app).get('/sessions').set(bearer(revokedToken)).expect(200);
  const revokeId = revokeSessions.find((session: { current: boolean }) => session.current).id;
  await interleave(
    'normal session deletion during actual provider I/O refuses stale credentials',
    ordinary.id,
    async () => {
      await request(app).delete(`/sessions/${revokeId}`).set(bearer(token)).expect(204);
    },
    401,
    bearer(revokedToken),
  );
  await check('short/corrupt/long actual streams return no preview', async () => {
    for (const body of [
      preview.subarray(0, -1),
      Buffer.alloc(preview.length, 42),
      Buffer.concat([preview, Buffer.alloc(8 * 1024 * 1024)]),
    ]) {
      origin.objects.set(previewKey, body);
      const response = await thumb().expect(409);
      expect(response.body).not.toEqual(preview);
    }
    origin.objects.set(previewKey, preview);
  });
  await check('declared preview above8MiB refused before provider read', async () => {
    const key = 'm/20260930T120001Z.json.gz';
    const copy = structuredClone(manifest);
    copy.assets[ordinary.id].files[1].size = 8 * 1024 * 1024 + 1;
    await seed(key, copy);
    const before = origin.seen.filter((seen) => seen.key === previewKey).length;
    await thumb(ordinary.id, bearer(token), key).expect(404);
    expect(origin.seen.filter((seen) => seen.key === previewKey)).toHaveLength(before);
  });
  await check('v1 and null historical details fail closed despite a present own trashed row', async () => {
    const records = [
      { key: 'm/20260930T120002Z.json.gz', value: { ...manifest, version: 1 } },
      {
        key: 'm/20260930T120003Z.json.gz',
        value: { ...manifest, assets: { [ordinary.id]: { ...manifest.assets[ordinary.id], details: null } } },
      },
    ];
    for (const record of records) {
      await seed(record.key, record.value);
      const result = await history(bearer(token), record.key).expect(200);
      expect(result.body).toEqual({ items: [], total: 0, nextOffset: null });
      await thumb(ordinary.id, bearer(token), record.key).expect(404);
    }
  });
  await check('loaded-key identity required even on cached manifest', async () => {
    await db.query('UPDATE system_metadata SET value=jsonb_set(value,$1,$2::jsonb) WHERE key=$3', [
      '{keyFingerprint}',
      JSON.stringify('unloaded-fixture-fingerprint'),
      'frameleaf-cloud-backup',
    ]);
    await history().expect(409);
    await db.query('UPDATE system_metadata SET value=jsonb_set(value,$1,$2::jsonb) WHERE key=$3', [
      '{keyFingerprint}',
      JSON.stringify(metadata.keyFingerprint),
      'frameleaf-cloud-backup',
    ]);
    await history().expect(200);
  });
  await interleave(
    'kept membership pruning during actual I/O invalidates cached manifest and bytes',
    ordinary.id,
    async () => {
      await db.query('UPDATE cloud_backup_manifest SET status=$1 WHERE bucket=$2 AND key=$3', [
        'failed',
        metadata.bucketRef,
        manifestKey,
      ]);
    },
    404,
  );
  await check('pruned cache refuses metadata and discovery contains no pruned backup', async () => {
    await history().expect(404);
    const pruned = await request(app).get(`${route}/backups`).set(bearer(token)).expect(200);
    expect(pruned.body.backups.some((row: { manifestKey: string }) => row.manifestKey === manifestKey)).toBe(false);
    expect(
      origin.seen.some((seen) => seen.key === previewKey && seen.method === 'GET' && seen.signed && seen.customerKey),
    ).toBe(true);
  });
  console.log(
    JSON.stringify({
      assertions,
      normalAuth: true,
      actualAppResponses: true,
      seededMetadataAndProviderBytes: true,
      naturalSixtyMinuteExpiryMeasured: false,
      providerEncryptionCertified: false,
    }),
  );
});
