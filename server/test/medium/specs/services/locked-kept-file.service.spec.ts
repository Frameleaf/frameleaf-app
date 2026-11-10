import { type LockedKeyFile, decryptFile, encryptFile, generateKeyPair, isLockedFile } from '@frameleaf/locked-crypto';
import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetVisibility, JobName, JobStatus } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LockedEncryptionRepository } from 'src/repositories/locked-encryption.repository.js';
import { LockedFileRepository } from 'src/repositories/locked-file.repository.js';
import { LockedKeyRepository } from 'src/repositories/locked-key.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { LockedSealService } from 'src/services/locked-seal.service.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import { LIBRARY_CARE_FOLDER } from 'src/utils/media-health-roots.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-1364: the damaged file Library care keeps beside a repaired photo (`asset_health.evidence.retainedPath`,
 * and the kept files Undo payloads name) is one of the photo's files, so FL-721's seal, unseal and sweep cover
 * it exactly as they cover the original: on a real filesystem, with the real registry and path locks.
 */

let db: Kysely<DB>;
let media: string;

const turnOn = (userId: string, status: 'encrypting' | 'on' = 'on') =>
  db
    .insertInto('locked_encryption')
    .values({ userId, mode: 'pin', status, recoveryKeyCreatedAt: new Date() })
    .execute();

const header = async (path: string) => (await fs.readFile(path)).subarray(0, 4).toString('latin1');

beforeAll(async () => {
  db = await getKyselyDB();
  media = await fs.mkdtemp(join(tmpdir(), 'locked-kept-'));
  StorageCore.setMediaLocation(media);
});

afterAll(async () => {
  await fs.rm(media, { recursive: true, force: true });
  await db?.destroy();
});

afterEach(() => {
  lockedKeys.clear();
});

const setup = async (options: { status?: 'encrypting' | 'on' } = {}) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const lockedEncryption = new LockedEncryptionRepository(db);
  const lockedFile = new LockedFileRepository(db, new LockedKeyRepository(), lockedEncryption);
  const keys = generateKeyPair();
  const { user } = await ctx.newUser();
  const keyFile = {
    format: 'frameleaf-locked-key/1',
    userId: user.id,
    label: 'Taylor',
    publicKey: keys.publicKey.toString('base64'),
    mode: 'pin',
    encrypting: true,
    wraps: [],
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  } as unknown as LockedKeyFile;
  const lockedKey = {
    read: vi.fn((userId: string) => Promise.resolve(userId === user.id ? structuredClone(keyFile) : null)),
    list: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(true),
  };
  const job = { queue: vi.fn().mockResolvedValue(undefined), queueAll: vi.fn().mockResolvedValue(undefined) };
  const sut = new LockedSealService(
    ctx.getMock(LoggingRepository) as never,
    lockedFile,
    lockedKey as never,
    lockedEncryption,
    job as never,
    ctx.get(DatabaseRepository),
    { serverSend: vi.fn() } as never,
    { create: vi.fn() } as never,
  );

  const folder = join(media, 'upload', user.id, randomUUID().slice(0, 2));
  const care = join(folder, LIBRARY_CARE_FOLDER);
  await fs.mkdir(care, { recursive: true });
  const original = join(care, `${randomUUID()}.jpg`);
  const originalBytes = randomBytes(90_000);
  await fs.writeFile(original, originalBytes);
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    originalPath: original,
    originalFileName: 'IMG_0001.jpg',
    visibility: AssetVisibility.Locked,
  });
  await turnOn(user.id, options.status);

  /** A repair's damaged file, kept beside the recovered copy and recorded as Library care records it. */
  const keep = async (
    options: { resolved?: boolean; write?: boolean; name?: string; undo?: Record<string, unknown> } = {},
  ) => {
    const kept = join(care, options.name ?? `${asset.id}-${randomUUID()}.damaged.jpg`);
    const bytes = randomBytes(50_000);
    if (options.write ?? true) {
      await fs.writeFile(kept, bytes);
    }
    const { rows } = await sql<{ id: string }>`
      INSERT INTO public.asset_health ("assetId", category, status, severity, "originalPath", "originalFileName",
        evidence, resolution, "checkedAt", "resolvedAt")
      VALUES (${asset.id}::uuid, 'corrupt', ${options.resolved === false ? 'corrupt_confirmed' : 'resolved'},
        'info', ${original}, 'IMG_0001.jpg', ${JSON.stringify({ fixState: 'repaired', retainedPath: kept })}::text::jsonb,
        '{}'::jsonb, now(), ${options.resolved === false ? null : new Date()})
      RETURNING id`.execute(db);
    const healthId = rows[0].id;
    await sql`INSERT INTO public.asset_health_step ("healthId", "assetId", step, outcome, undo)
      VALUES (${healthId}::uuid, ${asset.id}::uuid, 'kept-damaged', 'info',
        ${JSON.stringify(options.undo ?? { kind: 'repair', previousPath: kept, originalPath: original })}::text::jsonb)`.execute(
      db,
    );
    return { kept, bytes, healthId };
  };

  const decrypted = async (path: string) => {
    const out = join(media, `${randomUUID()}.out`);
    await decryptFile(path, out, keys.privateKey);
    const bytes = await fs.readFile(out);
    await fs.rm(out);
    return bytes;
  };
  const loadKey = () => lockedKeys.load(user.id, keys.publicKey, Buffer.from(keys.privateKey), null);
  const temporaries = async () => (await fs.readdir(care)).filter((name) => name.endsWith('.fllk.tmp'));

  return {
    ctx,
    sut,
    job,
    user,
    asset,
    keys,
    care,
    original,
    originalBytes,
    keep,
    decrypted,
    loadKey,
    temporaries,
    lockedFile,
  };
};

