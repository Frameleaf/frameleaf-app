import { ICloudMetadataService } from 'src/services/icloud-metadata.service.js';
import { tryPromise } from 'src/utils/promise.js';

describe('iCloud metadata immediate lock followup', () => {
  it('follows up an earlier committed lock even when a later connection fails', async () => {
    const repository = {
      afterExtraction: vi.fn((_asset: string, _owner: string, locked?: string[]) =>
        tryPromise(() => {
          locked?.push('committed');
          throw new Error('later connection failed');
        }),
      ),
    };
    const events = { emit: vi.fn().mockResolvedValue(undefined) };
    const sut = new ICloudMetadataService(repository as never, events as never);
    await expect(sut.onAssetMetadataExtracted({ assetId: 'asset', userId: 'owner' } as never)).rejects.toThrow(
      'later connection failed',
    );
    expect(events.emit).toHaveBeenCalledExactlyOnceWith('AssetLockAll', { assetIds: ['committed'], userId: 'owner' });
  });

  it('does not send a lock followup for a failed transaction with no committed ids', async () => {
    const repository = { afterExtraction: vi.fn().mockRejectedValue(new Error('transaction failed')) };
    const events = { emit: vi.fn() };
    const sut = new ICloudMetadataService(repository as never, events as never);
    await expect(sut.onAssetMetadataExtracted({ assetId: 'asset', userId: 'owner' } as never)).rejects.toThrow(
      'transaction failed',
    );
    expect(events.emit).not.toHaveBeenCalled();
  });
});
