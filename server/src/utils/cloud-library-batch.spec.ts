import { describe, expect, it, vi } from 'vitest';
import { MlDestinationKind, MlWorkload, SystemMetadataKey } from 'src/enum.js';
import { parseBoundClipResult } from 'src/utils/clip-embedding.js';
import {
  CLOUD_LIBRARY_QUEUE_MAX,
  cloudLibraryDestination,
  cloudLibraryEstimateBody,
  cloudLibraryRequest,
  groupCloudLibraryBatches,
  parseCloudLibrarySnapshot,
  queueCloudLibraryItems,
  toBoundClipResult,
  toBoundFaceResult,
} from 'src/utils/cloud-library-batch.js';
import { localPinnedProfile } from 'src/utils/cloud-model-identity.js';
import { parseBoundFaceResult } from 'src/utils/face-result.js';
import { clipResultSchema, decodeCloudEmbedding, faceResultSchema } from 'src/utils/frameleaf-cloud.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';

/** Exact float32 values, as the cloud sends them. */
const f32 = (values: number[]) => {
  const bytes = Buffer.alloc(values.length * 4);
  for (const [index, value] of values.entries()) {
    bytes.writeFloatLE(value, index * 4);
  }
  return { dim: values.length, encoding: 'f32le-base64' as const, data: bytes.toString('base64') };
};
const vector = (dim: number, seed = 1) => Array.from({ length: dim }, (_, index) => Math.fround((index + seed) / 1000));

const identity = { name: 'ViT-B-16-SigLIP-384__webli' };
const rev = { modelSku: 'ms_C11P0000', modelRev: 'mr_B2H147RBJBQ0' };

describe('Frameleaf Cloud smart search and face results (FL-455)', () => {
  it('decodes an embedding to exactly the float32 values sent', () => {
    const values = vector(768);
    expect(decodeCloudEmbedding(f32(values))).toEqual(values);
  });

  it('turns a smart search item into what this server would have stored', () => {
    const values = vector(768);
    const result = clipResultSchema.parse({
      schema: 'frameleaf.clip/v1',
      ...rev,
      identity,
      items: [{ inputId: 'p1', image: { width: 1440, height: 1080 }, embedding: f32(values), warnings: [] }],
    });
    const bound = toBoundClipResult(result.items[0])!;
    expect(bound).toEqual({ clip: JSON.stringify(values), imageWidth: 1440, imageHeight: 1080 });
    // the same contract the bound local and desktop results pass
    const profile = localPinnedProfile(MlWorkload.Clip, 'ViT-B-16-SigLIP-384__webli')!;
    expect(parseBoundClipResult(bound, profile).embedding).toBe(bound.clip);
  });

  it('keeps a failed smart search item out, and refuses one claiming both', () => {
    const failed = clipResultSchema.parse({
      schema: 'frameleaf.clip/v1',
      ...rev,
      identity,
      items: [{ inputId: 'p1', image: null, embedding: null, warnings: ['input-unreadable'] }],
    });
    expect(toBoundClipResult(failed.items[0])).toBeNull();
    expect(
      clipResultSchema.safeParse({
        schema: 'frameleaf.clip/v1',
        ...rev,
        identity,
        items: [
          { inputId: 'p1', image: { width: 1, height: 1 }, embedding: f32(vector(4)), warnings: ['input-unreadable'] },
        ],
      }).success,
    ).toBe(false);
  });

  it('turns faces into what face detection stores, boxes in the input pixels and in score order', () => {
    const result = faceResultSchema.parse({
      schema: 'frameleaf.faces/v1',
      ...rev,
      identity: { name: 'buffalo_l' },
      minScore: 0.7,
      items: [
        {
          inputId: 'p1',
          image: { width: 1920, height: 1440 },
          faces: [
            { boundingBox: { x1: 812, y1: 301, x2: 1004, y2: 552 }, score: 0.8731, embedding: f32(vector(512)) },
            { boundingBox: { x1: -4, y1: 10, x2: 60, y2: 90 }, score: 0.71, embedding: f32(vector(512, 2)) },
          ],
          warnings: [],
        },
      ],
    });
    const bound = toBoundFaceResult(result.items[0])!;
    const parsed = parseBoundFaceResult(bound);
    expect(parsed.imageWidth).toBe(1920);
    expect(parsed['facial-recognition'].map(({ boundingBox }) => boundingBox)).toEqual([
      { x1: 812, y1: 301, x2: 1004, y2: 552 },
      { x1: -4, y1: 10, x2: 60, y2: 90 },
    ]);
    expect(JSON.parse(parsed['facial-recognition'][0].embedding)).toEqual(vector(512));
  });

  it('stores no faces for a photo without any, and nothing for a failed one', () => {
    const base = { schema: 'frameleaf.faces/v1', ...rev, identity: { name: 'buffalo_l' }, minScore: 0.7 };
    const none = faceResultSchema.parse({
      ...base,
      items: [{ inputId: 'p1', image: { width: 10, height: 10 }, faces: [], warnings: [] }],
    });
    expect(toBoundFaceResult(none.items[0])).toEqual({ imageWidth: 10, imageHeight: 10, 'facial-recognition': [] });
    const failed = faceResultSchema.parse({
      ...base,
      items: [{ inputId: 'p1', image: null, faces: [], warnings: ['input-too-large'] }],
    });
    expect(toBoundFaceResult(failed.items[0])).toBeNull();
  });
});