describe('FL-1364: Library care kept files under Locked encryption', () => {
  it('a seal encrypts the kept damaged file with the original, under the same key', async () => {
    const { sut, asset, original, originalBytes, keep, decrypted, temporaries, lockedFile } = await setup();
    const { kept, bytes } = await keep();
    // one entry, though both the finding and its Undo step name it
    expect((await lockedFile.filesOf(asset.id)).filter(({ path }) => path === kept)).toEqual([
      { path: kept, kind: 'other', table: 'asset_health', optional: true },
    ]);

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);

    expect(await header(original)).toBe('FLLK');
    expect(await header(kept)).toBe('FLLK');
    expect((await decrypted(original)).equals(originalBytes)).toBe(true);
    expect((await decrypted(kept)).equals(bytes)).toBe(true);
    expect(await temporaries()).toEqual([]);
  });

  it('covers the kept file of an open finding and the kept file an Undo payload names', async () => {
    const { sut, asset, care, original, keep } = await setup();
    // a restore moved a changed file aside; its finding is open again
    const aside = join(care, `${asset.id}-${randomUUID()}.changed.jpg`);
    await fs.writeFile(aside, randomBytes(10_000));
    const open = await keep({
      resolved: false,
      undo: { kind: 'restore', previousPath: original, originalPath: original, retainedPath: aside },
    });

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);

    expect(await header(open.kept)).toBe('FLLK');
    expect(await header(aside)).toBe('FLLK');
  });

  it('a kept file that is gone does not stop the seal or block turning on', async () => {
    const { sut, job, user, asset, original, keep } = await setup({ status: 'encrypting' });
    await keep({ write: false });

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(await header(original)).toBe('FLLK');

    // the finish check: nothing plain is left, so encryption is on
    await expect(sut.handleSweep({ userId: user.id })).resolves.toBe(JobStatus.Success);
    expect(job.queueAll).not.toHaveBeenCalled();
    await expect(
      db.selectFrom('locked_encryption').select('status').where('userId', '=', user.id).executeTakeFirst(),
    ).resolves.toEqual({ status: 'on' });
  });

  it('the sweep finds an already-sealed photo whose kept file is still plain, and the seal it queues fixes it', async () => {
    const { sut, job, user, asset, keys, original, originalBytes, keep, decrypted } = await setup({
      status: 'encrypting',
    });
    // sealed before FL-1364: the original only
    const sealed = `${original}.sealed`;
    await encryptFile(original, sealed, [{ publicKey: keys.publicKey }], {
      assetId: asset.id,
      kind: 'original',
      originalFileName: 'IMG_0001.jpg',
      mime: 'image/jpeg',
    });
    await fs.rename(sealed, original);
    const { kept, bytes } = await keep();

    await expect(sut.handleSweep({ userId: user.id })).resolves.toBe(JobStatus.Success);
    expect(job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedSeal, data: { id: asset.id } }]);
    // still turning on: the plain kept file holds it
    await expect(
      db.selectFrom('locked_encryption').select('status').where('userId', '=', user.id).executeTakeFirst(),
    ).resolves.toEqual({ status: 'encrypting' });

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(await header(kept)).toBe('FLLK');
    expect((await decrypted(kept)).equals(bytes)).toBe(true);
    expect((await decrypted(original)).equals(originalBytes)).toBe(true);
  });

  it('leaving Locked opens the kept file again, at the path its records name, before the lock goes', async () => {
    const { ctx, sut, asset, original, originalBytes, keep, loadKey, healthPaths } = {
      ...(await setup()),
      healthPaths: async (healthId: string) =>
        (
          await sql<{ retained: string; previous: string }>`
            SELECT h.evidence->>'retainedPath' AS retained, s.undo->>'previousPath' AS previous
            FROM public.asset_health h JOIN public.asset_health_step s ON s."healthId" = h.id
            WHERE h.id = ${healthId}::uuid`.execute(db)
        ).rows[0],
    };
    const { kept, bytes, healthId } = await keep();
    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(await header(kept)).toBe('FLLK');

    await ctx.get(AssetRepository).unlock([asset.id]);
    // without the key the kept file stays sealed and the lock stays
    await expect(sut.handleUnseal({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
    expect(await header(kept)).toBe('FLLK');
    expect(
      await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', asset.id).executeTakeFirst(),
    ).toBeDefined();

    loadKey();
    await expect(sut.handleUnseal({ id: asset.id })).resolves.toBe(JobStatus.Success);

    expect((await fs.readFile(kept)).equals(bytes)).toBe(true);
    expect((await fs.readFile(original)).equals(originalBytes)).toBe(true);
    expect(
      await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', asset.id).executeTakeFirst(),
    ).toBeUndefined();
    // sealed and opened in place: the finding and its Undo step still name the kept file
    await expect(healthPaths(healthId)).resolves.toEqual({ retained: kept, previous: kept });
  });

  it('never seals a kept path that another photo reads as its own file', async () => {
    const { ctx, sut, user, asset, care, keep } = await setup();
    const { kept, bytes } = await keep();
    await ctx.newAsset({ ownerId: user.id, originalPath: kept });

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);

    expect(await isLockedFile(kept)).toBe(false);
    expect((await fs.readFile(kept)).equals(bytes)).toBe(true);
    expect((await fs.readdir(care)).filter((name) => name.endsWith('.fllk.tmp'))).toEqual([]);
  });
});
