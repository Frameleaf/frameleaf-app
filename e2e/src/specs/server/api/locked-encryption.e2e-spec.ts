import {
  AssetEditAction,
  AssetJobName,
  getConfig,
  LoginResponseDto,
  QueueCommand,
  QueueName,
  updateConfig,
} from '@frameleaf/sdk';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, tempDir, testAssetDir, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * FL-721 acceptance (spec §15) over the API, against a running server: files on disk start with
 * `FLLK` while Locked encryption is on and match their checksums after it is turned off; every reader
 * still works; a restart, the ask-again time and Lock now drop the key; partners, the admin guard, the
 * CLI on a copy of the library, and no secret in the logs or the database.
 *
 * The stack is either the compose stack (server in `immich-e2e-server`) or a native server with the
 * compose Postgres. For a native server set:
 * - `FRAMELEAF_E2E_RESTART`: a shell command that restarts the server and returns once it listens;
 * - `FRAMELEAF_E2E_SERVER_LOG`: the server's log file;
 * - `FRAMELEAF_E2E_MEDIA_DIR`: its `FRAMELEAF_MEDIA_LOCATION`.
 * The server must run with `FRAMELEAF_ENV=testing` and `FRAMELEAF_LOCKED_TEST_HOUR_MS` (an ask-again
 * hour in milliseconds; 500 makes 8 hours 4 seconds), and a RAM-backed `FRAMELEAF_LOCKED_TMP` (or
 * `FRAMELEAF_LOCKED_TMP_ALLOW_DISK=true` where there is none).
 */

const run = promisify(execFile);
const SERVER_CONTAINER = 'immich-e2e-server';
const DATABASE_CONTAINER = 'immich-e2e-postgres';
const CONTAINER_MEDIA = '/data';
const MAGIC = Buffer.from('FLLK');
const HOUR_MS = Number(process.env.FRAMELEAF_LOCKED_TEST_HOUR_MS ?? 500);
const repoRoot = resolve(import.meta.dirname, '../../../../..');
const cliBin = join(repoRoot, 'packages/cli/bin/frameleaf');

// every secret the run types; the last test greps the logs and a database dump for all of them
const pinCodes = {
  pinOwner: '730514',
  advOwner: '861927',
  partner: '402683',
  late: '519374',
  twin: '638205',
  newcomer: '927461',
};
const ADV_PASSPHRASE = 'correct horse battery staple 7Qv';
const SWITCHED_PASSPHRASE = 'velvet orchard comet thimble 9Zr';
/** advOwner's passphrase now: the second one after the switch to PIN and back. */
const passphrases = { adv: ADV_PASSPHRASE };
const recoveryKeys: string[] = [];
const privateKeys: string[] = [];

/** Matches `needle` only where it isn't part of a longer token (base64, hex, digits). */
const asWholeWord = (needle: string) =>
  new RegExp(`(?<![0-9A-Za-z+/=_.-])${needle.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(?![0-9A-Za-z+/=_.-])`);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const byText = (a: string, b: string) => a.localeCompare(b);
const idsOf = (list: { id: string }[]) => list.map(({ id }) => id);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64');

const waitFor = async <T>(label: string, check: () => Promise<T | undefined | false>, ms = 60_000, every = 250) => {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined && value !== false) {
        return value;
      }
    } catch (error) {
      last = error;
    }
    await sleep(every);
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: last });
};

// ---- the server's files, logs and database, whichever stack runs it ----

const nativeMedia = process.env.FRAMELEAF_E2E_MEDIA_DIR;

const readServerFile = async (path: string): Promise<Buffer> => {
  if (nativeMedia || existsSync(path)) {
    return readFile(path);
  }
  const { stdout } = await run('docker', ['exec', SERVER_CONTAINER, 'cat', path], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  return stdout;
};

const isSealed = async (path: string) => {
  const bytes = await readServerFile(path);
  return bytes.subarray(0, 4).equals(MAGIC);
};

const restartServer = async () => {
  const command = process.env.FRAMELEAF_E2E_RESTART;
  await (command ? run('bash', ['-c', command]) : run('docker', ['restart', SERVER_CONTAINER]));
  await waitFor(
    'the server to answer after the restart',
    async () => {
      const response = await fetch(`${app}/server/ping`);
      return response.ok;
    },
    180_000,
    1000,
  );
};

const serverLogs = async () => {
  const file = process.env.FRAMELEAF_E2E_SERVER_LOG;
  if (file) {
    return readFile(file, 'utf8');
  }
  const { stdout, stderr } = await run('docker', ['logs', SERVER_CONTAINER], { maxBuffer: 512 * 1024 * 1024 });
  return stdout + stderr;
};

const databaseDump = async () => {
  const { stdout } = await run('docker', ['exec', DATABASE_CONTAINER, 'pg_dump', '-U', 'postgres', 'frameleaf'], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  return stdout;
};

/** A copy of the whole library (media folder) in a new temporary folder. */
const copyLibrary = async () => {
  const target = await mkdtemp(join(tempDir, 'fl721-library-'));
  if (nativeMedia) {
    await cp(nativeMedia, target, { recursive: true });
  } else {
    await run('docker', ['cp', `${SERVER_CONTAINER}:${CONTAINER_MEDIA}/.`, target]);
  }
  return target;
};

const libraryPath = (copy: string, serverPath: string) => {
  const root = nativeMedia ?? CONTAINER_MEDIA;
  return join(copy, serverPath.slice(root.length));
};

// ---- API helpers ----

/**
 * Waits until a queue has no unfinished work. Unlike `utils.waitForQueueFinish`, a failed job is
 * allowed: RAW previews need the server image's RAW renderer, which a native server may not have.
 */
const settle = (accessToken: string, name: QueueName, ms = 120_000) =>
  waitFor(
    `queue ${name} to settle`,
    async () => {
      const { body } = await request(app).get(`/queues/${name}`).set(bearer(accessToken));
      return body.hasUnfinishedWork === false;
    },
    ms,
    500,
  );

const locked = (token: string) => request(app).get('/users/me/locked-encryption').set(bearer(token));
const status = async (token: string) => {
  const { status: code, body } = await locked(token);
  expect(code).toBe(200);
  return body as {
    enabled: boolean;
    mode: 'pin' | 'advanced' | null;
    status: 'encrypting' | 'on' | 'decrypting' | null;
    keyLoaded: boolean;
    expiresAt: string | null;
    askAgainHours: number | null;
    counts: { encrypted: number; notEncryptable: number; missing?: number };
  };
};

const keyLoaded = async (token: string) => {
  const current = await status(token);
  return current.keyLoaded;
};
const stateOf = async (token: string) => {
  const current = await status(token);
  return current.status;
};
const statusOf = async (test: request.Test) => {
  const response = await test;
  return response.status;
};

/** Unlocks the session with the PIN (again: an unlocked session is locked first). */
const unlockSession = async (token: string, pinCode: string) => {
  const { status: code, body } = await request(app).post('/auth/session/unlock').set(bearer(token)).send({ pinCode });
  if (code === 400 && /already/i.test(String(body?.message))) {
    return;
  }
  expect(code, JSON.stringify(body)).toBe(204);
};
const lockSession = (token: string) => request(app).post('/auth/session/lock').set(bearer(token)).expect(204);

const lockAssets = (token: string, ids: string[]) =>
  request(app).post('/assets/lock').set(bearer(token)).send({ ids }).expect(204);

const upload = async (token: string, path: string, filename = path.split('/').pop()!) => {
  const bytes = await readFile(path);
  const asset = await utils.createAsset(token, { assetData: { bytes, filename } });
  return { id: asset.id, bytes };
};

const original = (token: string, id: string) =>
  request(app)
    .get(`/assets/${id}/original`)
    .set(bearer(token))
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });

