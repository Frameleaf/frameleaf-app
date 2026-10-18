import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { JobName, JobStatus, MediaOperationKind, MlWorkload, SystemMetadataKey } from 'src/enum.js';
import { CloudLibraryBatchService } from 'src/services/cloud-library-batch.service.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import {
  type CloudLibraryItem,
  type CloudLibrarySnapshot,
  emptyCloudLibraryResult,
} from 'src/utils/cloud-library-batch.js';
import { localPinnedIdentity } from 'src/utils/cloud-model-identity.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const SIGLIP = 'ViT-B-16-SigLIP-384__webli';
const now = new Date('2026-10-18T12:00:00.000Z');

const f32 = (values: number[]) => {
  const bytes = Buffer.alloc(values.length * 4);
  for (const [index, value] of values.entries()) {
    bytes.writeFloatLE(value, index * 4);
  }
  return { dim: values.length, encoding: 'f32le-base64' as const, data: bytes.toString('base64') };
};

const snapshot = (overrides: Partial<CloudLibrarySnapshot> = {}): CloudLibrarySnapshot => ({
  version: 1,
  workload: 'clip',
  destinationId: mlDestinationStub.frameleafCloudConsented.id,
  assetIds: ['asset-1'],
  modelSku: 'ms_C11P0000',
  modelName: SIGLIP,
  packKey: 'clip-ms_C11P0000',
  ...overrides,
});

/** The cloud destination as a check that found this server's own models left it. */
const matchedCloud = {
  ...mlDestinationStub.frameleafCloudConsented,
  workloads: [...mlDestinationStub.frameleafCloudConsented.workloads, MlWorkload.Clip, MlWorkload.Face],
  lastProbeCloud: {
    ...mlDestinationStub.frameleafCloudConsented.lastProbeCloud!,
    localModels: { [MlWorkload.Clip]: 'ms_C11P0000' },
  },
};

