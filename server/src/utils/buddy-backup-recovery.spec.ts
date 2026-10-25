import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BuddyRecovery } from 'src/utils/buddy-backup-recovery.js';
import { BuddyRecoveryFiles, readBuddyRecovery, withBuddyRecoveryWork } from 'src/utils/buddy-backup-recovery.js';
import { closeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { beginCloudNativeWork } from 'src/utils/cloud-native-work.js';

describe('Replacement-local database credential files', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-credential-')));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each(['DB_URL_FILE', 'DB_HOSTNAME_FILE', 'DB_DATABASE_NAME_FILE', 'DB_USERNAME_FILE', 'DB_PASSWORD_FILE'])(
    'refuses publication into %s before changing any target',
    async (key) => {
      const id = randomUUID();
      const directory = join(root, 'recovery', id, 'objects');
      await mkdir(directory, { recursive: true });
      const restored = Buffer.from('historical configuration');
      const sha256 = createHash('sha256').update(restored).digest('hex');
      await writeFile(join(directory, sha256), restored);
      const target = join(root, 'local-credential');
      const earlier = join(root, 'ordinary-config');
      await writeFile(target, 'replacement credential');
      await writeFile(earlier, 'replacement config');
      vi.stubEnv(key, target);
      // This unit exercises publication, not snapshot admission or database restoration.
      const plan = {
        version: 1,
        scope: 'settings',
        mode: 'replace',
        files: [earlier, target].map((path) => ({ path, sha256, size: restored.length })),
      } as BuddyRecovery;
      const publisher = new BuddyRecoveryFiles(root, id);
      await expect(publisher.publish(plan, [], [earlier, target])).rejects.toThrow('local database credential');
      expect(await readFile(target, 'utf8')).toBe('replacement credential');
      expect(await readFile(earlier, 'utf8')).toBe('replacement config');
      const alias = join(root, 'credential-alias');
      await symlink(target, alias);
      vi.stubEnv(key, alias);
      await expect(publisher.publish(plan, [root], [])).rejects.toThrow('local database credential');
      vi.stubEnv(key, undefined);
      await publisher.publish(plan, [], [earlier, target]);
      expect(await readFile(earlier, 'utf8')).toBe('historical configuration');
    },
  );

  it.each([false, true])(
    'preserves an active rollback credential file after interrupted publication (alias: %s)',
    async (alias) => {
      const id = randomUUID();
      const directory = join(root, 'recovery', id, 'objects');
      await mkdir(directory, { recursive: true });
      const restored = Buffer.from('historical configuration');
      const sha256 = createHash('sha256').update(restored).digest('hex');
      await writeFile(join(directory, sha256), restored);
      const target = join(root, 'configuration');
      const backup = `${target}.buddy-rollback-${id}`;
      await writeFile(target, 'replacement credential');
      const plan = {
        version: 1,
        scope: 'settings',
        mode: 'replace',
        files: [{ path: target, sha256, size: restored.length }],
      } as BuddyRecovery;
      const interrupted = new BuddyRecoveryFiles(root, id, async () => {
        if ((await lstat(backup).catch(() => null)) && (await lstat(target).catch(() => null)))
          throw new Error('Interrupted after publication');
      });
      await expect(interrupted.publish(plan, [], [target])).rejects.toThrow('Interrupted after publication');
      const source = alias ? join(root, 'credential-alias') : backup;
      if (alias) await symlink(backup, source);
      vi.stubEnv('DB_PASSWORD_FILE', source);
      const resumed = new BuddyRecoveryFiles(root, id);
      await expect(resumed.rollback([], [target])).rejects.toThrow('local database credential');
      expect(await readFile(target, 'utf8')).toBe('historical configuration');
      expect(await readFile(backup, 'utf8')).toBe('replacement credential');
      vi.stubEnv('DB_PASSWORD_FILE', undefined);
      await resumed.rollback([], [target]);
      expect(await readFile(target, 'utf8')).toBe('replacement credential');
    },
  );

  it.each([false, true])('retains the effective credential-file source at startup (systemd: %s)', async (systemd) => {
    const source = await readFile(resolve('bin/start.sh'), 'utf8');
    const reader = source.match(/read_file_and_export\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(reader).toBeDefined();
    const file = join(root, 'DB_PASSWORD');
    await writeFile(file, 'fixture-value');
    const output = execFileSync(
      'bash',
      [
        '-c',
        `${reader}\nread_file_and_export DB_PASSWORD_FILE DB_PASSWORD\n[[ $DB_PASSWORD = fixture-value ]] || exit 1\nprintf '%s' "$DB_PASSWORD_FILE"`,
      ],
      {
        env: { PATH: process.env.PATH, ...(systemd ? { CREDENTIALS_DIRECTORY: root } : { DB_PASSWORD_FILE: file }) },
        encoding: 'utf8',
      },
    );
    expect(output).toBe(file);
  });
});

