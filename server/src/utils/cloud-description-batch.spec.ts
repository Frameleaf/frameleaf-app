import { describe, expect, it, vi } from 'vitest';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import {
  CLOUD_DESCRIPTION_BATCH_SIZE,
  CLOUD_DESCRIPTION_QUEUE_MAX,
  CloudDescriptionPhase,
  cloudDescriptionIdempotencyKey,
  cloudDescriptionPackKey,
  emptyCloudDescriptionResult,
  groupCloudDescriptionBatches,
  heavyModelGuidance,
  nextServerDay,
  parseCloudDescriptionResult,
  parseCloudDescriptionSnapshot,
  projectCloudDescriptionCost,
  queueCloudDescription,
  serverDay,
} from 'src/utils/cloud-description-batch.js';
import {
  CloudCatalogEntry,
  IDEMPOTENCY_KEY_PATTERN,
  catalogSchema,
  estimateResponseSchema,
  jobCreateRequestSchema,
} from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

type CatalogFixture = { etag: string | null; models: Array<Record<string, unknown>> };
const descriptions = cloudContractFixture<CatalogFixture>('ml/catalog-descriptions.json');
const withModel = (entry: Record<string, unknown>, sku: string, model: string, rank: number) => ({
  ...entry,
  sku,
  rank,
  label: `Descriptions · ${model}`,
  display: { model, gpu: 'H100-class, 80 GB' },
  default: false,
});
/** The gateway's descriptions catalogue, with a 27B, a 35B-A3B and a 72B model added (FL-163). */
const ladder = catalogSchema.parse({
  ...descriptions,
  models: [
    ...descriptions.models,
    withModel(descriptions.models[0], 'ms_M27B0000', 'Qwen3.5-27B', 3),
    withModel(descriptions.models[0], 'ms_M35B0000', 'Qwen3.5-35B-A3B', 4),
    withModel(descriptions.models[0], 'ms_M72B0000', 'Qwen2.5-VL-72B', 6),
  ],
}).models;
const model = (sku: string) => ladder.find((entry) => entry.sku === sku) as CloudCatalogEntry;
const estimate = estimateResponseSchema.parse(
  cloudContractFixture<Record<string, unknown>>('ml/estimate-response.json'),
);

