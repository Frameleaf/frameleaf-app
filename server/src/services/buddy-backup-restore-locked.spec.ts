import { MediaOperationStatus } from 'src/enum.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';

vi.mock('src/services/base.service.js', () => ({ BaseService: class {} }));

describe('Buddy single-item restore of Locked items (FL-721)', () => {
  const auth = { user: { id: 'admin-1', isAdmin: true } } as never;
  const serviceWith = (result: Record<string, unknown>) =>
    Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      auth: () => Promise.resolve(auth),
      operations: {
        getOfKind: () =>
          Promise.resolve({
            id: 'restore-1',
            ownerId: 'admin-1',
            status: MediaOperationStatus.Completed,
            progress: 100,
            result,
            error: null,
          }),
      },
    }) as BuddyBackupRestoreService;

  it('single-item restore into a server whose key file doesn’t open the item reports "encrypted with an older key" instead of failing silently', async () => {
    const status = await serviceWith({ phase: 'done', encryptedWithOlderKey: 2 }).status(auth, 'restore-1');

    expect(status).toMatchObject({ state: MediaOperationStatus.Completed, encryptedWithOlderKey: 2 });
    expect(status.error).toContain('encrypted with an older key');
  });

  it('says nothing more when every restored item opens', async () => {
    const status = await serviceWith({ phase: 'done' }).status(auth, 'restore-1');

    expect(status).toMatchObject({ encryptedWithOlderKey: 0, error: null });
  });
});