const binary = (test: request.Test) =>
  test.buffer(true).parse((response, callback) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  });

/** Every stored path of the item (original, sidecar, generated files) and of its live-photo video. */
const filesOf = async (assetId: string): Promise<{ key: string; path: string }[]> => {
  const db = await utils.connectDatabase();
  const { rows } = await db.query<{ key: string; path: string }>(
    `WITH item AS (
       SELECT id FROM asset WHERE id = $1
       UNION SELECT "livePhotoVideoId" FROM asset WHERE id = $1 AND "livePhotoVideoId" IS NOT NULL
     )
     SELECT asset.id || ':original' AS key, asset."originalPath" AS path FROM asset JOIN item USING (id)
     UNION ALL
     SELECT file."assetId" || ':' || file.type || ':' || file."isEdited", file.path
       FROM asset_file file JOIN item ON item.id = file."assetId"`,
    [assetId],
  );
  return rows.filter(({ path }) => !!path);
};

/** The item's own original (not its live-photo video's). */
const originalOf = async (assetId: string) => {
  const files = await filesOf(assetId);
  const file = files.find(({ key }) => key === `${assetId}:original`);
  if (!file) {
    throw new Error(`No original for ${assetId}`);
  }
  return file;
};

/** key → path of every stored file of these items. */
const pathMap = async (assetIds: string[]) => {
  const lists = await Promise.all(assetIds.map((id) => filesOf(id)));
  return new Map(lists.flat().map((file) => [file.key, file.path]));
};

/** Waits until the item has its preview (a deferred job elsewhere can keep a whole queue busy). */
const waitForPreview = (assetId: string) =>
  waitFor(
    `a preview of ${assetId}`,
    async () => {
      const files = await filesOf(assetId);
      return files.some(({ key }) => key.startsWith(`${assetId}:preview:`));
    },
    120_000,
    500,
  );

const hashFiles = async (assetIds: string[]) => {
  const hashes = new Map<string, string>();
  for (const id of assetIds) {
    for (const { key, path } of await filesOf(id)) {
      hashes.set(key, sha256(await readServerFile(path)));
    }
  }
  return hashes;
};

const allSealed = async (assetIds: string[]) => {
  for (const id of assetIds) {
    const files = await filesOf(id);
    if (files.length === 0) {
      return false;
    }
    for (const { path } of files) {
      if (!(await isSealed(path))) {
        return false;
      }
    }
  }
  return true;
};

const nonePlainSealed = async (assetIds: string[]) => {
  for (const id of assetIds) {
    for (const { path } of await filesOf(id)) {
      if (await isSealed(path)) {
        return false;
      }
    }
  }
  return true;
};

const waitSealed = (assetIds: string[], ms = 120_000) =>
  waitFor(`files of ${assetIds.length} items to be encrypted`, () => allSealed(assetIds), ms, 500);
const waitPlain = (assetIds: string[], ms = 120_000) =>
  waitFor(`files of ${assetIds.length} items to be decrypted`, () => nonePlainSealed(assetIds), ms, 500);

const expectKeyUnavailable = (response: request.Response, mode?: 'pin' | 'advanced') => {
  expect(response.status).toBe(423);
  const body = Buffer.isBuffer(response.body) ? JSON.parse(response.body.toString('utf8')) : response.body;
  expect(body.code).toBe('locked_key_unavailable');
  // the settings routes name the mode; a refused read only says which key it waits for
  if (mode && body.mode !== undefined) {
    expect(body.mode).toBe(mode);
  }
};

const turnOn = async (token: string, body: { mode: 'pin' | 'advanced'; pinCode: string; passphrase?: string }) => {
  const {
    status: code,
    body: result,
    headers,
  } = await request(app).post('/users/me/locked-encryption').set(bearer(token)).send(body);
  expect(code).toBe(201);
  expect(headers['cache-control']).toContain('no-store');
  expect(result.recoveryKey).toMatch(/^FLRK(-[A-Z2-7]{4}){8}$/);
  recoveryKeys.push(result.recoveryKey);
  return result.recoveryKey as string;
};

type LockedCrypto = {
  unwrapKey: (file: unknown, kind: 'pin' | 'passphrase' | 'recovery', secret: string) => Promise<Buffer>;
  readHeader: (path: string) => Promise<{ keyIds: Buffer[] }>;
};
const lockedCrypto = (): Promise<LockedCrypto> =>
  import(join(repoRoot, 'packages/locked-crypto/dist/index.js')) as Promise<LockedCrypto>;

/** How many people the encrypted file at `path` is encrypted to (its recipient entries). */
const recipientCount = async (path: string) => {
  const copy = join(await mkdtemp(join(tempDir, 'fl721-header-')), 'file');
  try {
    await writeFile(copy, await readServerFile(path));
    const crypto = await lockedCrypto();
    const header = await crypto.readHeader(copy);
    return header.keyIds.length;
  } finally {
    await rm(join(copy, '..'), { recursive: true, force: true });
  }
};