describe(CloudLibraryBatchService.name, () => {
  let sut: CloudLibraryBatchService;
  let mocks: ServiceMocks;
  let queue: { items: Array<{ assetId: string; ownerId: string; workload: 'clip' | 'face'; queuedAt: string }> };

  const routeTo = (destination: typeof mlDestinationStub.local) => {
    mocks.mlDestination.getRoute.mockImplementation((workload) =>
      Promise.resolve({ workload, destinationId: destination.id, modelId: null, updatedAt: new Date() }),
    );
    mocks.mlDestination.getById.mockResolvedValue(destination);
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(CloudLibraryBatchService));
    queue = { items: [] };
    mocks.systemMetadata.get.mockImplementation(
      (key) => Promise.resolve(key === SystemMetadataKey.FrameleafCloudLibraryQueue ? queue : null) as never,
    );
    mocks.mediaOperation.createCloudDescriptionBatches.mockResolvedValue([]);
    mocks.mediaOperation.getOpenCloudLibraryAssetIds.mockResolvedValue(new Set());
    mocks.mediaOperation.fail.mockResolvedValue('failed');
  });

  describe('making batches', () => {
    it("batches an owner's waiting photos with the catalogue model matching this server's own", async () => {
      routeTo(matchedCloud);
      queue.items = Array.from({ length: 50 }, (_, index) => ({
        assetId: `a${index}`,
        ownerId: 'owner',
        workload: 'clip' as const,
        queuedAt: now.toISOString(),
      }));

      await sut.batchQueued(now);

      const [operations] = mocks.mediaOperation.createCloudDescriptionBatches.mock.calls[0];
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        kind: MediaOperationKind.CloudLibraryBatch,
        ownerId: 'owner',
        snapshot: { workload: 'clip', modelSku: 'ms_C11P0000', modelName: SIGLIP },
      });
      expect((operations[0].snapshot as unknown as CloudLibrarySnapshot).assetIds).toHaveLength(50);
    });

    it('waits while too few photos have waited too little, and while no model matches this server', async () => {
      routeTo(matchedCloud);
      queue.items = [{ assetId: 'a', ownerId: 'owner', workload: 'clip', queuedAt: now.toISOString() }];
      await sut.batchQueued(now);
      expect(mocks.mediaOperation.createCloudDescriptionBatches).not.toHaveBeenCalled();

      routeTo({ ...matchedCloud, lastProbeCloud: { ...matchedCloud.lastProbeCloud, localModels: {} } });
      queue.items = [{ assetId: 'a', ownerId: 'owner', workload: 'clip', queuedAt: '2026-10-18T00:00:00.000Z' }];
      await sut.batchQueued(now);
      expect(mocks.mediaOperation.createCloudDescriptionBatches).not.toHaveBeenCalled();
    });

    it('gives the photos back to their own jobs once the work is routed home', async () => {
      routeTo(mlDestinationStub.local);
      queue.items = [{ assetId: 'a', ownerId: 'owner', workload: 'face', queuedAt: now.toISOString() }];

      await sut.batchQueued(now);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.AssetDetectFaces, data: { id: 'a' } }]);
    });
  });

  describe('steps', () => {
    it('stops a batch whose work is routed elsewhere now, sending nothing and giving the photos back', async () => {
      routeTo(mlDestinationStub.local);
      const operation = {
        id: 'batch-1',
        ownerId: 'owner',
        kind: MediaOperationKind.CloudLibraryBatch,
        snapshot: snapshot(),
        result: emptyCloudLibraryResult(['asset-1']),
      } as unknown as MediaOperation;

      await sut.step(operation, 'claim-1', now);

      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        'batch-1',
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_library_turned_off' }),
        { retry: false },
      );
      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.SmartSearch, data: { id: 'asset-1' } }]);
    });
  });

  describe('results (the identity guard)', () => {
    type WriteResult = (
      snapshot: CloudLibrarySnapshot,
      item: CloudLibraryItem,
      document: unknown,
    ) => Promise<CloudLibraryItem>;
    const writeResult = () => (sut as unknown as { writeResult: WriteResult }).writeResult.bind(sut);
    const item: CloudLibraryItem = { assetId: 'asset-1', inputId: 'p1', previewPath: '/preview.jpeg', checksum: '' };
    const document = (identity: unknown) => {
      const values = Array.from({ length: 768 }, (_, index) => Math.fround(index / 1000));
      const result = {
        schema: 'frameleaf.clip/v1',
        modelSku: 'ms_C11P0000',
        modelRev: 'mr_B2H147RBJBQ0',
        identity,
        items: [{ inputId: 'p1', image: { width: 1440, height: 1080 }, embedding: f32(values), warnings: [] }],
      };
      return { workload: 'clip', result, item: result.items[0] };
    };

    it("stores a result made by this server's own model exactly as its own", async () => {
      const publish = vi.spyOn(SmartInfoService.prototype, 'publishClipEmbedding').mockResolvedValue(JobStatus.Success);

      const written = await writeResult()(snapshot(), item, document(localPinnedIdentity(MlWorkload.Clip, SIGLIP)));

      expect(written.outcome).toBe('stored');
      expect(publish).toHaveBeenCalledWith(
        'asset-1',
        expect.objectContaining({ modelKey: expect.stringMatching(/^clip:[\da-f]{64}$/) }),
        { modelName: SIGLIP, previewPath: '/preview.jpeg' },
      );
      publish.mockRestore();
    });

    it('refuses a result made by another model and leaves the photo to this server', async () => {
      const publish = vi.spyOn(SmartInfoService.prototype, 'publishClipEmbedding');
      const other = { ...localPinnedIdentity(MlWorkload.Clip, SIGLIP)!, revision: 'f'.repeat(40) };

      const written = await writeResult()(snapshot(), item, document(other));

      expect(written.outcome).toBe('local');
      expect(written.error).toMatch(/revision/);
      expect(publish).not.toHaveBeenCalled();
      publish.mockRestore();
    });

    it('leaves a photo without a readable result to this server', async () => {
      const written = await writeResult()(snapshot(), item, { invalid: true });
      expect(written.outcome).toBe('local');
    });
  });
});
