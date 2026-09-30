import { BackupDeviceWriteSchema } from 'src/dtos/backup-device.dto.js';
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
};
const sut = new BackupDeviceService(repository as unknown as BackupDeviceRepository);
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
beforeEach(() => vi.clearAllMocks());
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
});