/** The private key (opened from the key file with the recovery key) in three encodings, for the secret grep. */
const rememberPrivateKey = async (userId: string, recoveryKey: string) => {
  const path = join(nativeMedia ?? CONTAINER_MEDIA, 'locked-keys', `${userId}.json`);
  const bytes = await readServerFile(path);
  const crypto = await lockedCrypto();
  const key = await crypto.unwrapKey(JSON.parse(bytes.toString('utf8')), 'recovery', recoveryKey);
  privateKeys.push(key.toString('base64'), key.toString('hex'), key.toString('base64url'));
};

const runCli = async (library: string, to: string, user: string, secret: string) => {
  const child = execFile('node', [cliBin, 'locked', 'decrypt', '--library', library, '--to', to, '--user', user]);
  child.stdin?.end(`${secret}\n`);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += chunk));
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise<number>((done) => child.on('close', (exit) => done(exit ?? -1)));
  return { code, stdout, stderr };
};

describe('Locked encryption acceptance (FL-721, spec §15)', () => {
  let admin: LoginResponseDto;
  let pinOwner: LoginResponseDto;
  let advOwner: LoginResponseDto;
  let partner: LoginResponseDto;
  let late: LoginResponseDto;
  let twin: LoginResponseDto;
  let newcomer: LoginResponseDto;

  // pinOwner's library: a photo, a video, a live photo, a RAW and an edited photo
  const items: Record<'photo' | 'video' | 'live' | 'raw' | 'edited', { id: string; bytes: Buffer }> = {} as never;
  let pinIds: string[] = [];
  let beforeHashes: Map<string, string>;
  let pinRecoveryKey: string;

  // advOwner's library
  let advItems: { id: string; bytes: Buffer }[] = [];
  let advRecoveryKey: string;
  // the late user's PIN-mode library, shared with partners
  let pinShare: { id: string; bytes: Buffer };

  const workDirs: string[] = [];

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    pinOwner = await utils.userSetup(admin.accessToken, createUserDto.create('fl721-pin'));
    advOwner = await utils.userSetup(admin.accessToken, createUserDto.create('fl721-adv'));
    partner = await utils.userSetup(admin.accessToken, createUserDto.create('fl721-partner'));
    late = await utils.userSetup(admin.accessToken, createUserDto.create('fl721-late'));
    twin = await utils.userSetup(admin.accessToken, createUserDto.create('fl721-twin'));
    // no PIN yet, so no key pair: a partner who arrives after the owner's files are encrypted
    newcomer = await utils.userSetup(admin.accessToken, createUserDto.create('fl721-newcomer'));
    for (const [user, pinCode] of [
      [pinOwner, pinCodes.pinOwner],
      [advOwner, pinCodes.advOwner],
      [partner, pinCodes.partner],
      [late, pinCodes.late],
      [twin, pinCodes.twin],
    ] as const) {
      await request(app).post('/auth/pin-code').set(bearer(user.accessToken)).send({ pinCode }).expect(204);
    }

    items.photo = await upload(pinOwner.accessToken, `${testAssetDir}/albums/nature/el_torcal_rocks.jpg`);
    items.video = await upload(pinOwner.accessToken, `${testAssetDir}/videos/eiffel-tower.mp4`);
    items.live = await upload(pinOwner.accessToken, `${testAssetDir}/formats/motionphoto/pixel-8a.jpg`);
    items.raw = await upload(pinOwner.accessToken, `${testAssetDir}/formats/raw/Canon/EOS_30D.CR2`);
    items.edited = await upload(pinOwner.accessToken, `${testAssetDir}/albums/nature/wood_anemones.jpg`);
    advItems = [
      await upload(advOwner.accessToken, `${testAssetDir}/albums/nature/silver_fir.jpg`),
      await upload(advOwner.accessToken, `${testAssetDir}/albums/nature/tanners_ridge.jpg`),
      await upload(advOwner.accessToken, `${testAssetDir}/albums/nature/prairie_falcon.jpg`),
    ];
    for (const queue of [
      QueueName.Sidecar,
      QueueName.MetadataExtraction,
      QueueName.ThumbnailGeneration,
      QueueName.VideoConversion,
    ]) {
      await settle(admin.accessToken, queue, 180_000);
    }
    await request(app)
      .put(`/assets/${items.edited.id}/edits`)
      .set(bearer(pinOwner.accessToken))
      .send({ edits: [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }] })
      .expect(200);
    await settle(admin.accessToken, QueueName.ThumbnailGeneration, 120_000);
    await settle(admin.accessToken, QueueName.Editor, 120_000);
    pinIds = Object.values(items).map(({ id }) => id);
  }, 600_000);

  afterAll(async () => {
    for (const dir of workDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('PIN mode: turning on, reading, turning off', () => {
    it('encrypts every file of a photo, a video, a live photo, a RAW and an edited item', async () => {
      await unlockSession(pinOwner.accessToken, pinCodes.pinOwner);
      await lockAssets(pinOwner.accessToken, pinIds);
      // the live photo's video is its own item, locked with the photo
      const live = await utils.getAssetInfo(pinOwner.accessToken, items.live.id);
      expect(live.livePhotoVideoId).toBeTruthy();
      const db = await utils.connectDatabase();
      const { rows: edits } = await db.query('SELECT 1 FROM asset_edit WHERE "assetId" = $1', [items.edited.id]);
      expect(edits.length).toBeGreaterThan(0);

      beforeHashes = await hashFiles(pinIds);
      expect(beforeHashes.size).toBeGreaterThanOrEqual(pinIds.length * 2);
      for (const { id, bytes } of Object.values(items)) {
        expect(beforeHashes.get(`${id}:original`)).toBe(sha256(bytes));
      }

      pinRecoveryKey = await turnOn(pinOwner.accessToken, { mode: 'pin', pinCode: pinCodes.pinOwner });
      await waitSealed(pinIds);
      const current = await status(pinOwner.accessToken);
      expect(current).toMatchObject({ enabled: true, mode: 'pin', keyLoaded: true });
      await waitFor('every Locked item to count as encrypted', async () => {
        const { counts } = await status(pinOwner.accessToken);
        return counts.encrypted >= pinIds.length;
      });
      await rememberPrivateKey(pinOwner.userId, pinRecoveryKey);
    }, 300_000);

    it('serves originals, thumbnails and previews of encrypted items', async () => {
      for (const { id, bytes } of Object.values(items)) {
        const response = await original(pinOwner.accessToken, id);
        expect(response.status).toBe(200);
        expect(sha256(response.body)).toBe(sha256(bytes));
        const generated = await filesOf(id);
        for (const size of ['thumbnail', 'preview']) {
          if (generated.every(({ key }) => !key.includes(`:${size}:`))) {
            // a RAW preview needs the server image's RAW renderer; its original is checked above
            expect(id).toBe(items.raw.id);
            continue;
          }
          const view = await binary(
            request(app).get(`/assets/${id}/thumbnail`).query({ size }).set(bearer(pinOwner.accessToken)),
          );
          expect(view.status).toBe(200);
          expect(view.body.length).toBeGreaterThan(0);
          expect(view.body.subarray(0, 4).equals(MAGIC)).toBe(false);
        }
      }
    });

    it('seeks in an encrypted video with Range requests, across a segment boundary', async () => {
      const full = await binary(
        request(app).get(`/assets/${items.video.id}/video/playback`).set(bearer(pinOwner.accessToken)),
      );
      expect(full.status).toBe(200);
      expect(full.body.subarray(0, 4).equals(MAGIC)).toBe(false);
      const plainHash = sha256(full.body);
      const known = [...beforeHashes].filter(([key]) => key.startsWith(items.video.id)).map(([, h]) => h);
      expect(known).toContain(plainHash);

      for (const [start, end] of [
        [0, 99],
        [65_530, 65_545],
        [1_000_000, 1_200_000],
        [full.body.length - 10, full.body.length - 1],
      ]) {
        const part = await binary(
          request(app)
            .get(`/assets/${items.video.id}/video/playback`)
            .set(bearer(pinOwner.accessToken))
            .set('Range', `bytes=${start}-${end}`),
        );
        expect(part.status).toBe(206);
        expect(part.headers['content-range']).toBe(`bytes ${start}-${end}/${full.body.length}`);
        expect(part.body.equals(full.body.subarray(start, end + 1))).toBe(true);
      }
    });

    it('downloads a zip of encrypted items', async () => {
      const { status: code, body } = await binary(
        request(app)
          .post('/download/archive')
          .set(bearer(pinOwner.accessToken))
          .send({ assetIds: [items.photo.id, items.raw.id] }),
      );
      expect(code).toBe(200);
      const dir = await mkdtemp(join(tempDir, 'fl721-zip-'));
      workDirs.push(dir);
      await writeFile(join(dir, 'archive.zip'), body);
      await utils.unzip(join(dir, 'archive.zip'), join(dir, 'out'));
      const extracted = await readdir(join(dir, 'out'));
      const names = extracted.filter((name) => /\.(jpg|cr2)$/i.test(name));
      const hashes = await Promise.all(names.map(async (name) => sha256(await readFile(join(dir, 'out', name)))));
      expect(hashes.toSorted(byText), JSON.stringify(extracted)).toEqual(
        [sha256(items.photo.bytes), sha256(items.raw.bytes)].toSorted(byText),
      );
    });

    it('still finds encrypted items in search, memories and people', async () => {
      const { status: code, body } = await request(app)
        .post('/search/metadata')
        .set(bearer(pinOwner.accessToken))
        .send({ visibility: 'locked', originalFileName: 'el_torcal_rocks' });
      expect(code).toBe(200);
      expect(body.assets.items.map(({ id }: { id: string }) => id)).toContain(items.photo.id);

      const { body: memory } = await request(app)
        .post('/memories')
        .set(bearer(pinOwner.accessToken))
        .send({
          type: 'on_this_day',
          data: { year: 2020 },
          memoryAt: '2020-06-15T00:00:00.000Z',
          assetIds: [items.photo.id],
        })
        .expect(201);
      const { body: read } = await request(app).get(`/memories/${memory.id}`).set(bearer(pinOwner.accessToken));
      expect(read.assets.map(({ id }: { id: string }) => id)).toContain(items.photo.id);

      // a person whose face is on an encrypted photo gets a thumbnail cut from the encrypted preview
      const person = await utils.createPerson(pinOwner.accessToken, { name: 'FL-721 Face' });
      await utils.createFace({ assetId: items.photo.id, personGroupId: person.id, imageWidth: 640, imageHeight: 480 });
      const { body: faces } = await request(app)
        .get('/faces')
        .query({ id: items.photo.id })
        .set(bearer(pinOwner.accessToken));
      expect(faces.length).toBeGreaterThan(0);
    });

    it('moves encrypted files with the storage template, and they still open', async () => {
      const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });
      await updateConfig(
        {
          adminConfigDto: {
            ...config,
            storageTemplate: { ...config.storageTemplate, enabled: true, template: '{{y}}/fl721/{{filename}}' },
          },
        },
        { headers: asBearerAuth(admin.accessToken) },
      );
      try {
        const before = await pathMap(pinIds);
        await utils.queueCommand(admin.accessToken, QueueName.StorageTemplateMigration, {
          command: QueueCommand.Start,
        });
        await settle(admin.accessToken, QueueName.StorageTemplateMigration, 120_000);
        const moved = await waitFor('the photo to move', async () => {
          const file = await originalOf(items.photo.id);
          return file.path !== before.get(file.key) && file.path.includes('/fl721/') ? file : undefined;
        });
        expect(await isSealed(moved.path)).toBe(true);
        await waitSealed(pinIds);
        for (const { id, bytes } of Object.values(items)) {
          const response = await original(pinOwner.accessToken, id);
          expect(response.status).toBe(200);
          expect(sha256(response.body)).toBe(sha256(bytes));
        }
      } finally {
        await updateConfig({ adminConfigDto: config }, { headers: asBearerAuth(admin.accessToken) });
      }
    }, 180_000);

    it('never lets the health and integrity scans mark, move or delete an encrypted file', async () => {
      const before = await pathMap(pinIds);
      for (const name of ['integrity-missing-files', 'integrity-untracked-files', 'integrity-checksum-mismatch']) {
        await utils.createJob(admin.accessToken, { name: name as never });
      }
      await settle(admin.accessToken, QueueName.IntegrityCheck, 180_000);
      const { status: corrupt } = await request(app)
        .post('/media-health/corrupt/scan')
        .set(bearer(pinOwner.accessToken))
        .send({});
      expect([200, 201, 202, 204]).toContain(corrupt);
      const { status: missing } = await request(app)
        .post('/media-health/missing/scan')
        .set(bearer(pinOwner.accessToken))
        .send({});
      expect([200, 201, 202, 204]).toContain(missing);
      await settle(admin.accessToken, QueueName.MediaHealth, 180_000);

      // the delete-all actions of the reports must not trash an encrypted item either
      for (const name of [
        'integrity-missing-files-delete-all',
        'integrity-untracked-files-delete-all',
        'integrity-checksum-mismatch-delete-all',
      ]) {
        await utils.createJob(admin.accessToken, { name: name as never });
      }
      await settle(admin.accessToken, QueueName.IntegrityCheck, 180_000);

      const db = await utils.connectDatabase();
      const { rows } = await db.query(
        `SELECT id, "deletedAt", status FROM asset WHERE id = ANY($1::uuid[]) AND ("deletedAt" IS NOT NULL OR status <> 'active')`,
        [pinIds],
      );
      expect(rows).toEqual([]);
      const { rows: reports } = await db.query(
        `SELECT type, path FROM integrity_report WHERE "assetId" = ANY($1::uuid[]) OR path = ANY($2::text[])`,
        [pinIds, before.values().toArray()],
      );
      expect(reports).toEqual([]);
      const after = await pathMap(pinIds);
      expect(after).toEqual(before);
      expect(await allSealed(pinIds)).toBe(true);
    }, 600_000);

    it('drops the PIN-mode key when the session locks; a job needing it waits and runs on the next unlock', async () => {
      await lockSession(pinOwner.accessToken);
      await waitFor('the key to drop', async () => !(await keyLoaded(pinOwner.accessToken)));

      const db = await utils.connectDatabase();
      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Start,
        force: true,
      });
      await waitFor('a thumbnail job to wait for the key', async () => {
        const { rows } = await db.query(
          `SELECT id FROM job WHERE state = 'pending' AND "dependencyReason" = 'locked-key-unavailable'
             AND data->>'id' = ANY($1::text[])`,
          [pinIds],
        );
        return rows.length > 0;
      });

      await unlockSession(pinOwner.accessToken, pinCodes.pinOwner);
      expect(await keyLoaded(pinOwner.accessToken)).toBe(true);
      await settle(admin.accessToken, QueueName.ThumbnailGeneration, 120_000);
      const { rows } = await db.query(
        `SELECT id FROM job WHERE "dependencyReason" = 'locked-key-unavailable' AND data->>'id' = ANY($1::text[])`,
        [pinIds],
      );
      expect(rows).toEqual([]);
      await waitSealed(pinIds);
    }, 300_000);

    it('refuses an administrator clearing the PIN, and a PIN reset with the password', async () => {
      const url = `/admin/users/${pinOwner.userId}`;
      const { status: code, body } = await request(app).put(url).set(bearer(admin.accessToken)).send({ pinCode: null });
      expect(code, JSON.stringify(body)).toBe(409);
      // PATCH carries the same guard
      const { status: patched, body: patchBody } = await request(app)
        .patch(url)
        .set(bearer(admin.accessToken))
        .send({ pinCode: null });
      expect(patched, JSON.stringify(patchBody)).toBe(409);
      const { body: user } = await request(app)
        .get(`/admin/users/${pinOwner.userId}`)
        .set(bearer(admin.accessToken))
        .expect(200);
      expect(user.lockedEncryption).toBe(true);

      const { status: reset } = await request(app)
        .delete('/auth/pin-code')
        .set(bearer(pinOwner.accessToken))
        .send({ password: createUserDto.create('fl721-pin').password });
      expect(reset).toBe(409);
    });

    it('turns off: every file matches its original checksum again', async () => {
      await unlockSession(pinOwner.accessToken, pinCodes.pinOwner);
      await request(app)
        .delete('/users/me/locked-encryption')
        .set(bearer(pinOwner.accessToken))
        .send({ pinCode: pinCodes.pinOwner })
        .expect(204);
      await waitPlain(pinIds);
      for (const { id, bytes } of Object.values(items)) {
        const file = await originalOf(id);
        expect(sha256(await readServerFile(file.path))).toBe(sha256(bytes));
      }
      // generated files are the same plain bytes they were before, unless a test regenerated them
      const after = await hashFiles(pinIds);
      for (const [key, hash] of after) {
        if (key.endsWith(':original')) {
          expect(hash).toBe(beforeHashes.get(key));
        }
      }
      // the last step (deleting the key) follows a couple of minutes later, in the background
      expect([null, 'decrypting']).toContain(await stateOf(pinOwner.accessToken));
    }, 300_000);
  });

  describe('Advanced Security', () => {
    it('turns on with a passphrase and encrypts', async () => {
      await unlockSession(advOwner.accessToken, pinCodes.advOwner);
      await lockAssets(advOwner.accessToken, idsOf(advItems));
      advRecoveryKey = await turnOn(advOwner.accessToken, {
        mode: 'advanced',
        pinCode: pinCodes.advOwner,
        passphrase: passphrases.adv,
      });
      await waitSealed(idsOf(advItems));
      expect(await status(advOwner.accessToken)).toMatchObject({ mode: 'advanced', keyLoaded: true });
      await rememberPrivateKey(advOwner.userId, advRecoveryKey);
    }, 180_000);

    it('after a restart: 423, an upload to Locked is encrypted, the passphrase opens everything', async () => {
      await restartServer();
      // the PIN unlock may survive the restart; the key never does
      await unlockSession(advOwner.accessToken, pinCodes.advOwner);
      expect(await keyLoaded(advOwner.accessToken)).toBe(false);
      const response = await original(advOwner.accessToken, advItems[0].id);
      expectKeyUnavailable(response, 'advanced');
      const thumb = await request(app).get(`/assets/${advItems[0].id}/thumbnail`).set(bearer(advOwner.accessToken));
      expectKeyUnavailable(thumb, 'advanced');

      // a new item put in Locked is encrypted without the passphrase (only the public key is needed)
      const added = await upload(advOwner.accessToken, `${testAssetDir}/albums/nature/notocactus_minimus.jpg`);
      await waitFor('the new item to be processed', async () => {
        const files = await filesOf(added.id);
        return files.some(({ key }) => key.includes(':preview:')) ? files : undefined;
      });
      await lockAssets(advOwner.accessToken, [added.id]);
      advItems.push(added);
      await waitSealed([added.id]);

      await request(app)
        .post('/users/me/locked-encryption/unlock')
        .set(bearer(advOwner.accessToken))
        .send({ passphrase: passphrases.adv })
        .expect(204);
      expect(await keyLoaded(advOwner.accessToken)).toBe(true);
      for (const { id, bytes } of advItems) {
        const opened = await original(advOwner.accessToken, id);
        expect(opened.status).toBe(200);
        expect(sha256(opened.body)).toBe(sha256(bytes));
      }
    }, 300_000);

    it('rejects a wrong passphrase', async () => {
      const { status: code } = await request(app)
        .post('/users/me/locked-encryption/unlock')
        .set(bearer(advOwner.accessToken))
        .send({ passphrase: 'not the passphrase at all' });
      expect([400, 401, 403]).toContain(code);
    });

    it('drops the key after the ask-again time (8 hours)', async () => {
      await request(app)
        .put('/users/me/locked-encryption')
        .set(bearer(advOwner.accessToken))
        .send({ askAgainHours: 8 })
        .expect(204);
      await request(app)
        .post('/users/me/locked-encryption/unlock')
        .set(bearer(advOwner.accessToken))
        .send({ passphrase: passphrases.adv })
        .expect(204);
      const opened = await status(advOwner.accessToken);
      expect(opened.keyLoaded).toBe(true);
      expect(opened.askAgainHours).toBe(8);
      const left = Date.parse(opened.expiresAt!) - Date.now();
      if (left > 60_000) {
        throw new Error(
          `The key expires in ${Math.round(left / 60_000)} minutes: the server is not running with FRAMELEAF_LOCKED_TEST_HOUR_MS=${HOUR_MS} (and FRAMELEAF_ENV=testing)`,
        );
      }
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThanOrEqual(8 * HOUR_MS + 1000);

      await waitFor('the key to expire', async () => !(await keyLoaded(advOwner.accessToken)), 8 * HOUR_MS + 30_000);
      expectKeyUnavailable(await original(advOwner.accessToken, advItems[0].id), 'advanced');
      // and in the job workers too: a job needing the key waits for it
      const db = await utils.connectDatabase();
      await request(app)
        .post('/assets/jobs')
        .set(bearer(advOwner.accessToken))
        .send({ assetIds: [advItems[0].id], name: AssetJobName.RegenerateThumbnail })
        .expect(204);
      await waitFor('the thumbnail job to wait for the key', async () => {
        const { rows } = await db.query(
          `SELECT id FROM job WHERE state = 'pending' AND "dependencyReason" = 'locked-key-unavailable'
             AND data->>'id' = $1`,
          [advItems[0].id],
        );
        return rows.length > 0;
      });
      await request(app)
        .put('/users/me/locked-encryption')
        .set(bearer(advOwner.accessToken))
        .send({ askAgainHours: 72 })
        .expect(204);
    }, 120_000);

    it('drops the key on Lock now', async () => {
      await request(app)
        .post('/users/me/locked-encryption/unlock')
        .set(bearer(advOwner.accessToken))
        .send({ passphrase: passphrases.adv })
        .expect(204);
      expect(await statusOf(original(advOwner.accessToken, advItems[0].id))).toBe(200);
      await request(app).post('/users/me/locked-encryption/lock').set(bearer(advOwner.accessToken)).expect(204);
      expect(await keyLoaded(advOwner.accessToken)).toBe(false);
      expectKeyUnavailable(await original(advOwner.accessToken, advItems[0].id), 'advanced');
    });

    it('unlocking an item: it asks for the key, then stays hidden until its files are plain', async () => {
      const item = advItems.at(-1)!;
      await unlockSession(advOwner.accessToken, pinCodes.advOwner);
      // the key is closed (Lock now above): taking the item out of Locked asks for the passphrase
      const refused = await request(app)
        .post('/assets/unlock')
        .set(bearer(advOwner.accessToken))
        .send({ ids: [item.id] });
      expectKeyUnavailable(refused, 'advanced');
      expect(await allSealed([item.id])).toBe(true);

      await request(app)
        .post('/users/me/locked-encryption/unlock')
        .set(bearer(advOwner.accessToken))
        .send({ passphrase: passphrases.adv })
        .expect(204);
      // hold the decrypting so the in-between state can be seen
      await utils.queueCommand(admin.accessToken, QueueName.BackgroundTask, { command: QueueCommand.Pause });
      try {
        await request(app)
          .post('/assets/unlock')
          .set(bearer(advOwner.accessToken))
          .send({ ids: [item.id] })
          .expect(204);
        await lockSession(advOwner.accessToken);
        const hidden = await request(app).get(`/assets/${item.id}`).set(bearer(advOwner.accessToken));
        // a locked session doesn't see a Locked item at all, so it never shows as a timeline item
        expect([400, 403, 404], JSON.stringify(hidden.body)).toContain(hidden.status);
        expect(await allSealed([item.id])).toBe(true);
      } finally {
        await utils.queueCommand(admin.accessToken, QueueName.BackgroundTask, { command: QueueCommand.Resume });
      }
      await waitPlain([item.id]);
      const shown = await waitFor('the item to be back in the timeline', async () => {
        const { status: code, body } = await request(app).get(`/assets/${item.id}`).set(bearer(advOwner.accessToken));
        return code === 200 && body.visibility === 'timeline' ? body : undefined;
      });
      expect(shown.id).toBe(item.id);
      const opened = await original(advOwner.accessToken, item.id);
      expect(sha256(opened.body)).toBe(sha256(item.bytes));
      advItems.pop();
    }, 180_000);
  });

  describe('Shared physical file', () => {
    it('locking one of two identical items leaves the other readable', async () => {
      const path = `${testAssetDir}/albums/nature/cyclamen_persicum.jpg`;
      const mine = await upload(advOwner.accessToken, path);
      const theirs = await upload(twin.accessToken, path);
      await waitForPreview(mine.id);
      await waitForPreview(theirs.id);
      const db = await utils.connectDatabase();
      const { rows } = await db.query<{ id: string; originalPath: string; physical: string | null }>(
        `SELECT id, "originalPath", "physicalOriginalFileId" AS physical FROM asset WHERE id = ANY($1::uuid[])`,
        [[mine.id, theirs.id]],
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      const shared =
        byId.get(mine.id)!.originalPath === byId.get(theirs.id)!.originalPath ||
        (!!byId.get(mine.id)!.physical && byId.get(mine.id)!.physical === byId.get(theirs.id)!.physical);
      expect(shared).toBe(true);

      expect(await statusOf(request(app).get(`/assets/${theirs.id}/thumbnail`).set(bearer(twin.accessToken)))).toBe(
        200,
      );

      await unlockSession(advOwner.accessToken, pinCodes.advOwner);
      await request(app)
        .post('/users/me/locked-encryption/unlock')
        .set(bearer(advOwner.accessToken))
        .send({ passphrase: passphrases.adv })
        .expect(204);
      await lockAssets(advOwner.accessToken, [mine.id]);
      advItems.push(mine);
      await waitSealed([mine.id]);

      const their = await originalOf(theirs.id);
      const my = await originalOf(mine.id);
      expect(their.path).not.toBe(my.path);
      expect(await isSealed(their.path)).toBe(false);
      expect(sha256(await readServerFile(their.path))).toBe(sha256(theirs.bytes));
      const read = await original(twin.accessToken, theirs.id);
      expect(read.status).toBe(200);
      expect(sha256(read.body)).toBe(sha256(theirs.bytes));
      const view = await binary(request(app).get(`/assets/${theirs.id}/thumbnail`).set(bearer(twin.accessToken)));
      expect(view.status).toBe(200);
      expect(view.body.subarray(0, 4).equals(MAGIC)).toBe(false);
    }, 180_000);
  });

  describe('Partners', () => {
    let pinShareKey: string;

    it('owner in PIN mode: a partner opens shared Locked items with their own PIN', async () => {
      // pinOwner is still turning off; a fresh PIN-mode owner (the late user's library) shares with partner
      pinShare = await upload(late.accessToken, `${testAssetDir}/albums/nature/orychophragmus_violaceus.jpg`);
      await waitForPreview(pinShare.id);
      await unlockSession(late.accessToken, pinCodes.late);
      await lockAssets(late.accessToken, [pinShare.id]);
      await utils.createPartner(late.accessToken, partner.userId);
      const copyId = await utils.waitForPartnerCopy(partner.userId, pinShare.id);
      pinShareKey = await turnOn(late.accessToken, { mode: 'pin', pinCode: pinCodes.late });
      await waitSealed([pinShare.id]);
      await rememberPrivateKey(late.userId, pinShareKey);

      // the partner's own PIN, and nothing of the owner's, opens it, even with the owner's key closed
      await lockSession(late.accessToken);
      await waitFor('the owner key to drop', async () => !(await keyLoaded(late.accessToken)));
      await unlockSession(partner.accessToken, pinCodes.partner);
      const opened = await waitFor('the partner copy to open', async () => {
        const response = await original(partner.accessToken, copyId);
        return response.status === 200 ? response : undefined;
      });
      expect(sha256(opened.body)).toBe(sha256(pinShare.bytes));
    }, 180_000);

    it('owner in PIN mode: a new partner opens them after the owner next unlocks', async () => {
      // sharing a library needs an unlocked session; the owner's key is open meanwhile
      await unlockSession(late.accessToken, pinCodes.late);
      await utils.createPartner(late.accessToken, newcomer.userId);
      const copyId = await utils.waitForPartnerCopy(newcomer.userId, pinShare.id);
      await lockSession(late.accessToken);
      await waitFor('the owner key to drop', async () => !(await keyLoaded(late.accessToken)));

      // the new partner sets a PIN (their key pair) while the owner's key is closed
      await request(app)
        .post('/auth/pin-code')
        .set(bearer(newcomer.accessToken))
        .send({ pinCode: pinCodes.newcomer })
        .expect(204);
      await unlockSession(newcomer.accessToken, pinCodes.newcomer);
      await sleep(2000);
      const { body: info } = await request(app).get(`/assets/${copyId}`).set(bearer(newcomer.accessToken)).expect(200);
      expect(info.lockedEncryption).toMatchObject({ openable: false, reason: 'not-ready' });
      expectKeyUnavailable(await original(newcomer.accessToken, copyId));

      // the owner's next unlock adds the new partner's entry
      await unlockSession(late.accessToken, pinCodes.late);
      const opened = await waitFor('the new partner copy to open', async () => {
        const response = await original(newcomer.accessToken, copyId);
        return response.status === 200 ? response : undefined;
      });
      expect(sha256(opened.body)).toBe(sha256(pinShare.bytes));
      await lockSession(late.accessToken);
    }, 120_000);

    it('owner in Advanced Security: the partner types the owner passphrase; switching mode adds or removes access', async () => {
      await unlockSession(advOwner.accessToken, pinCodes.advOwner);
      await utils.createPartner(advOwner.accessToken, partner.userId);
      const source = advItems[0];
      const copyId = await utils.waitForPartnerCopy(partner.userId, source.id);
      // the owner's key closed: the partner is asked for the owner's passphrase
      await request(app).post('/users/me/locked-encryption/lock').set(bearer(advOwner.accessToken)).expect(204);
      await unlockSession(partner.accessToken, pinCodes.partner);
      const { body: info } = await request(app).get(`/assets/${copyId}`).set(bearer(partner.accessToken)).expect(200);
      expect(info.lockedEncryption).toMatchObject({ openable: false, reason: 'owner-passphrase' });
      expectKeyUnavailable(await original(partner.accessToken, copyId));

      await request(app)
        .post('/users/me/locked-encryption/partner-unlock')
        .set(bearer(partner.accessToken))
        .send({ ownerId: advOwner.userId, passphrase: passphrases.adv })
        .expect(204);
      const opened = await original(partner.accessToken, copyId);
      expect(opened.status).toBe(200);
      expect(sha256(opened.body)).toBe(sha256(source.bytes));

      // switching the owner to PIN adds the partner's own entry: no passphrase needed any more
      await unlockSession(advOwner.accessToken, pinCodes.advOwner);
      await request(app)
        .put('/users/me/locked-encryption')
        .set(bearer(advOwner.accessToken))
        .send({ mode: 'pin', currentSecret: passphrases.adv, pinCode: pinCodes.advOwner })
        .expect(204);
      const sourceFile = await originalOf(source.id);
      expect(await recipientCount(sourceFile.path)).toBe(1);
      await waitFor('the partner entry to be added', async () => (await recipientCount(sourceFile.path)) === 2);
      await request(app).post('/users/me/locked-encryption/lock').set(bearer(advOwner.accessToken)).expect(204);
      await unlockSession(partner.accessToken, pinCodes.partner);
      const viaPin = await waitFor('the partner to open with their own PIN', async () => {
        const response = await original(partner.accessToken, copyId);
        return response.status === 200 ? response : undefined;
      });
      expect(sha256(viaPin.body)).toBe(sha256(source.bytes));

      // and back to Advanced Security removes it again
      await unlockSession(advOwner.accessToken, pinCodes.advOwner);
      await request(app)
        .put('/users/me/locked-encryption')
        .set(bearer(advOwner.accessToken))
        .send({ mode: 'advanced', currentSecret: pinCodes.advOwner, newPassphrase: SWITCHED_PASSPHRASE })
        .expect(204);
      await waitFor('the partner entry to be removed', async () => (await recipientCount(sourceFile.path)) === 1);
      passphrases.adv = SWITCHED_PASSPHRASE;
      await request(app).post('/users/me/locked-encryption/lock').set(bearer(advOwner.accessToken)).expect(204);
      const { body: after } = await request(app).get(`/assets/${copyId}`).set(bearer(partner.accessToken));
      expect(after.lockedEncryption).toMatchObject({ openable: false, reason: 'owner-passphrase' });
      expectKeyUnavailable(await original(partner.accessToken, copyId));
    }, 240_000);
  });

  describe('CLI recovery on a copy of the library', () => {
    it('recovers originals with the passphrase, the PIN and the recovery key; reports tampered and truncated files', async () => {
      const library = await copyLibrary();
      workDirs.push(library);
      const outDir = await mkdtemp(join(tempDir, 'fl721-cli-'));
      workDirs.push(outDir);

      const expected = advItems.map(({ bytes }) => sha256(bytes)).toSorted(byText);
      const decrypt = async (name: string, user: string, secret: string) => {
        const to = join(outDir, name);
        const result = await runCli(library, to, user, secret);
        const names = existsSync(to) ? await readdir(to) : [];
        const hashes = await Promise.all(names.map(async (file) => sha256(await readFile(join(to, file)))));
        return { ...result, hashes: hashes.toSorted(byText) };
      };

      const withPassphrase = await decrypt('passphrase', advOwner.userId, passphrases.adv);
      expect(withPassphrase.code, withPassphrase.stderr).toBe(0);
      expect(withPassphrase.hashes).toEqual(expected);

      const withRecovery = await decrypt('recovery', advOwner.userId, advRecoveryKey);
      expect(withRecovery.code, withRecovery.stderr).toBe(0);
      expect(withRecovery.hashes).toEqual(expected);

      const withPin = await decrypt('pin', late.userId, pinCodes.late);
      expect(withPin.code, withPin.stderr).toBe(0);
      expect(withPin.hashes).toEqual([sha256(pinShare.bytes)]);

      // tamper with one encrypted original and truncate another
      const [tampered, truncated] = await Promise.all(
        advItems.slice(0, 2).map(async ({ id }) => {
          const file = await originalOf(id);
          return libraryPath(library, file.path);
        }),
      );
      const bytes = await readFile(tampered);
      bytes[bytes.length - 100] ^= 0xff;
      await writeFile(tampered, bytes);
      const { size } = await stat(truncated);
      await truncate(truncated, Math.floor(size / 2));

      const broken = await decrypt('broken', advOwner.userId, passphrases.adv);
      expect(broken.code).toBe(1);
      expect(broken.stderr).toContain(tampered);
      expect(broken.stderr).toContain(truncated);
      expect(broken.hashes).toEqual(
        advItems
          .slice(2)
          .map(({ bytes }) => sha256(bytes))
          .toSorted(byText),
      );
      const written = await readdir(join(outDir, 'broken'));
      expect(written.some((name) => name.endsWith('.fllk.tmp'))).toBe(false);
    }, 180_000);
  });

  describe('Turning off across a restart', () => {
    it('stops decrypting at a restart, asks for the secret, and resumes', async () => {
      const ids = advItems.map(({ id }) => id);
      await unlockSession(advOwner.accessToken, pinCodes.advOwner);
      // hold the background queue so the restart lands while files are still encrypted
      await utils.queueCommand(admin.accessToken, QueueName.BackgroundTask, { command: QueueCommand.Pause });
      try {
        await request(app)
          .delete('/users/me/locked-encryption')
          .set(bearer(advOwner.accessToken))
          .send({ passphrase: passphrases.adv })
          .expect(204);
        expect(await stateOf(advOwner.accessToken)).toBe('decrypting');
        await restartServer();
        await unlockSession(advOwner.accessToken, pinCodes.advOwner);
        const after = await status(advOwner.accessToken);
        expect(after).toMatchObject({ status: 'decrypting', keyLoaded: false });
        expect(await allSealed(ids)).toBe(true);
        expectKeyUnavailable(await original(advOwner.accessToken, ids[0]), 'advanced');
      } finally {
        await utils.queueCommand(admin.accessToken, QueueName.BackgroundTask, { command: QueueCommand.Resume });
      }
      // nothing is decrypted without the key
      await sleep(3000);
      expect(await allSealed(ids)).toBe(true);

      await request(app)
        .delete('/users/me/locked-encryption')
        .set(bearer(advOwner.accessToken))
        .send({ passphrase: passphrases.adv })
        .expect(204);
      await waitPlain(ids);
      for (const { id, bytes } of advItems) {
        const file = await originalOf(id);
        expect(sha256(await readServerFile(file.path))).toBe(sha256(bytes));
      }
    }, 400_000);
  });

  describe('Secrets', () => {
    it('no PIN, passphrase, recovery key or private key is in the logs, the database or the library', async () => {
      const needles = [
        ...Object.values(pinCodes),
        ADV_PASSPHRASE,
        SWITCHED_PASSPHRASE,
        ...recoveryKeys,
        ...recoveryKeys.map((key) => key.replaceAll('-', '')),
        ...privateKeys,
      ];
      expect(recoveryKeys.length).toBeGreaterThanOrEqual(3);
      expect(privateKeys.length).toBeGreaterThanOrEqual(9);

      const found = (haystack: string) => needles.filter((needle) => asWholeWord(needle).test(haystack));

      const logs = await serverLogs();
      expect(logs.length).toBeGreaterThan(1000);
      expect(found(logs)).toEqual([]);

      const dump = await databaseDump();
      expect(dump).toContain('locked_encryption');
      expect(found(dump)).toEqual([]);

      // every file of the library except the wrapped key files
      const library = await copyLibrary();
      workDirs.push(library);
      const hits: string[] = [];
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (full !== join(library, 'locked-keys')) {
              await walk(full);
            }
          } else if (entry.isFile()) {
            const content = await readFile(full);
            const text = content.toString('latin1');
            for (const needle of found(text)) {
              hits.push(`${full}: ${needle.slice(0, 4)}…`);
            }
          }
        }
      };
      await walk(library);
      expect(hits).toEqual([]);
    }, 300_000);
  });
});