describe('cloud description batches (FL-163)', () => {
  describe('groupCloudDescriptionBatches', () => {
    it("never mixes owners and cuts each owner's photos into batches of at most the batch size", () => {
      const candidates = [
        ...Array.from({ length: CLOUD_DESCRIPTION_BATCH_SIZE + 50 }, (_, index) => ({
          assetId: `a-${index}`,
          ownerId: 'owner-a',
        })),
        { assetId: 'b-1', ownerId: 'owner-b' },
        { assetId: 'b-1', ownerId: 'owner-b' },
      ];

      const batches = groupCloudDescriptionBatches(candidates);

      expect(batches.map(({ ownerId, assetIds }) => [ownerId, assetIds.length])).toEqual([
        ['owner-a', CLOUD_DESCRIPTION_BATCH_SIZE],
        ['owner-a', 50],
        ['owner-b', 1],
      ]);
      expect(batches[0].assetIds[0]).toBe('a-0');
      expect(batches[1].assetIds[0]).toBe(`a-${CLOUD_DESCRIPTION_BATCH_SIZE}`);
    });
  });

  describe('projectCloudDescriptionCost', () => {
    it('scales the sealed estimate by GPU time per photo plus one start fee per batch', () => {
      // the gateway's estimate-response.json quotes two photos: p50 0.021, p90 0.024, start fee 0.02
      const projection = projectCloudDescriptionCost(estimate, 2, [
        { ownerId: 'a', assetIds: Array.from({ length: 200 }, (_, index) => `a${index}`) },
        { ownerId: 'b', assetIds: ['b1', 'b2'] },
      ]);

      expect(projection.perPhotoP50Usd).toBeCloseTo(0.0005, 6);
      expect(projection.perPhotoP90Usd).toBeCloseTo(0.002, 6);
      expect(projection.batches).toEqual([
        { ownerId: 'a', photos: 200, p50Usd: 0.12, p90Usd: 0.42, holdUsd: 0.52 },
        { ownerId: 'b', photos: 2, p50Usd: 0.021, p90Usd: 0.024, holdUsd: 0.025 },
      ]);
      expect(projection).toMatchObject({ photos: 202, p50Usd: 0.141, p90Usd: 0.444, startupUsd: 0.02 });
      expect(projection.basis).toBe('measured');
    });

    it('never goes below the start fee when a sample costs less than it', () => {
      const projection = projectCloudDescriptionCost(
        { basis: 'modelled', cost: { ...estimate.cost, p50: 0.01, p90: 0.01 } },
        4,
        [{ ownerId: 'a', assetIds: ['a1'] }],
      );
      expect(projection.batches[0]).toMatchObject({ p50Usd: 0.02, p90Usd: 0.02 });
    });
  });

  describe('heavyModelGuidance', () => {
    it('suggests the 27B/35B class for small batches of a 72B-class model', () => {
      expect(heavyModelGuidance(model('ms_M72B0000'), [200, 120, 30], ladder)).toEqual({
        minimumBatch: 200,
        smallBatches: 2,
        suggestedModelId: 'ms_M35B0000',
        suggestedModelName: 'Descriptions · Qwen3.5-35B-A3B',
      });
    });

    it('says nothing when every batch is large enough or the model is lighter', () => {
      expect(heavyModelGuidance(model('ms_M72B0000'), [200, 400], ladder)).toBeNull();
      expect(heavyModelGuidance(model('ms_K6WT70CS'), [10], ladder)).toBeNull();
    });

    it('names no suggestion when the catalogue offers no 27B/35B model', () => {
      const offered = ladder.filter((entry) => !/(?:27|35)B/.test(entry.display.model));
      expect(heavyModelGuidance(model('ms_M72B0000'), [10], offered)).toMatchObject({
        suggestedModelId: null,
        suggestedModelName: null,
      });
    });
  });

  describe('keys the cloud accepts', () => {
    it('makes an idempotency key per estimate that the contract accepts', () => {
      const key = cloudDescriptionIdempotencyKey('0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f', 2);
      expect(key).toBe('desc-0192f1b01a2b7c3d8e4f5a6b7c8d9e0f-2');
      expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
    });

    it('makes one pack key per model that names no owner', () => {
      const body = jobCreateRequestSchema.safeParse({
        ...cloudContractFixture<Record<string, unknown>>('ml/job-request.json'),
        packKey: cloudDescriptionPackKey('ms_K6WT70CS'),
      });
      expect(cloudDescriptionPackKey('ms_K6WT70CS')).toBe('descriptions-ms_K6WT70CS');
      expect(body.success).toBe(true);
    });
  });

  describe('the server day', () => {
    it('counts by calendar day in the server time zone and resumes at the next midnight', () => {
      const now = new Date(2026, 8, 26, 23, 59, 30);
      expect(serverDay(now)).toBe('2026-09-26');
      expect(nextServerDay(now)).toEqual(new Date(2026, 8, 27, 0, 0, 0, 0));
      expect(serverDay(nextServerDay(now))).toBe('2026-09-27');
    });
  });

  describe('snapshot and result', () => {
    const snapshot = {
      version: 1,
      origin: 'backfill',
      destinationId: 'destination-1',
      assetIds: ['a', 'b'],
      modelSku: 'ms_K6WT70CS',
      packKey: 'descriptions-ms_K6WT70CS',
      approvedP90Usd: 0.5,
    };

    it('reads a snapshot and refuses one it cannot trust', () => {
      expect(parseCloudDescriptionSnapshot(snapshot)).toEqual(snapshot);
      expect(() => parseCloudDescriptionSnapshot({ ...snapshot, version: 2 })).toThrow();
      expect(() => parseCloudDescriptionSnapshot({ ...snapshot, origin: 'other' })).toThrow();
      expect(() => parseCloudDescriptionSnapshot({ ...snapshot, assetIds: [1] })).toThrow();
    });

    it('reads a missing result as a new batch with one input per photo', () => {
      expect(parseCloudDescriptionResult(null, ['a', 'b'])).toEqual(emptyCloudDescriptionResult(['a', 'b']));
      expect(emptyCloudDescriptionResult(['a', 'b']).items).toEqual([
        { assetId: 'a', inputId: 'p1' },
        { assetId: 'b', inputId: 'p2' },
      ]);
      expect(parseCloudDescriptionResult({ phase: 'unknown' }, ['a']).phase).toBe(CloudDescriptionPhase.Queued);
    });
  });

  describe('queueCloudDescription', () => {
    const deps = (initial: unknown) => {
      let stored = initial;
      return {
        databaseRepository: { withLock: vi.fn((_lock: DatabaseLock, callback: () => Promise<unknown>) => callback()) },
        systemMetadataRepository: {
          get: vi.fn(() => Promise.resolve(stored)),
          set: vi.fn((_key: SystemMetadataKey, value: unknown) => {
            stored = value;
            return Promise.resolve();
          }),
        },
        stored: () => stored,
      };
    };

    it('adds a photo once, under the queue lock', async () => {
      const repositories = deps(null);
      const now = new Date('2026-09-26T10:00:00.000Z');

      await expect(queueCloudDescription(repositories as never, { assetId: 'a', ownerId: 'o' }, now)).resolves.toBe(
        true,
      );
      await expect(queueCloudDescription(repositories as never, { assetId: 'a', ownerId: 'o' }, now)).resolves.toBe(
        true,
      );

      expect(repositories.databaseRepository.withLock).toHaveBeenCalledWith(
        DatabaseLock.FrameleafCloudMlBatchQueue,
        expect.any(Function),
      );
      expect(repositories.stored()).toEqual({
        items: [{ assetId: 'a', ownerId: 'o', queuedAt: '2026-09-26T10:00:00.000Z' }],
        lastBatchAt: {},
      });
    });

    it('refuses a photo once the queue is full', async () => {
      const items = Array.from({ length: CLOUD_DESCRIPTION_QUEUE_MAX }, (_, index) => ({
        assetId: `a${index}`,
        ownerId: 'o',
        queuedAt: '2026-09-26T10:00:00.000Z',
      }));
      const repositories = deps({ items, lastBatchAt: {} });

      await expect(queueCloudDescription(repositories as never, { assetId: 'new', ownerId: 'o' })).resolves.toBe(false);
      expect(repositories.systemMetadataRepository.set).not.toHaveBeenCalled();
    });
  });
});
