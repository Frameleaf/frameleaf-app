import { MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';

it('requires Buddy admission rather than copying a terminal operation through Activity Retry', async () => {
  const createRetry = vi.fn();
  for (const kind of [MediaOperationKind.BuddyBackup, MediaOperationKind.BuddyRestore]) {
    const service = Object.assign(Object.create(MediaOperationService.prototype), {
      findOwned: vi.fn().mockResolvedValue({ kind, status: MediaOperationStatus.Failed }),
      repository: { createRetry },
    });
    await expect(service.retry({ user: { id: 'owner' } }, 'old-terminal-run')).rejects.toThrow('Buddy Backup');
  }
  expect(createRetry).not.toHaveBeenCalled();
});
