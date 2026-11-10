import { LoginResponseDto } from '@frameleaf/sdk';
import { createHash } from 'node:crypto';
import { createUserDto } from 'src/fixtures.js';
import { makeRandomImage } from 'src/generators.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const stepsOf = async (healthId: string) => {
  const db = await utils.connectDatabase();
  const { rows } = await db.query(
    'SELECT step, outcome, facts FROM public.asset_health_step WHERE "healthId" = $1 ORDER BY at, id',
    [healthId],
  );
  return rows as Array<{ step: string; outcome: string; facts: Record<string, unknown> }>;
};

type Lost = { id: string; checksum: Buffer; size: number; healthId: string };

/**
 * An uploaded photo that now counts as lost: a checksum of its contents on record (SHA-1 for an Immich-era photo,
 * SHA-256 for every upload since FL-1108) and an open missing problem waiting on phones.
 */
const lose = async (accessToken: string, name: string, algorithm: 'sha1' | 'sha256' = 'sha1'): Promise<Lost> => {
  const bytes = makeRandomImage(32, 32);
  const { id } = await utils.createAsset(accessToken, { assetData: { bytes, filename: `${name}.png` } });
  const checksum = createHash(algorithm).update(name).digest();
  const db = await utils.connectDatabase();
  await db.query(`UPDATE public.asset SET checksum = $1, "checksumAlgorithm" = $2 WHERE id = $3`, [
    checksum,
    algorithm,
    id,
  ]);
  // the size the metadata read takes from the file, on record now so the list need not wait for that read
  await db.query(
    `INSERT INTO public.asset_exif ("assetId", "fileSizeInByte") VALUES ($1, $2)
     ON CONFLICT ("assetId") DO UPDATE SET "fileSizeInByte" = EXCLUDED."fileSizeInByte"`,
    [id, bytes.length],
  );
  const { rows } = await db.query(
    `INSERT INTO public.asset_health ("assetId", category, status, severity, "originalPath", "originalFileName", evidence, resolution, "checkedAt")
     SELECT id, 'missing', 'missing', 'critical', "originalPath", "originalFileName", '{"fixState":"waiting-phone"}', '{}', now()
     FROM public.asset WHERE id = $1 RETURNING id`,
    [id],
  );
  return { id, checksum, size: bytes.length, healthId: rows[0].id as string };
};
const listed = ({ id, checksum, size }: Lost) => ({
  assetId: id,
  checksum: checksum.toString('base64'),
  originalFileName: expect.any(String),
  fileCreatedAt: expect.any(String),
  fileSize: size,
});
const list = (accessToken: string, query = '') =>
  request(app).get(`/assets/lost-originals${query}`).set('Authorization', `Bearer ${accessToken}`);
const report = (accessToken: string, notHere: string[]) =>
  request(app)
    .post('/assets/lost-originals/checked')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ deviceId: 'device-1', notHere });

/** FL-1337: phones fetch the photos the server lost, and say which of them they do not have. */
describe('/assets/lost-originals', () => {
  let user1: LoginResponseDto;
  let user2: LoginResponseDto;
  let mine: Lost;
  let uploaded: Lost;
  let theirs: Lost;

  beforeAll(async () => {
    await utils.resetDatabase();
    const admin = await utils.adminSetup({ onboarding: false });
    [user1, user2] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
    ]);
    // Only a phone or tablet answers for the phones, and a test login is neither: make both accounts' sessions iOS.
    const db = await utils.connectDatabase();
    await db.query(`UPDATE public.session SET "deviceOS" = 'iOS', "deviceType" = 'iPhone' WHERE "userId" = ANY($1)`, [
      [user1.userId, user2.userId],
    ]);
    mine = await lose(user1.accessToken, 'mine');
    uploaded = await lose(user1.accessToken, 'uploaded', 'sha256');
    theirs = await lose(user2.accessToken, 'theirs');
  });

  describe('GET /assets/lost-originals', () => {
    it('requires authentication', async () => {
      const { status } = await request(app).get('/assets/lost-originals');
      expect(status).toBe(401);
    });

    it('lists only the caller’s own lost originals, by base64 checksum and file size', async () => {
      const { status, body } = await list(user1.accessToken);

      expect(status).toBe(200);
      expect(body.hasNextPage).toBe(false);
      // FL-1347: a photo stored with SHA-256 (every upload since FL-1108) is listed as well as an Immich-era one
      expect(body.items).toHaveLength(2);
      expect(body.items).toEqual(expect.arrayContaining([listed(mine), listed(uploaded)]));
      expect(JSON.stringify(body)).not.toContain(theirs.id);
    });

    it('pages, and refuses a page larger than 1000', async () => {
      const first = await list(user1.accessToken, '?take=1');
      expect(first.body).toMatchObject({ items: [expect.any(Object)], hasNextPage: true });
      const { body } = await list(user1.accessToken, '?take=1&skip=2');
      expect(body).toEqual({ items: [], hasNextPage: false });

      const { status } = await list(user1.accessToken, '?take=1001');
      expect(status).toBe(400);
    });
  });

  describe('POST /assets/lost-originals/checked', () => {
    it('requires authentication', async () => {
      const { status } = await request(app)
        .post('/assets/lost-originals/checked')
        .send({ deviceId: 'device-1', notHere: [] });
      expect(status).toBe(401);
    });

    it('answers 204, and records a phone only once for its own problem', async () => {
      const checksum = mine.checksum.toString('base64');

      const first = await report(user1.accessToken, [checksum]);
      const second = await report(user1.accessToken, [checksum]);
      expect([first.status, second.status]).toEqual([204, 204]);

      const steps = await stepsOf(mine.healthId);
      expect(steps.filter(({ step }) => step === 'checked-on-phone')).toEqual([
        { step: 'checked-on-phone', outcome: 'not-found', facts: expect.objectContaining({ deviceId: 'device-1' }) },
      ]);
    });

    it('ignores another account’s checksums and ones nobody lost, still answering 204', async () => {
      const unknown = createHash('sha1').update('nobody').digest('base64');

      const { status } = await report(user1.accessToken, [theirs.checksum.toString('base64'), unknown, 'not base64']);

      expect(status).toBe(204);

      expect(await stepsOf(theirs.healthId)).toEqual([]);
    });

    it('settles a photo stored with SHA-256 once its only phone reports it by that checksum (FL-1347)', async () => {
      const db = await utils.connectDatabase();
      await db.query(
        `INSERT INTO public.asset_health_step ("healthId", "assetId", step, outcome, facts)
         VALUES ($1, $2, 'asked-phones', 'waiting', '{"phones":1}')`,
        [uploaded.healthId, uploaded.id],
      );

      const { status } = await report(user1.accessToken, [uploaded.checksum.toString('base64')]);

      expect(status).toBe(204);
      const steps = await stepsOf(uploaded.healthId);
      expect(steps.map(({ step, outcome }) => `${step}/${outcome}`)).toEqual([
        'asked-phones/waiting',
        'checked-on-phone/not-found',
        'asked-phones/not-found',
      ]);
      const { rows } = await db.query(`SELECT evidence FROM public.asset_health WHERE id = $1`, [uploaded.healthId]);
      expect(rows[0].evidence).toMatchObject({ fixState: 'missing' });
    });

    it('refuses a report of more than 1000 checksums', async () => {
      const { status } = await report(
        user1.accessToken,
        Array.from({ length: 1001 }, (_, index) => String(index)),
      );
      expect(status).toBe(400);
    });
  });
});
