import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BuddyRecovery } from 'src/utils/buddy-backup-recovery.js';
import { BuddyRecoveryFiles } from 'src/utils/buddy-backup-recovery.js';

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