describe('Prepared Buddy recovery producer admission', () => {
  it.each(['shared', 'same-operation', 'other-operation'] as const)(
    'refuses a retained %s producer until its actual owner releases it',
    async (kind) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-prepared-owner-')));
      const id = randomUUID();
      const directory = join(root, 'recovery', id);
      const owner = join(
        root,
        'restores',
        kind === 'shared' ? 'producer' : kind === 'same-operation' ? id : randomUUID(),
      );
      await mkdir(directory, { recursive: true });
      await mkdir(owner, { recursive: true });
      const plan = { version: 1, scope: 'settings', mode: 'replace', manifest: { version: 1 }, files: [] };
      await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
      const release = await beginCloudNativeWork(owner);
      const descriptor = await open(join(directory, 'pending-copy'), 'w+');
      try {
        await descriptor.writeFile('pending recovery bytes');
        await expect(readBuddyRecovery(root, id)).rejects.toThrow('cloud_ml_native_work_retained');
        expect(await lstat(join(owner, '.frameleaf-native-owner'))).toBeDefined();
        expect(await descriptor.stat()).toMatchObject({ size: 22 });
        await descriptor.close();
        await release();
        await expect(readBuddyRecovery(root, id)).resolves.toEqual(plan);
      } finally {
        await descriptor.close();
        await release();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['aliased-history', 'oversized-history'] as const)(
    'refuses %s without modifying producer records',
    async (kind) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-prepared-history-')));
      const id = randomUUID();
      const directory = join(root, 'recovery', id);
      const producers = join(root, 'restores');
      const plan = { version: 1, scope: 'settings', mode: 'keep', manifest: { version: 1 }, files: [] };
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
        if (kind === 'aliased-history') {
          const target = join(root, 'elsewhere');
          await mkdir(target);
          await symlink(target, producers);
          await expect(readBuddyRecovery(root, id)).rejects.toThrow('cloud_ml_native_work_retained');
          expect((await lstat(producers)).isSymbolicLink()).toBe(true);
          await rm(producers);
        } else {
          await mkdir(producers);
          await Promise.all(Array.from({ length: 2048 }, (_, index) => mkdir(join(producers, `record-${index}`))));
          await expect(readBuddyRecovery(root, id)).resolves.toEqual(plan);
          await mkdir(join(producers, 'record-2048'));
          await expect(readBuddyRecovery(root, id)).rejects.toThrow('buddy_restore_history_limit');
          expect(await lstat(join(producers, 'record-2048'))).toBeDefined();
          await rm(producers, { recursive: true });
        }
        await expect(readBuddyRecovery(root, id)).resolves.toEqual(plan);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('Exclusive prepared recovery work', () => {
  let root: string;
  let id: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-exclusive-recovery-')));
    id = randomUUID();
    await mkdir(join(root, 'recovery', id), { recursive: true });
    await writeFile(
      join(root, 'recovery', id, 'prepared.json'),
      JSON.stringify({
        version: 1,
        scope: 'settings',
        mode: 'replace',
        manifest: { version: 1 },
        files: [],
      }),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('excludes another process through pending work and admits it only after settlement', async () => {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const child = () =>
      promisify(execFile)(process.execPath, [
        '--input-type=module',
        '-e',
        `
      import { beginCloudNativeWork } from ${JSON.stringify(new URL('cloud-native-work.ts', import.meta.url).href)};
      try {
        const close = await beginCloudNativeWork(process.argv[1]);
        await close();
        console.log('accepted');
      } catch (error) { console.log(error.message); }
    `,
        join(root, 'restores', 'producer'),
      ]);
    const running = withBuddyRecoveryWork(root, id, async () => {
      await withBuddyRecoveryWork(root, id, () => readBuddyRecovery(root, id));
      await expect(withBuddyRecoveryWork(root, randomUUID(), () => Promise.resolve())).rejects.toThrow(
        'cloud_ml_native_work_retained',
      );
      entered.resolve();
      await released.promise;
    });
    try {
      await Promise.race([
        entered.promise,
        running.then(() => {
          throw new Error('Missing pending recovery checkpoint');
        }),
      ]);
      expect((await child()).stdout.trim()).toBe('cloud_ml_native_work_retained');
    } finally {
      released.resolve();
      await running;
    }
    expect((await child()).stdout.trim()).toBe('accepted');
  });

  it('releases known failures and refuses reads from a retired ownership context', async () => {
    await expect(withBuddyRecoveryWork(root, id, () => Promise.reject(new Error('known failure')))).rejects.toThrow(
      'known failure',
    );
    await expect(readBuddyRecovery(root, id)).resolves.toMatchObject({ scope: 'settings' });
    const released = Promise.withResolvers<void>();
    let late!: Promise<unknown>;
    await withBuddyRecoveryWork(root, id, () => {
      late = released.promise.then(() => readBuddyRecovery(root, id));
      return Promise.resolve();
    });
    const next = await beginCloudNativeWork(join(root, 'restores', 'producer'));
    try {
      released.resolve();
      await expect(late).rejects.toThrow('cloud_ml_native_work_retained');
      expect(await next.owns()).toBe(true);
    } finally {
      await next();
    }
  });

  it('retains the reservation across a nested unconfirmed close even if the caller sanitizes the error', async () => {
    const descriptor = await open(join(root, 'pending-copy'), 'w+');
    try {
      await descriptor.writeFile('pending');
      await expect(
        withBuddyRecoveryWork(root, id, async () => {
          try {
            await withBuddyRecoveryWork(root, id, () =>
              closeBuddyFile({
                close: () => Promise.reject(new Error('unconfirmed close')),
              } as never),
            );
          } catch {
            throw new Error('sanitized recovery error');
          }
        }),
      ).rejects.toThrow('sanitized recovery error');
      expect(await descriptor.stat()).toMatchObject({ size: 7 });
      await expect(readBuddyRecovery(root, id)).rejects.toThrow('cloud_ml_native_work_retained');
      await expect(beginCloudNativeWork(join(root, 'restores', 'producer'))).rejects.toThrow(
        'cloud_ml_native_work_retained',
      );
    } finally {
      await descriptor.close();
    }
  });
});
