import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import postgres from 'postgres';

// Opt-in only: an empty owned real API/worker/PG runtime. No resource/permission SQL writes.
const base = new URL(process.env.FL225_API_URL ?? 'http://127.0.0.1:0');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWMAgv8AAQQBAP8H9UQAAAAASUVORK5CYII=',
  'base64',
);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Answer = { status: number; headers: IncomingHttpHeaders; raw: Buffer; data: Record<string, any> };

const call = (
  path: string,
  method = 'GET',
  token?: string,
  headers: Record<string, string> = {},
  bytes?: Buffer,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      new URL('/api' + path, base),
      {
        method,
        headers: {
          ...headers,
          ...(token && { Authorization: `Bearer ${token}` }),
          ...(bytes && { 'Content-Length': String(bytes.length) }),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => {
          parts.push(part);
        });
        res.on('end', () => {
          const raw = Buffer.concat(parts);
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            raw,
            data:
              res.headers['content-type']?.includes('application/json') && raw.length > 0
                ? JSON.parse(raw.toString())
                : {},
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(bytes);
  });
const json = (path: string, method: string, token: string | undefined, body: unknown) =>
  call(path, method, token, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(body)));

describe('FL-225 normal HTTP atomic Live Photo publication', () => {
  let db: ReturnType<typeof postgres>;
  let owner: string;
  let foreign: string;
  let ownerId: string;
  let video: Buffer;
  const root = '/assets/uploads';
  const commit = (still: string, motion: string, token = owner) =>
    json(`${root}/live-photo/commit`, 'POST', token, { stillResourceId: still, videoResourceId: motion });
  const snapshot = async () => {
    const [count] = await db`SELECT count(*)::int AS count FROM asset WHERE "ownerId"=${ownerId}`;
    const [user] = await db`SELECT "quotaUsageInBytes" FROM "user" WHERE id=${ownerId}`;
    return { count: Number(count.count), quota: Number(user.quotaUsageInBytes) };
  };
  const begin = async (
    bytes: Buffer,
    filename: string,
    token = owner,
    declared = true,
    complete = true,
    digest = hash(bytes),
  ) => {
    const now = new Date().toISOString();
    const result = await call(
      root,
      'POST',
      token,
      {
        'content-type': filename.endsWith('.png') ? 'image/png' : 'video/mp4',
        'upload-draft-interop-version': '9',
        'upload-complete': complete ? '?1' : '?0',
        'upload-length': String(bytes.length),
        'repr-digest': `sha-256=:${Buffer.from(digest, 'hex').toString('base64')}:`,
        'asset-metadata': Buffer.from(
          JSON.stringify({
            filename,
            fileCreatedAt: now,
            fileModifiedAt: now,
            ...(declared && { publication: 'live-photo' }),
          }),
        ).toString('base64url'),
      },
      complete ? bytes : Buffer.alloc(0),
    );
    return result;
  };
  const location = (result: Answer) => {
    expect(result.headers.location).toMatch(/^\/api\/assets\/uploads\/[\da-f-]+$/);
    return result.headers.location!.replace('/api', '');
  };
  const id = (result: Answer) => location(result).split('/').at(-1)!;
  const specimen = (source: Buffer) => Buffer.concat([source, Buffer.from(randomUUID())]);
  const held = async (source: Buffer, filename: string, token = owner) => {
    const bytes = specimen(source);
    const response = await begin(bytes, filename, token);
    expect(response.status).toBe(201);
    expect(response.headers['upload-complete']).toBe('?0');
    expect(response.raw.length).toBe(0);
    const head = await call(location(response), 'HEAD', token);
    expect(head.status).toBe(204);
    expect(head.headers['upload-offset']).toBe(String(bytes.length));
    expect(head.headers['upload-complete']).toBe('?0');
    expect((await call(location(response) + '/result', 'GET', token)).status).toBe(202);
    return { response, bytes, id: id(response) };
  };
  const cancel = async (...resources: string[]) => {
    for (const resource of resources) expect((await call(`${root}/${resource}`, 'DELETE', owner)).status).toBe(204);
  };

  beforeAll(async () => {
    expect(process.env.FL225_PAIR_OWNED_RUNTIME).toBe('true');
    expect(base.protocol).toBe('http:');
    expect(base.hostname).toBe('127.0.0.1');
    expect(Number(base.port)).toBeGreaterThan(0);
    expect(process.env.FL225_PG_URL).toBeTruthy();
    db = postgres(process.env.FL225_PG_URL!, { max: 2 });
    video = await readFile(new URL('../fixtures/live-photo-motion.mp4', import.meta.url));
    const password = 'FL225-pair-fixture-password-24!';
    const email = 'pair-owner@example.test';
    // FL-292: the e2e server pins its setup code
    const setupCode = process.env.FRAMELEAF_SETUP_CODE ?? 'E2ESETUP';
    expect(
      (await json('/auth/admin-sign-up', 'POST', undefined, { email, password, name: 'Pair Owner', setupCode })).status,
    ).toBe(201);
    const login = await json('/auth/login', 'POST', undefined, { email, password });
    expect(login.status).toBe(201);
    owner = login.data.accessToken;
    const pin = { pinCode: '123456' };
    expect((await json('/auth/pin-code', 'POST', owner, pin)).status).toBe(204);
    expect((await json('/auth/session/unlock', 'POST', owner, pin)).status).toBe(204);
    const me = await call('/users/me', 'GET', owner);
    expect(me.status).toBe(200);
    ownerId = me.data.id;
    expect(
      (
        await json('/admin/users', 'POST', owner, {
          email: 'pair-foreign@example.test',
          password,
          name: 'Foreign',
          shouldChangePassword: false,
        })
      ).status,
    ).toBe(201);
    const other = await json('/auth/login', 'POST', undefined, { email: 'pair-foreign@example.test', password });
    expect(other.status).toBe(201);
    foreign = other.data.accessToken;
  });
  afterAll(async () => {
    await db?.end();
  });

  it('keeps both verified halves private, commits linked/Hidden assets with both ingestions, and replays exactly once', async () => {
    const before = await snapshot();
    const still = await held(png, 'atomic.png');
    expect(await snapshot()).toEqual(before);
    const motion = await held(video, 'atomic.mp4');
    expect(await snapshot()).toEqual(before);
    expect((await call(location(still.response), 'HEAD', foreign)).status).toBe(404);
    expect((await call(location(motion.response) + '/result', 'GET', foreign)).status).toBe(404);
    const result = await commit(still.id, motion.id);
    // No polling/retry can hide a failed required ingestion at first success.
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      still: { status: 'created', sha256: hash(still.bytes) },
      video: { status: 'created', sha256: hash(motion.bytes) },
    });
    expect(result.data.still.id).not.toBe(result.data.video.id);
    const rows =
      await db`SELECT id, state, ingested, "resultAssetId" FROM asset_upload_resource WHERE id IN (${still.id},${motion.id}) ORDER BY id`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ state: 'published', ingested: true });
    const info = await call(`/assets/${result.data.still.id}`, 'GET', owner);
    expect(info.status).toBe(200);
    expect(info.data).toMatchObject({ type: 'IMAGE', livePhotoVideoId: result.data.video.id });
    const hidden = await call(`/assets/${result.data.video.id}`, 'GET', owner);
    expect(hidden.status).toBe(200);
    expect(hidden.data).toMatchObject({ type: 'VIDEO', visibility: 'hidden' });
    for (const half of [result.data.still, result.data.video]) {
      expect((await call(`/assets/${half.id}`, 'GET', foreign)).status).toBe(400);
      const original = await call(`/assets/${half.id}/original`, 'GET', owner);
      expect(original.status).toBe(200);
      expect(hash(original.raw)).toBe(half.sha256);
    }
    const after = { count: before.count + 2, quota: before.quota + still.bytes.length + motion.bytes.length };
    expect(await snapshot()).toEqual(after);
    const replay = await commit(still.id, motion.id);
    expect(replay.status).toBe(200);
    expect(replay.data).toEqual(result.data);
    expect(await snapshot()).toEqual(after);
    for (const half of [still, motion]) {
      const head = await call(location(half.response), 'HEAD', owner);
      expect(head.status).toBe(204);
      expect(head.headers['upload-complete']).toBe('?1');
      const recovered = await call(location(half.response) + '/result', 'GET', owner);
      expect(recovered.status).toBe(200);
      expect(recovered.data).toEqual(half.id === still.id ? result.data.still : result.data.video);
    }
    console.log(
      'PASS actual held -> atomic publication -> both ingested -> exact replay, originals/SHA/quota/foreign isolation',
    );
  });

  it('refuses wrong digest, foreign/undeclared/type/duplicate halves without partial publication or quota', async () => {
    const before = await snapshot();
    const wrong = await begin(specimen(png), 'wrong.png', owner, true, true, '00'.repeat(32));
    expect(wrong.status).toBe(400);
    expect(await snapshot()).toEqual(before);
    const still = await held(png, 'negative.png');
    const motion = await held(video, 'negative.mp4');
    expect((await commit(still.id, motion.id, foreign)).status).toBe(404);
    expect((await commit(motion.id, still.id)).status).toBe(409);
    expect((await commit(still.id, still.id)).status).toBe(400);
    const foreignMotion = await held(video, 'foreign.mp4', foreign);
    expect((await commit(still.id, foreignMotion.id)).status).toBe(404);
    expect((await call(location(foreignMotion.response), 'DELETE', foreign)).status).toBe(204);
    expect(await snapshot()).toEqual(before);
    const ordinary = await begin(specimen(video), 'ordinary.mp4', owner, false, false);
    expect(ordinary.status).toBe(201);
    expect((await commit(still.id, id(ordinary))).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    await cancel(still.id, motion.id, id(ordinary));
    // Existing unrelated published image is created by the unchanged normal resource API.
    const duplicateBytes = specimen(png);
    const original = await begin(duplicateBytes, 'existing.png', owner, false);
    expect(original.status).toBe(200);
    const published = await snapshot();
    expect(published).toEqual({ count: before.count + 1, quota: before.quota + duplicateBytes.length });
    const duplicate = await begin(duplicateBytes, 'duplicate.png');
    expect(duplicate.status).toBe(201);
    const candidateVideo = await held(video, 'duplicate.mp4');
    expect((await commit(id(duplicate), candidateVideo.id)).status).toBe(409);
    expect(await snapshot()).toEqual(published);
    expect((await call(location(candidateVideo.response) + '/result', 'GET', owner)).status).toBe(202);
    const old = await call(`/assets/${original.data.id}`, 'GET', owner);
    expect(old.status).toBe(200);
    expect(old.data.livePhotoVideoId).toBeNull();
    await cancel(id(duplicate), candidateVideo.id);
    console.log('PASS actual wrong/foreign/undeclared/reversed type/duplicate refusal with no partial pair or quota');
  });
});
