import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuddyBackupRecoveryService } from 'src/services/buddy-backup-recovery.service.js';

const fixture = vi.hoisted(() => ({ media: '', rows: [] as unknown[] }));
vi.mock('src/constants.js', () => ({ serverVersion: '2.6.0' }));
vi.mock('src/cores/storage.core.js', () => ({ StorageCore: { getMediaLocation: () => fixture.media } }));
vi.mock('src/repositories/buddy-backup.repository.js', () => ({ BuddyBackupRepository: class {} }));
vi.mock('src/repositories/config.repository.js', () => ({ ConfigRepository: class {} }));
vi.mock('src/services/database-backup.service.js', () => ({ DatabaseBackupService: class {} }));
vi.mock('kysely', () => ({ sql: () => ({ execute: async () => ({ rows: fixture.rows }) }) }));

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
    service = new BuddyBackupRecoveryService(repository as never, {} as never, {} as never);
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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
