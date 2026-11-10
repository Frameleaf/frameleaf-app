import { BackupDeviceWriteSchema } from 'src/dtos/backup-device.dto.js';
import { PushEventType } from 'src/enum.js';
import { BackupDeviceRepository } from 'src/repositories/backup-device.repository.js';
import { BackupDeviceService } from 'src/services/backup-device.service.js';
import { bucketInventory } from 'src/utils/backup-reconciliation.js';
import { factory } from 'test/small.factory.js';

const repository = {
  register: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  start: vi.fn(),
  submit: vi.fn(),
  history: vi.fn(),
  get: vi.fn(),
  lastChecks: vi.fn(),
};
const events = { emit: vi.fn() };
const sut = new BackupDeviceService(repository as unknown as BackupDeviceRepository, events as never);
const auth = factory.auth({ session: { hasElevatedPermission: true } });
const page = { limit: 100, offset: 0 };
const dto = {
  deviceKey: auth.user.id,
  displayName: 'Phone',
  model: 'phone',
  platform: 'ios',
  appVersion: '1',
  lastSuccessfulBackupAt: null,
  pendingCount: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  repository.lastChecks.mockResolvedValue([]);
});
describe(BackupDeviceService.name, () => {
  it('refuses un-elevated and filtered reconciliation before any repository write', async () => {
    await expect(sut.start(factory.auth(), auth.user.id, { buckets: bucketInventory([]) })).rejects.toThrow();
    await expect(
      sut.submit({ ...auth, hideNsfwAssets: true }, auth.user.id, auth.user.id, { bucket: 0, hashes: [] }),
    ).rejects.toThrow();
    expect(repository.start).not.toHaveBeenCalled();
    expect(repository.submit).not.toHaveBeenCalled();
  });
  it('admin metadata listing does not widen reconciliation owner identity', async () => {
    const admin = { ...auth, user: { ...auth.user, isAdmin: true } };
    repository.list.mockResolvedValue([]);
    await sut.list(admin, page, true);
    expect(repository.list).toHaveBeenCalledWith(undefined, page);
    repository.start.mockRejectedValue(new Error('foreign device'));
    await expect(sut.start(admin, 'foreign', { buckets: bucketInventory([]) })).rejects.toThrow('foreign');
    expect(repository.start).toHaveBeenCalledWith(admin, 'foreign', expect.anything());
  });
  it('ordinary list passes only caller owner scope and refuses admin route', async () => {
    repository.list.mockResolvedValue([]);
    await sut.list(auth, page);
    expect(repository.list).toHaveBeenCalledWith(auth.user.id, page);
    await expect(sut.list({ ...auth, user: { ...auth.user, isAdmin: false } }, page, true)).rejects.toThrow('Admin');
  });
  it('validates bounded device metadata and nonnegative pending count', () => {
    expect(BackupDeviceWriteSchema.safeParse(dto).success).toBe(true);
    expect(BackupDeviceWriteSchema.safeParse({ ...dto, pendingCount: -1 }).success).toBe(false);
    expect(BackupDeviceWriteSchema.safeParse({ ...dto, displayName: 'x'.repeat(201) }).success).toBe(false);
  });
  it('refuses future device backup success reports', async () => {
    await expect(
      sut.register(auth, { ...dto, lastSuccessfulBackupAt: new Date(Date.now() + 86_400_000).toISOString() }),
    ).rejects.toThrow('future');
    expect(repository.register).not.toHaveBeenCalled();
  });
  it('removes only the caller device without an asset deletion operation', async () => {
    await sut.remove(auth, 'device');
    expect(repository.remove).toHaveBeenCalledWith(auth.user.id, 'device');
  });

  const run = (overrides: Record<string, unknown> = {}) => ({
    id: auth.user.id,
    deviceId: auth.user.id,
    ownerId: auth.user.id,
    startedAt: new Date(),
    checkedAt: new Date(),
    completedAt: new Date(),
    itemsChecked: 10,
    itemsMissing: 2,
    progress: { differing: [], completed: [] },
    ...overrides,
  });

  it('tells the owner by push when a finished reconciliation found missing items (FL-228)', async () => {
    repository.submit.mockResolvedValue({ run: run(), missingHashes: [] });

    await sut.submit(auth, auth.user.id, auth.user.id, { bucket: 0, hashes: [] });

    expect(events.emit).toHaveBeenCalledWith(
      'PushNotify',
      expect.objectContaining({
        type: PushEventType.BackupNeedsAttention,
        userIds: [auth.user.id],
        systemTemplate: { version: 1, key: 'reconciliation-missing-many', args: { count: 2 } },
        data: { deviceId: auth.user.id, itemsMissing: 2, reason: 'reconciliation-missing' },
      }),
    );
  });

  it('stays quiet while a reconciliation is unfinished or found nothing missing (FL-228)', async () => {
    repository.start.mockResolvedValue(run({ completedAt: null }));
    await sut.start(auth, auth.user.id, { buckets: bucketInventory([]) });
    repository.start.mockResolvedValue(run({ itemsMissing: 0 }));
    await sut.start(auth, auth.user.id, { buckets: bucketInventory([]) });

    expect(events.emit).not.toHaveBeenCalled();
  });

  describe('backup receipt (FL-771)', () => {
    it('bounds pending reasons: at most 20, codes 1..64 chars, any code text accepted', () => {
      const reason = (code = 'wifi') => ({ code, count: 1 });
      expect(BackupDeviceWriteSchema.safeParse({ ...dto, pendingReasons: [reason('made-up-code')] }).success).toBe(
        true,
      );
      expect(
        BackupDeviceWriteSchema.safeParse({ ...dto, pendingReasons: Array.from({ length: 20 }, () => reason()) })
          .success,
      ).toBe(true);
      expect(
        BackupDeviceWriteSchema.safeParse({ ...dto, pendingReasons: Array.from({ length: 21 }, () => reason()) })
          .success,
      ).toBe(false);
      expect(BackupDeviceWriteSchema.safeParse({ ...dto, pendingReasons: [reason('x'.repeat(65))] }).success).toBe(
        false,
      );
      expect(BackupDeviceWriteSchema.safeParse({ ...dto, pendingReasons: [reason('')] }).success).toBe(false);
      expect(BackupDeviceWriteSchema.safeParse({ ...dto, phoneItemCount: -1 }).success).toBe(false);
    });
    it('refuses an un-elevated receipt before reading the device', async () => {
      await expect(sut.receipt(factory.auth(), 'device')).rejects.toThrow('elevated');
      expect(repository.get).not.toHaveBeenCalled();
    });
    it('reports verified count as checked minus missing of the latest completed check', async () => {
      const device = {
        ...dto,
        id: 'device',
        ownerId: auth.user.id,
        reportedAt: new Date(),
        lastSuccessfulBackupAt: null,
        phoneItemCount: 12,
        pendingReasons: [{ code: 'wifi', count: 1 }],
        deletedAt: null,
      };
      repository.get.mockResolvedValue(device);
      expect(await sut.receipt(auth, 'device')).toMatchObject({ lastCheck: null, serverVerifiedCount: null });
      repository.lastChecks.mockResolvedValue([run({ deviceId: 'device' })]);
      expect(await sut.receipt(auth, 'device')).toMatchObject({
        phoneItemCount: 12,
        pendingReasons: [{ code: 'wifi', count: 1 }],
        lastCheck: { itemsChecked: 10, itemsMissing: 2 },
        serverVerifiedCount: 8,
      });
      expect(repository.get).toHaveBeenCalledWith(auth.user.id, 'device');
    });
  });
});
