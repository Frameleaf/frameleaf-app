import {
  type LockedKeyFile,
  decryptFile,
  encryptFile,
  generateKeyPair,
  generateRecoveryKey,
  unwrapKey,
  wrapKey,
} from '@frameleaf/locked-crypto';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudBackupRestorer,
  countEncryptedWithOlderKey,
  emptyRestoreResult,
  restorePlan,
} from 'src/services/cloud-backup-restore.js';
import { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { LOCKED_KEY_BACKUP_ROLE } from 'src/utils/locked-backup.js';

const OWNER = '00000000-0000-4000-8000-000000000001';
const ASSET = '00000000-0000-4000-8000-0000000000a1';
const PASSPHRASE = 'correct horse battery staple';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** An Advanced-mode key file: a passphrase wrap and a recovery wrap, never a PIN wrap (spec §4.2). */
const advancedKeyFile = async (recoveryKey: string) => {
  const pair = generateKeyPair();
  const now = new Date().toISOString();
  let file: Omit<LockedKeyFile, 'wraps'> & { wraps?: LockedKeyFile['wraps'] } = {
    format: 'frameleaf-locked-key/1',
    userId: OWNER,
    label: 'Taylor',
    publicKey: pair.publicKey.toString('base64'),
    mode: 'advanced',
    encrypting: false,
    createdAt: now,
    updatedAt: now,
  };
  file = await wrapKey(file, pair.privateKey, 'passphrase', PASSPHRASE);
  file = await wrapKey(file, pair.privateKey, 'recovery', recoveryKey);
  return { pair, file: file as LockedKeyFile };
};

describe('Locked key files in a cloud backup restore (FL-721)', () => {
  let directory: string;
  let media: string;
  let objects: Map<string, Buffer>;
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const storage = {
    mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
    checkFileExists: (path: string) =>
      stat(path)
        .then(() => true)
        .catch(() => false),
    unlink,
    rename,
    copyFile,
  };
  const crypto = {
    hashFile: async (path: string) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest(),
  };
  const restorer = () => new CloudBackupRestorer(null, storage as never, crypto as never, logger as never);
  const read = async (_key: string, destination: string, expected: string) => {
    const bytes = objects.get(expected)!;
    await writeFile(destination, bytes);
    return { size: bytes.length, sha256: sha256(bytes) };
  };
  const put = (bytes: Buffer) => {
    objects.set(sha256(bytes), bytes);
    return { sha256: sha256(bytes), size: bytes.length };
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cloud-restore-locked-'));
    media = join(directory, 'media');
    await mkdir(media);
    objects = new Map();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('a restored library brings back locked-keys and locked_encryption, and an encrypted original restored there opens with the passphrase and with the recovery key', async () => {
    const recoveryKey = generateRecoveryKey();
    const { pair, file } = await advancedKeyFile(recoveryKey);
    const keyBytes = Buffer.from(JSON.stringify(file, null, 2));

    const plain = randomBytes(150_000);
    const plainPath = join(directory, 'plain.jpg');
    const sealedPath = join(directory, 'sealed.jpg');
    await writeFile(plainPath, plain);
    await encryptFile(plainPath, sealedPath, [{ publicKey: pair.publicKey }], {
      assetId: ASSET,
      kind: 'original',
      originalFileName: 'IMG_1.jpg',
      mime: 'image/jpeg',
    });
    const sealed = await readFile(sealedPath);
    // the database dump carries the locked_encryption row (the dump is never filtered for it)
    const dump = Buffer.from(
      `COPY public.locked_encryption ("userId", mode, status) FROM stdin;\n${OWNER}\tadvanced\ton\n`,
    );

    const originalPath = join(media, 'library', OWNER, 'IMG_1.jpg');
    const manifest: CloudBackupManifest = {
      format: 'frameleaf-backup-manifest',
      version: 2,
      instanceId: 'instance-1',
      createdAt: '2026-10-31T03:00:00.000Z',
      database: { key: 'db/cloud-backup-immich-db-backup-20261031T030000-v3.2.0-pg16.4.sql.gz', ...put(dump) },
      assets: {
        [ASSET]: { owner: OWNER, files: [{ role: 'original', path: originalPath, ...put(sealed), mtime: null }] },
      },
      profiles: {},
      lockedKeys: {
        [OWNER]: {
          role: LOCKED_KEY_BACKUP_ROLE,
          // the backed-up server kept its media elsewhere: a key file goes back under this server's media
          path: `/old-media/locked-keys/${OWNER}.json`,
          ...put(keyBytes),
          mtime: null,
        },
      },
      albums: {},
      people: {},
    };

    const plan = restorePlan({
      manifest,
      scope: 'library',
      assetIds: null,
      operationId: 'op-1',
      mediaLocation: media,
      currentOriginals: new Map(),
    });
    const keyPath = join(media, 'locked-keys', `${OWNER}.json`);
    expect(plan.files).toContainEqual(
      expect.objectContaining({ role: LOCKED_KEY_BACKUP_ROLE, target: keyPath, inPlace: true }),
    );

    const done = await restorer().restore({
      read,
      manifest,
      scope: 'library',
      files: plan.files,
      destination: plan.destination,
      mediaLocation: media,
      backupsFolder: join(media, 'backups'),
      operationId: 'op-1',
      start: emptyRestoreResult(),
      checkpoint: () => Promise.resolve(true),
    });

    expect(done).toMatchObject({ phase: 'done', files: 3 });
    // the key file is back, private to the server
    expect(await readFile(keyPath)).toEqual(keyBytes);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(media, 'locked-keys'))).mode & 0o777).toBe(0o700);
    // and the database dump with the locked_encryption row, for the maintenance restore
    expect(await readFile(join(media, 'backups', done!.databaseFile!), 'utf8')).toContain('public.locked_encryption');

    // the original went back as ciphertext and opens with each secret through the restored key file
    expect(await readFile(originalPath)).toEqual(sealed);
    const restored = JSON.parse(await readFile(keyPath, 'utf8')) as LockedKeyFile;
    expect(restored.wraps.map(({ kind }) => kind).toSorted()).toEqual(['passphrase', 'recovery']);
    for (const [kind, secret] of [
      ['passphrase', PASSPHRASE],
      ['recovery', recoveryKey],
    ] as const) {
      const privateKey = await unwrapKey(restored, kind, secret);
      const out = join(directory, `opened-${kind}.jpg`);
      await decryptFile(originalPath, out, privateKey);
      expect(await readFile(out)).toEqual(plain);
    }
    // the key file's content never reaches a log line
    const logged = JSON.stringify([logger.log.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain(file.publicKey);
    expect(logged).not.toContain(file.wraps[0].ciphertext);
  });

  it('a whole-library restore keeps a live key file, keeps the backed-up one aside, and counts what the live key does not open', async () => {
    const recoveryKey = generateRecoveryKey();
    const { pair, file } = await advancedKeyFile(recoveryKey);
    const keyBytes = Buffer.from(JSON.stringify(file, null, 2));
    // the person turned encryption off and on since the backup: the live key file is a new key pair
    const live = (await advancedKeyFile(generateRecoveryKey())).file;
    const liveBytes = Buffer.from(JSON.stringify(live));
    const keyPath = join(media, 'locked-keys', `${OWNER}.json`);
    await mkdir(join(media, 'locked-keys'), { mode: 0o700 });
    await writeFile(keyPath, liveBytes, { mode: 0o600 });

    const plainPath = join(directory, 'plain.jpg');
    const sealedPath = join(directory, 'sealed.jpg');
    const plain = randomBytes(5000);
    await writeFile(plainPath, plain);
    await encryptFile(plainPath, sealedPath, [{ publicKey: pair.publicKey }], {
      assetId: ASSET,
      kind: 'original',
      originalFileName: 'IMG_1.jpg',
      mime: 'image/jpeg',
    });
    const originalPath = join(media, 'library', OWNER, 'IMG_1.jpg');
    const manifest: CloudBackupManifest = {
      format: 'frameleaf-backup-manifest',
      version: 2,
      instanceId: 'instance-1',
      createdAt: '2026-10-31T03:00:00.000Z',
      database: {
        key: 'db/cloud-backup-immich-db-backup-20261031T030000-v3.2.0-pg16.4.sql.gz',
        ...put(Buffer.from('dump')),
      },
      assets: {
        [ASSET]: {
          owner: OWNER,
          files: [{ role: 'original', path: originalPath, ...put(await readFile(sealedPath)), mtime: null }],
        },
      },
      profiles: {},
      lockedKeys: { [OWNER]: { role: LOCKED_KEY_BACKUP_ROLE, path: keyPath, ...put(keyBytes), mtime: null } },
      albums: {},
      people: {},
    };
    const plan = restorePlan({
      manifest,
      scope: 'library',
      assetIds: null,
      operationId: 'op-1',
      mediaLocation: media,
      currentOriginals: new Map(),
    });
    const completed = vi.fn();

    const restored = await restorer().restore({
      read,
      manifest,
      scope: 'library',
      files: plan.files,
      destination: plan.destination,
      mediaLocation: media,
      backupsFolder: join(media, 'backups'),
      operationId: 'op-1',
      start: emptyRestoreResult(),
      checkpoint: () => Promise.resolve(true),
      completedFile: completed,
    });

    // the live key file is untouched
    expect(await readFile(keyPath)).toEqual(liveBytes);
    // the backed-up one is kept aside, private, for the recovery CLI, and it still opens the backed-up item
    const kept = join(media, 'frameleaf', 'restore', 'replaced', 'op-1', 'locked-keys', `${OWNER}.json`);
    expect(await readFile(kept)).toEqual(keyBytes);
    expect((await stat(kept)).mode & 0o777).toBe(0o600);
    expect((await stat(join(media, 'frameleaf', 'restore', 'replaced', 'op-1', 'locked-keys'))).mode & 0o777).toBe(
      0o700,
    );
    expect(restored).toMatchObject({ lockedKeysKept: 1 });
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ target: kept, inPlace: false }), 'written');
    const out = join(directory, 'opened.jpg');
    await decryptFile(
      originalPath,
      out,
      await unwrapKey(JSON.parse(await readFile(kept, 'utf8')), 'recovery', recoveryKey),
    );
    expect(await readFile(out)).toEqual(plain);
    // and the restore says the live key does not open the restored item
    await expect(countEncryptedWithOlderKey(plan.files, () => OWNER, media)).resolves.toBe(1);
  });

  it('never brings key files back into a restore folder, nor with a chosen item', () => {
    const manifest: CloudBackupManifest = {
      format: 'frameleaf-backup-manifest',
      version: 2,
      instanceId: 'instance-1',
      createdAt: '2026-10-31T03:00:00.000Z',
      database: null,
      assets: {},
      profiles: {},
      lockedKeys: {
        [OWNER]: {
          role: LOCKED_KEY_BACKUP_ROLE,
          path: '/k.json',
          sha256: sha256(Buffer.from('k')),
          size: 1,
          mtime: null,
        },
        '../../escape': {
          role: LOCKED_KEY_BACKUP_ROLE,
          path: '/x.json',
          sha256: sha256(Buffer.from('x')),
          size: 1,
          mtime: null,
        },
      },
      albums: {},
      people: {},
    };
    const plan = (scope: 'files' | 'asset' | 'library') =>
      restorePlan({
        manifest,
        scope,
        assetIds: scope === 'asset' ? [ASSET] : null,
        operationId: 'op-1',
        mediaLocation: media,
        currentOriginals: new Map(),
      }).files.filter(({ role }) => role === LOCKED_KEY_BACKUP_ROLE);

    expect(plan('files')).toEqual([]);
    expect(plan('asset')).toEqual([]);
    // a key that is not a user id never names a path
    expect(plan('library').map(({ target }) => target)).toEqual([join(media, 'locked-keys', `${OWNER}.json`)]);
  });

  describe(countEncryptedWithOlderKey.name, () => {
    it('counts a restored original that the owner’s current key file does not open', async () => {
      const older = generateKeyPair();
      const { file } = await advancedKeyFile(generateRecoveryKey());
      await mkdir(join(media, 'locked-keys'), { recursive: true, mode: 0o700 });
      await writeFile(join(media, 'locked-keys', `${OWNER}.json`), JSON.stringify(file), { mode: 0o600 });
      const plainPath = join(directory, 'plain.jpg');
      await writeFile(plainPath, randomBytes(1000));
      const target = join(media, 'library', 'IMG_1.jpg');
      await mkdir(join(media, 'library'));
      await encryptFile(plainPath, target, [{ publicKey: older.publicKey }], {
        assetId: ASSET,
        kind: 'original',
        originalFileName: 'IMG_1.jpg',
        mime: 'image/jpeg',
      });
      const plainTarget = join(media, 'library', 'IMG_2.jpg');
      await writeFile(plainTarget, 'not encrypted');
      const files = [
        { fileKey: 'a', assetId: ASSET, role: 'original', sha256: '', size: 0, target, inPlace: true },
        { fileKey: 'b', assetId: 'plain', role: 'original', sha256: '', size: 0, target: plainTarget, inPlace: true },
      ];

      await expect(countEncryptedWithOlderKey(files, () => OWNER, media)).resolves.toBe(1);
    });
  });
});