describe('library batches (FL-455)', () => {
  it('asks for this server’s own model, and for faces its own threshold', () => {
    expect(cloudLibraryRequest('clip', 'ViT-B-16-SigLIP-384__webli', 0.7)).toEqual({
      model: 'ViT-B-16-SigLIP-384__webli',
    });
    expect(cloudLibraryRequest('face', 'buffalo_l', 0.6)).toEqual({ model: 'buffalo_l', minScore: 0.6 });
    const inputs = [{ inputId: 'p1', contentType: 'image/jpeg', bytes: 10, sha256: 'a'.repeat(64) }];
    expect(cloudLibraryEstimateBody('clip', 'ms_C11P0000', inputs, { model: 'm', minScore: 0.7 }).request).toEqual({
      model: 'm',
    });
  });

  it('batches one owner’s photos at a time, at most the batch size each', () => {
    const candidates = [
      ...Array.from({ length: 3 }, (_, index) => ({ assetId: `a${index}`, ownerId: 'owner-a' })),
      { assetId: 'b0', ownerId: 'owner-b' },
      { assetId: 'a0', ownerId: 'owner-a' },
    ];
    expect(groupCloudLibraryBatches(candidates, 2)).toEqual([
      { ownerId: 'owner-a', assetIds: ['a0', 'a1'] },
      { ownerId: 'owner-a', assetIds: ['a2'] },
      { ownerId: 'owner-b', assetIds: ['b0'] },
    ]);
  });

  it('refuses a batch snapshot it cannot read', () => {
    expect(() => parseCloudLibrarySnapshot({ version: 1, workload: 'ocr' })).toThrow(/incomplete/);
    expect(() => parseCloudLibrarySnapshot({ version: 2 })).toThrow(/another version/);
  });

  it('queues a photo once per kind of work and never more than the queue holds', async () => {
    let stored = { items: [{ assetId: 'a', ownerId: 'o', workload: 'clip' as const, queuedAt: 'x' }] };
    const deps = {
      databaseRepository: { withLock: vi.fn((_lock: unknown, run: () => Promise<number>) => run()) },
      systemMetadataRepository: {
        get: vi.fn(() => Promise.resolve(stored)),
        set: vi.fn((key: SystemMetadataKey, value: typeof stored) => {
          expect(key).toBe(SystemMetadataKey.FrameleafCloudLibraryQueue);
          stored = value;
          return Promise.resolve();
        }),
      },
    };
    const full = await queueCloudLibraryItems(deps as never, [
      { assetId: 'a', ownerId: 'o', workload: 'clip', queuedAt: 'y' },
      { assetId: 'a', ownerId: 'o', workload: 'face', queuedAt: 'y' },
    ]);
    expect(full).toBe(0);
    expect(stored.items.map(({ assetId, workload }) => `${workload}:${assetId}`)).toEqual(['clip:a', 'face:a']);
    expect(CLOUD_LIBRARY_QUEUE_MAX).toBeGreaterThan(0);
  });

  it('finds the Frameleaf Cloud destination the work is routed to, and nothing for home routes', async () => {
    const repository = (destination: typeof mlDestinationStub.local) => ({
      getRoute: vi.fn().mockResolvedValue({ destinationId: destination.id }),
      getById: vi.fn().mockResolvedValue(destination),
    });
    await expect(
      cloudLibraryDestination(repository(mlDestinationStub.frameleafCloudConsented) as never, MlWorkload.Clip),
    ).resolves.toMatchObject({ kind: MlDestinationKind.FrameleafCloud });
    await expect(cloudLibraryDestination(repository(mlDestinationStub.local) as never, MlWorkload.Face)).resolves.toBe(
      undefined,
    );
  });
});
