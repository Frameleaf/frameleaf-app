import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuddyBackupRecoveryService } from 'src/services/buddy-backup-recovery.service.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { backupKeyFile, keyFingerprint } from 'src/utils/cloud-backup.js';
import { flushBuddyDirectory } from 'src/utils/buddy-backup-vault.js';

const fixture = vi.hoisted(() => ({ media: '', rows: [] as unknown[] }));
vi.mock('src/constants.js', () => ({ serverVersion: '2.6.0' }));
vi.mock('src/cores/storage.core.js', () => ({ StorageCore: { getMediaLocation: () => fixture.media } }));
vi.mock('src/repositories/buddy-backup.repository.js', () => ({ BuddyBackupRepository: class {} }));
vi.mock('src/repositories/config.repository.js', () => ({ ConfigRepository: class {} }));
vi.mock('src/services/database-backup.service.js', () => ({ DatabaseBackupService: class {} }));
vi.mock('kysely', () => ({ sql: () => ({ execute: async () => ({ rows: fixture.rows }) }) }));
vi.mock('src/utils/buddy-backup-vault.js', async (importOriginal) => {
  const vault = await importOriginal<typeof import('src/utils/buddy-backup-vault.js')>();
  return { ...vault, flushBuddyDirectory: vi.fn(vault.flushBuddyDirectory) };
});

describe('Buddy recovery crash barriers', () => {
  let root: string;
  let directory: string;
  let id: string;
  let target: string;
  let plan: any;
  let database: any;
  let service: BuddyBackupRecoveryService;
  const assert = async () => {};

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-service-')));
    fixture.media = join(root, 'media');
    await mkdir(fixture.media);
    id = randomUUID();
    directory = join(root, 'identity', 'buddy', 'recovery', id);
    await mkdir(join(directory, 'objects'), { recursive: true });
    target = join(fixture.media, 'config.json');
    const content = Buffer.from('recovered');
    const sha256 = createHash('sha256').update(content).digest('hex');
    await writeFile(join(directory, 'objects', sha256), content);
    plan = {
      version: 1,
      scope: 'settings',
      mode: 'replace',
      files: [{ path: target, sha256, size: content.length }],
      manifest: {
        version: 1,
        frameleafVersion: '2.6.0',
        storageRoot: fixture.media,
        storageRoots: [fixture.media],
        library: { database: { key: 'dump.sql.gz' } },
        settings: { system: { version: 'restored' }, users: [], fork: [] },
      },
    };
    const query: any = {
      select: () => query,
      selectAll: () => query,
      where: () => query,
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue({ value: { version: 'original' } }),
    };
    database = {
      selectFrom: vi.fn(() => query),
      transaction: () => ({ execute: async (run: (trx: any) => Promise<void>) => run(database) }),
    };
    const repository = {
      root: () => join(root, 'identity', 'buddy'),
      db: database,
      state: async () => ({ settings: { directory: join(root, 'vault'), configurationFiles: [target] } }),
    };
    service = new BuddyBackupRecoveryService(
      repository as never,
      {} as never,
      {} as never,
      new CloudBackupKeyRepository(LoggingRepository.create()),
    );
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('restores stored Cloud Backup keys without restoring or overwriting instance credentials', async () => {
    const key = Buffer.alloc(32, 42);
    const fingerprint = keyFingerprint(key);
    const content = JSON.stringify(
      backupKeyFile({ key, instanceId: 'old-instance', bucket: 'test', mode: 'server', createdAt: new Date() }),
    );
    plan.manifest.cloudBackupKeys = [{ fingerprint, content }];
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    const identity = join(root, 'identity', 'instance-key.pem');
    await writeFile(identity, 'replacement identity');
    const vault = await vi.importActual<typeof import('src/utils/buddy-backup-vault.js')>(
      'src/utils/buddy-backup-vault.js',
    );
    vi.mocked(flushBuddyDirectory).mockImplementation(async (directory) => {
      if (directory === join(root, 'identity')) {
        vi.mocked(flushBuddyDirectory).mockImplementation(vault.flushBuddyDirectory);
        throw new Error('simulated directory flush failure');
      }
      await vault.flushBuddyDirectory(directory);
    });
    await expect(service.settings(id, assert)).rejects.toThrow('directory flush failure');
    expect(vi.mocked(flushBuddyDirectory)).toHaveBeenLastCalledWith(join(root, 'identity'));
    expect(JSON.parse(await readFile(join(directory, 'publication.json'), 'utf8')).state).toBe('database-ready');
    await service.settings(id, assert);
    const stored = join(root, 'identity', `cloud-backup-${fingerprint}.key`);
    expect(await readFile(stored, 'utf8')).toBe(content);
    expect(await readFile(identity, 'utf8')).toBe('replacement identity');
    await rm(stored);
    // A crash/restart or a missing key after completed publication must replay the import.
    await service.settings(id, assert);
    expect(await readFile(stored, 'utf8')).toBe(content);
    await writeFile(stored, JSON.stringify({ key: Buffer.alloc(32, 7).toString('base64') }));
    await expect(service.settings(id, assert)).rejects.toThrow('different backup key');
    expect(await readFile(identity, 'utf8')).toBe('replacement identity');
  });

  it('rechecks complete recovery before allowing maintenance to end, without replacing the database again', async () => {
    plan.scope = 'server';
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    await writeFile(join(directory, 'publication.json'), JSON.stringify({ version: 2, state: 'complete' }));
    await writeFile(target, 'recovered');
    const restore = vi.fn();
    const state = {
      isMaintenanceMode: true,
      action: { restoreBackupFilename: `buddy-restore-${id}-dump.sql.gz` },
    } as never;
    await service.restore(id, restore, state, assert);
    await rm(target);
    await expect(service.restore(id, restore, state, assert)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(restore).not.toHaveBeenCalled();
  });

  it('refuses source identity files and aliases before any publication or settings mutation', async () => {
    const key = join(root, 'identity', 'instance-key.pem');
    await writeFile(key, 'replacement identity');
    plan.files[0].path = key;
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    await expect(service.settings(id, assert)).rejects.toThrow('replacement server identity');
    expect(await readFile(key, 'utf8')).toBe('replacement identity');
    await symlink(join(root, 'identity'), join(fixture.media, 'alias'));
    plan.scope = 'server';
    plan.files[0].path = join(fixture.media, 'alias', 'instance-key.pem');
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    await expect(service.restore(id, vi.fn(), {} as never, assert)).rejects.toThrow('Unsafe recovery path');
    expect(database.selectFrom).not.toHaveBeenCalled();
  });

  it('preserves the original settings preimage across a crash after database commit and complete resumes', async () => {
    let committed = false;
    database.transaction = () => ({
      execute: async (run: (trx: any) => Promise<void>) => {
        await run(database);
        committed = true;
      },
    });
    await expect(
      service.settings(id, async () => {
        if (committed) throw new Error('simulated power loss');
      }),
    ).rejects.toThrow('power loss');
    const original = await readFile(join(directory, 'settings-rollback.json'));
    expect(JSON.parse(original.toString()).system.version).toBe('original');
    database.selectFrom.mockImplementation(() => {
      throw new Error('must reuse durable preimage');
    });
    await service.settings(id, assert);
    await service.settings(id, assert);
    expect(await readFile(join(directory, 'settings-rollback.json'))).toEqual(original);
    await writeFile(target, 'corrupted');
    await expect(service.settings(id, assert)).rejects.toThrow('integrity');
  });
});
