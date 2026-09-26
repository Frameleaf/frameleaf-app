import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { defaults } from 'src/config.js';
import { AssetImageEnrichmentAction } from 'src/dtos/asset.dto.js';
import {
  AssetLockReason,
  AssetMetadataKey,
  AssetStatus,
  AssetType,
  AssetVisibility,
  DatabaseLock,
  JobName,
  JobStatus,
  MlWorkload,
  SystemMetadataKey,
} from 'src/enum.js';
import { ImageEnrichmentService, descriptionConfidence } from 'src/services/image-enrichment.service.js';
import { VIDEO_MOMENT_EXTRACTOR_VERSION, identityHash, sourceFingerprint } from 'src/utils/enrichment-plan.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

describe(ImageEnrichmentService.name, () => {
  let sut: ImageEnrichmentService;
  let mocks: ServiceMocks;

  const ownerId = newUuid();
  const assetId = newUuid();
  const previewFile = '/data/thumbs/preview.webp';

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ImageEnrichmentService));

    mocks.assetJob.getForImageEnrichment.mockResolvedValue({
      id: assetId,
      ownerId,
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      description: '',
      previewFile,
    });
    mocks.asset.getForUpdateTags.mockResolvedValue({
      tags: [{ value: 'nsfw' }, { value: 'explicit' }, { value: 'beach' }],
    });
    mocks.tag.upsertValue.mockImplementation(({ userId, value }) =>
      Promise.resolve({ id: `${value}-id`, userId, value, parentId: null } as never),
    );
    mocks.tag.upsertAssetIds.mockResolvedValue([{ assetId, tagId: 'nsfw-id' } as never]);
    // Default: no named faces — keeps existing tests unaffected.
    mocks.person.getFaces.mockResolvedValue([]);
    // Default: every asset is its own unlocked lock group (FL-34)
    mocks.asset.lockGroupMembers.mockImplementation((ids) =>
      Promise.resolve(ids.map((id) => ({ id, ownerId, isLocked: false }))),
    );
    mocks.asset.findLockGroupIds.mockImplementation((ids) => Promise.resolve(ids));
  });

  it('should store NSFW results and apply visible NSFW tags when only NSFW detection is enabled', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: false } },
    });
    mocks.machineLearning.detectNsfw.mockResolvedValue({
      isNsfw: true,
      score: 0.95,
      labels: { explicit: 0.95, normal: 0.05 },
    });

    await expect(sut.handleNsfwDetection({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.machineLearning.detectNsfw).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
      previewFile,
      expect.objectContaining({ modelName: 'onnx-community/nsfw_image_detection-ONNX', threshold: 0.85 }),
    );
    expect(mocks.tag.upsertValue).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'nsfw' }));
    expect(mocks.tag.upsertValue).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'explicit' }));
    expect(mocks.asset.upsertExif).toHaveBeenCalledWith({
      exif: expect.objectContaining({ assetId, tags: ['nsfw', 'explicit', 'beach'] }),
      lockedPropertiesBehavior: 'append',
    });
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: assetId } });
    expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(
      assetId,
      expect.arrayContaining([expect.objectContaining({ key: AssetMetadataKey.MlEnrichment })]),
      undefined,
    );
  });

  it('should queue description backfill jobs in batches when description generation is enabled', async () => {
    const firstAssetId = newUuid();
    const secondAssetId = newUuid();
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { enabled: true, nsfwDetection: { enabled: false }, imageDescription: { enabled: true } },
    });
    mocks.assetJob.streamForImageDescriptionJob.mockReturnValue(
      makeStream([{ id: firstAssetId }, { id: secondAssetId }]),
    );

    await expect(sut.handleQueueImageDescription({ force: false })).resolves.toBe(JobStatus.Success);

    expect(mocks.assetJob.streamForImageDescriptionJob).toHaveBeenCalledWith(false);
    expect(mocks.job.queueAll).toHaveBeenCalledWith([
      { name: JobName.ImageDescription, data: { id: firstAssetId } },
      { name: JobName.ImageDescription, data: { id: secondAssetId } },
    ]);
  });

  describe('description confidence (FL-36)', () => {
    const storedDescription = (result: Record<string, unknown>) => ({
      key: AssetMetadataKey.MlEnrichment,
      updatedAt: new Date(),
      value: {
        description: {
          status: 'success',
          modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
          updatedAt: '2026-05-05T00:00:00.000Z',
          result: {
            description: 'A kitchen.',
            people: [],
            environment: '',
            objects: [],
            visible_text: [],
            context: '',
            tags: [],
            ...result,
          },
        },
      },
    });

    it.each([
      [0.82, 0.82],
      [0, 0],
      [1, 1],
      [82, null],
      [-0.1, null],
      ['high', null],
      [NaN, null],
      [undefined, null],
    ])('keeps only a reported 0-1 number (%s)', (confidence, expected) => {
      expect(descriptionConfidence({ confidence })).toBe(expected);
    });

    it('returns the stored confidence, or null when the destination reported none', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.asset.getMetadataByKey.mockResolvedValue(storedDescription({ confidence: 0.7 }) as never);
      await expect(sut.getAssetEnrichment(authStub.user1, assetId)).resolves.toMatchObject({
        description: { status: 'success', confidence: 0.7 },
      });

      mocks.asset.getMetadataByKey.mockResolvedValue(storedDescription({}) as never);
      const missing = await sut.getAssetEnrichment(authStub.user1, assetId);
      expect(missing.description.confidence).toBeNull();

      mocks.asset.getMetadataByKey.mockResolvedValue({ value: {} } as never);
      const none = await sut.getAssetEnrichment(authStub.user1, assetId);
      expect(none.description).toMatchObject({ status: 'missing', confidence: null });
    });

    it.each([
      [0.64, 0.64],
      ['medium', null],
    ])('stores a reported confidence of %s as %s', async (reported, stored) => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { enabled: false }, imageDescription: { enabled: true } },
      });
      mocks.assetJob.getForImageEnrichment.mockResolvedValue({
        id: assetId,
        ownerId,
        type: AssetType.Image,
        status: AssetStatus.Active,
        deletedAt: null,
        visibility: AssetVisibility.Timeline,
        description: '',
        previewFile,
      });
      mocks.machineLearning.describeImage.mockResolvedValue({
        description: 'A kitchen.',
        confidence: reported as number,
        people: [],
        environment: 'kitchen',
        objects: [],
        visible_text: [],
        context: '',
        tags: [],
      });

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      const saved = mocks.asset.upsertMetadata.mock.calls
        .flatMap(([, items]) => items)
        .map((item) => item.value as { description?: { status: string; result?: { confidence?: unknown } } })
        .findLast((value) => value.description?.status === 'success');
      expect(saved?.description?.result?.confidence).toBe(stored);
    });
  });

  it('should require asset update access when reading private enrichment metadata', async () => {
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
    mocks.asset.getMetadataByKey.mockResolvedValue({ value: {} } as never);

    await expect(sut.getAssetEnrichment(authStub.user1, assetId)).resolves.toMatchObject({ assetId });

    expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
      authStub.user1.user.id,
      new Set([assetId]),
      authStub.user1.session?.hasElevatedPermission,
    );
    expect(mocks.access.asset.checkAlbumAccess).not.toHaveBeenCalled();
    expect(mocks.access.asset.checkPartnerAccess).not.toHaveBeenCalled();
  });

  it('should skip NSFW backfill when NSFW detection is disabled', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { enabled: true, nsfwDetection: { enabled: false }, imageDescription: { enabled: true } },
    });

    await expect(sut.handleQueueNsfwDetection({ force: false })).resolves.toBe(JobStatus.Skipped);

    expect(mocks.assetJob.streamForNsfwDetectionJob).not.toHaveBeenCalled();
    expect(mocks.job.queueAll).not.toHaveBeenCalled();
  });

  it('should run NSFW detection before image description when both scans are enabled', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: true } },
    });
    mocks.assetJob.getForImageEnrichment.mockResolvedValue({
      id: assetId,
      ownerId,
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      description: 'User note',
      previewFile,
    });
    const nsfw = {
      isNsfw: true,
      score: 0.91,
      labels: { sexy: 0.91, normal: 0.03 },
    };
    mocks.machineLearning.detectNsfw.mockResolvedValue(nsfw);
    mocks.machineLearning.describeImage.mockResolvedValue({
      description: 'A person standing on a beach.',
      people: [],
      environment: 'beach',
      objects: ['sand'],
      visible_text: [],
      context: 'beach photo',
      tags: ['Beach', 'Person'],
    });

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.machineLearning.detectNsfw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.machineLearning.describeImage.mock.invocationCallOrder[0],
    );
    expect(mocks.machineLearning.describeImage).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
      previewFile,
      expect.objectContaining({ modelName: 'Qwen/Qwen2.5-VL-3B-Instruct' }),
      nsfw,
      expect.stringMatching(/searchable image record[\s\S]*dedicated NSFW classifier flagged/i),
    );
    expect(mocks.asset.upsertExif).toHaveBeenCalledWith({
      exif: expect.objectContaining({
        assetId,
        description: 'User note\n\nAI description: A person standing on a beach.',
      }),
      lockedPropertiesBehavior: 'append',
    });
    expect(mocks.tag.upsertValue).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'beach' }));
    expect(mocks.tag.upsertValue).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'nsfw' }));
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: assetId } });
  });

  it('should auto-mark NSFW from high-confidence description safety when classifier is safe', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: true } },
    });
    mocks.machineLearning.detectNsfw.mockResolvedValue({
      isNsfw: false,
      score: 0.04,
      labels: { normal: 0.96 },
    });
    mocks.machineLearning.describeImage.mockResolvedValue({
      description: 'A naked adult man is lying on a bed under a gray blanket.',
      people: [],
      environment: 'bedroom',
      objects: ['bed', 'blanket'],
      visible_text: [],
      context: 'indoor bedroom photo',
      tags: [],
      safety: {
        is_nsfw_likely: true,
        confidence: 'high',
        indicators: ['nudity', 'naked'],
        reason: 'Adult nudity is visible.',
      },
    });

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.tag.upsertValue).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'nsfw' }));
    expect(mocks.tag.upsertValue).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'nudity' }));
    expect(mocks.tag.upsertValue).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'naked' }));
    // Walk back to the in-lock save that actually persisted the description
    // block; persistAppliedBookkeeping issues a second save with only the
    // tag-application deltas and never carries `description.result`.
    const descriptionCall = mocks.asset.upsertMetadata.mock.calls.find(
      (call) => (call[1][0]?.value as { description?: { result?: unknown } } | undefined)?.description?.result,
    )!;
    const saved = descriptionCall[1][0].value as { description: Record<string, unknown> };
    expect(saved.description.result).toEqual(
      expect.objectContaining({
        safety: expect.objectContaining({ is_nsfw_likely: true, confidence: 'high' }),
      }),
    );
  });

  it('should not auto-mark NSFW from weak description safety cues', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: true } },
    });
    mocks.machineLearning.detectNsfw.mockResolvedValue({
      isNsfw: false,
      score: 0.04,
      labels: { normal: 0.96 },
    });
    mocks.machineLearning.describeImage.mockResolvedValue({
      description: 'A bare-chested adult is lying on a bed.',
      people: [],
      environment: 'bedroom',
      objects: ['bed'],
      visible_text: [],
      context: 'indoor bedroom photo',
      tags: ['bedroom', 'nsfw', 'nudity'],
      safety: {
        is_nsfw_likely: true,
        confidence: 'high',
        indicators: ['bare chest', 'bed'],
        reason: 'A bare chest and bed are visible.',
      },
    });

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.tag.upsertValue).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'bedroom' }));
    expect(mocks.tag.upsertValue).not.toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'nsfw' }));
    expect(mocks.tag.upsertValue).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: ownerId, value: 'nudity' }),
    );
  });

  it('should apply medical tags without marking NSFW', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: true } },
    });
    mocks.machineLearning.detectNsfw.mockResolvedValue({
      isNsfw: false,
      score: 0.02,
      labels: { normal: 0.98 },
    });
    mocks.machineLearning.describeImage.mockResolvedValue({
      description: 'A person is lying in a hospital bed with an IV line nearby.',
      people: [],
      environment: 'hospital room',
      objects: ['hospital bed', 'iv line'],
      visible_text: [],
      context: 'medical setting',
      tags: [],
      medical: {
        is_medical_likely: true,
        confidence: 'high',
        indicators: ['hospital', 'iv line'],
        reason: 'A hospital bed and IV line are visible.',
      },
    });

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.tag.upsertValue).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'medical' }));
    expect(mocks.tag.upsertValue).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'iv-line' }));
    expect(mocks.tag.upsertValue).not.toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, value: 'nsfw' }));
  });

  it('should store description failures without applying visible metadata', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: {
        enabled: true,
        nsfwDetection: { enabled: false },
        imageDescription: { enabled: true, modelName: 'Qwen/Qwen2.5-VL-3B-Instruct' },
      },
    });
    mocks.machineLearning.describeImage.mockRejectedValue(new Error('model unavailable'));

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Failed);

    expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
    expect(mocks.tag.upsertValue).not.toHaveBeenCalled();
    expect(mocks.job.queue).not.toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: assetId } });
    expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(
      assetId,
      expect.arrayContaining([
        expect.objectContaining({
          key: AssetMetadataKey.MlEnrichment,
          value: expect.objectContaining({
            description: expect.objectContaining({
              status: 'failed',
              modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
              error: 'model unavailable',
            }),
          }),
        }),
      ]),
      undefined,
    );
  });

  it('should record a configHash on the description metadata when the job succeeds', async () => {
    // No imageDescription override: the merged prompt config equals defaults,
    // so we can compute the exact expected hash from defaults below.
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: {
        enabled: true,
        nsfwDetection: { enabled: false },
      },
    });
    mocks.machineLearning.describeImage.mockResolvedValue({
      description: 'A sunny park.',
      people: [],
      environment: 'outdoors',
      objects: [],
      visible_text: [],
      context: '',
      tags: [],
    });

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

    const expectedHash = createHash('sha256')
      .update(JSON.stringify(defaults.machineLearning.imageDescription.prompt))
      .digest('hex')
      .slice(0, 8);

    const descriptionCall = mocks.asset.upsertMetadata.mock.calls.find(
      (call) => (call[1][0]?.value as { description?: { result?: unknown } } | undefined)?.description?.result,
    )!;
    const saved = descriptionCall[1][0].value as { description: Record<string, unknown> };
    expect(saved.description.configHash).toBe(expectedHash);
  });

  it('should not record a configHash on failed description metadata', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: {
        enabled: true,
        nsfwDetection: { enabled: false },
        imageDescription: { enabled: true, modelName: 'Qwen/Qwen2.5-VL-3B-Instruct' },
      },
    });
    mocks.machineLearning.describeImage.mockRejectedValue(new Error('model error'));

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Failed);

    const failCall = mocks.asset.upsertMetadata.mock.calls.find(
      (call) =>
        (call[1][0]?.value as { description?: { status?: string } } | undefined)?.description?.status === 'failed',
    )!;
    const saved = failCall[1][0].value as { description: Record<string, unknown> };
    expect(saved.description).not.toHaveProperty('configHash');
  });

  it('should not append an existing generated description block again', async () => {
    const description = 'A bright kitchen with a wooden table.';
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: {
        enabled: true,
        nsfwDetection: { enabled: false },
        imageDescription: { enabled: true, modelName: 'Qwen/Qwen2.5-VL-3B-Instruct' },
      },
    });
    mocks.assetJob.getForImageEnrichment.mockResolvedValue({
      id: assetId,
      ownerId,
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      description: `User note\n\nAI description: ${description}`,
      previewFile,
    });
    mocks.machineLearning.describeImage.mockResolvedValue({
      description,
      people: [],
      environment: 'kitchen',
      objects: ['table'],
      visible_text: [],
      context: 'indoor home photo',
      tags: [],
    });

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
    expect(mocks.job.queue).not.toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: assetId } });
    expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(
      assetId,
      expect.arrayContaining([
        expect.objectContaining({
          key: AssetMetadataKey.MlEnrichment,
          value: expect.objectContaining({
            description: expect.objectContaining({
              appliedDescriptionHash: expect.any(String),
            }),
          }),
        }),
      ]),
      undefined,
    );
  });

  it('should replace the previous generated description block on rerun', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: {
        enabled: true,
        nsfwDetection: { enabled: false },
        imageDescription: { enabled: true, modelName: 'Qwen/Qwen2.5-VL-3B-Instruct' },
      },
    });
    mocks.assetJob.getForImageEnrichment.mockResolvedValue({
      id: assetId,
      ownerId,
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      description: 'User note\n\nAI description: A dim kitchen.',
      previewFile,
    });
    mocks.asset.getMetadataByKey.mockResolvedValue({
      key: AssetMetadataKey.MlEnrichment,
      updatedAt: new Date(),
      value: {
        description: {
          status: 'success',
          modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
          updatedAt: '2026-05-05T00:00:00.000Z',
          appliedDescriptionHash: 'old-hash',
          result: {
            description: 'A dim kitchen.',
            people: [],
            environment: 'kitchen',
            objects: [],
            visible_text: [],
            context: '',
            tags: [],
          },
        },
      },
    });
    mocks.machineLearning.describeImage.mockResolvedValue({
      description: 'A bright kitchen with a wooden table.',
      people: [],
      environment: 'kitchen',
      objects: ['table'],
      visible_text: [],
      context: 'indoor home photo',
      tags: [],
    });

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.asset.upsertExif).toHaveBeenCalledWith({
      exif: expect.objectContaining({
        assetId,
        description: 'User note\n\nAI description: A bright kitchen with a wooden table.',
      }),
      lockedPropertiesBehavior: 'append',
    });
    expect(mocks.asset.upsertExif).not.toHaveBeenCalledWith({
      exif: expect.objectContaining({ description: expect.stringContaining('A dim kitchen.') }),
      lockedPropertiesBehavior: 'append',
    });
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: assetId } });
  });

  it('replaces the whole description on rerun when Library care keeps no manual text (FL-69)', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: {
        enabled: true,
        nsfwDetection: { enabled: false },
        imageDescription: { enabled: true, modelName: 'Qwen/Qwen2.5-VL-3B-Instruct' },
      },
      libraryCare: { manualMetadata: false },
    });
    mocks.assetJob.getForImageEnrichment.mockResolvedValue({
      id: assetId,
      ownerId,
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      description: 'User note\n\nAI description: A dim kitchen.',
      previewFile,
    });
    mocks.asset.getMetadataByKey.mockResolvedValue({
      key: AssetMetadataKey.MlEnrichment,
      updatedAt: new Date(),
      value: {
        description: {
          status: 'success',
          modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
          updatedAt: '2026-05-05T00:00:00.000Z',
          appliedDescriptionHash: 'old-hash',
          result: {
            description: 'A dim kitchen.',
            people: [],
            environment: 'kitchen',
            objects: [],
            visible_text: [],
            context: '',
            tags: [],
          },
        },
      },
    });
    mocks.machineLearning.describeImage.mockResolvedValue({
      description: 'A bright kitchen with a wooden table.',
      people: [],
      environment: 'kitchen',
      objects: ['table'],
      visible_text: [],
      context: 'indoor home photo',
      tags: [],
    });

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.asset.upsertExif).toHaveBeenCalledWith({
      exif: expect.objectContaining({ assetId, description: 'AI description: A bright kitchen with a wooden table.' }),
      lockedPropertiesBehavior: 'append',
    });
  });

  describe('Library care → Reprocess only affected outputs (FL-69)', () => {
    it('marks a full rerun so each photo is redone only when affected', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { enabled: true, nsfwDetection: { enabled: false }, imageDescription: { enabled: true } },
        libraryCare: { incrementalEnrichment: true },
      });
      mocks.assetJob.streamForImageDescriptionJob.mockReturnValue(makeStream([{ id: assetId }]));

      await sut.handleQueueImageDescription({ force: true });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.ImageDescription, data: { id: assetId, onlyAffected: true } },
      ]);
    });

    it('reruns everything when it is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { enabled: true, nsfwDetection: { enabled: false }, imageDescription: { enabled: true } },
        libraryCare: { incrementalEnrichment: false },
      });
      mocks.assetJob.streamForImageDescriptionJob.mockReturnValue(makeStream([{ id: assetId }]));

      await sut.handleQueueImageDescription({ force: true });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.ImageDescription, data: { id: assetId } }]);
    });

    it('keeps a current description and redoes one that is missing', async () => {
      const affected = vi.spyOn(sut, 'isDescriptionAffected').mockResolvedValueOnce(false);
      await expect(sut.handleImageDescription({ id: assetId, onlyAffected: true })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.machineLearning.describeImage).not.toHaveBeenCalled();
      affected.mockRestore();

      mocks.asset.getMetadataByKey.mockResolvedValue(undefined);
      await expect(sut.isDescriptionAffected(assetId)).resolves.toBe(true);
    });
  });

  it.each([
    ['trashed', AssetStatus.Trashed, new Date()] as const,
    ['deleted', AssetStatus.Deleted, new Date()] as const,
  ])('should skip %s assets for single image enrichment jobs', async (_label, status, deletedAt) => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: true } },
    });
    mocks.assetJob.getForImageEnrichment.mockResolvedValue({
      id: assetId,
      ownerId,
      type: AssetType.Image,
      status,
      deletedAt,
      visibility: AssetVisibility.Timeline,
      description: '',
      previewFile,
    });

    await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Skipped);

    expect(mocks.machineLearning.detectNsfw).not.toHaveBeenCalled();
    expect(mocks.machineLearning.describeImage).not.toHaveBeenCalled();
    expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
  });

  it('should skip locked assets for single image enrichment jobs', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: true } },
    });
    mocks.assetJob.getForImageEnrichment.mockResolvedValue({
      id: assetId,
      ownerId,
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Locked,
      description: '',
      previewFile,
    });

    await expect(sut.handleNsfwDetection({ id: assetId })).resolves.toBe(JobStatus.Skipped);

    expect(mocks.machineLearning.detectNsfw).not.toHaveBeenCalled();
    expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
  });

  it('should mark an NSFW result as safe and remove generated NSFW tags', async () => {
    mocks.asset.getById.mockResolvedValue({
      id: assetId,
      ownerId,
      exifInfo: { description: '' },
      tags: [],
    } as never);
    mocks.asset.getMetadataByKey.mockResolvedValue({
      key: AssetMetadataKey.MlEnrichment,
      updatedAt: new Date(),
      value: {
        nsfwDetection: {
          status: 'success',
          modelName: 'onnx-community/nsfw_image_detection-ONNX',
          updatedAt: '2026-05-05T00:00:00.000Z',
          appliedTagHash: 'hash',
          appliedTagValues: ['nsfw', 'explicit'],
          result: {
            isNsfw: true,
            score: 0.95,
            labels: { explicit: 0.95 },
          },
        },
      },
    });
    mocks.tag.getByValue
      .mockResolvedValueOnce({
        id: 'nsfw-id',
        value: 'nsfw',
        color: null,
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 'explicit-id',
        value: 'explicit',
        color: null,
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

    const result = await sut.updateAssetEnrichment(authStub.admin, assetId, {
      action: AssetImageEnrichmentAction.MarkSafe,
    });

    expect(result.nsfwDetection.effectiveIsNsfw).toBe(false);
    expect(result.nsfwDetection.review).toEqual(
      expect.objectContaining({ action: 'marked-safe', isNsfw: false, reviewedBy: authStub.admin.user.id }),
    );
    expect(mocks.tag.removeAssetIds).toHaveBeenCalledWith('nsfw-id', [assetId]);
    expect(mocks.tag.removeAssetIds).toHaveBeenCalledWith('explicit-id', [assetId]);
    expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(
      assetId,
      expect.arrayContaining([
        expect.objectContaining({
          value: expect.objectContaining({
            nsfwDetection: expect.objectContaining({
              result: expect.objectContaining({ isNsfw: true }),
              review: expect.objectContaining({ action: 'marked-safe', isNsfw: false }),
            }),
          }),
        }),
      ]),
      undefined,
    );
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: assetId } });
  });

  describe('the sensitive mark is the lock (FL-34)', () => {
    const detectedMetadata = {
      key: AssetMetadataKey.MlEnrichment,
      updatedAt: new Date(),
      value: {
        nsfwDetection: {
          status: 'success',
          modelName: 'onnx-community/nsfw_image_detection-ONNX',
          updatedAt: '2026-05-05T00:00:00.000Z',
          result: { isNsfw: true, score: 0.95, labels: { explicit: 0.95 } },
        },
      },
    };

    beforeEach(() => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.asset.getById.mockResolvedValue({ id: assetId, ownerId, exifInfo: { description: '' }, tags: [] } as never);
    });

    // the metadata transaction the review is written in; the lock must join it (FL-34, PR127)
    const trx = { isTransaction: true } as never;
    const inMetadataTransaction = () => {
      mocks.database.withAssetMetadataLock.mockImplementation((_assetId, fn) => fn(trx));
      mocks.database.withAssetMetadataLocks.mockImplementation((_assetIds, fn) => fn(trx));
    };

    it('locks an asset its owner marks sensitive, as their own lock', async () => {
      inMetadataTransaction();
      mocks.asset.lock.mockResolvedValue([assetId]);

      await sut.updateAssetEnrichment(authStub.admin, assetId, { action: AssetImageEnrichmentAction.MarkNsfw });

      // in the same transaction as the review, so neither commits without the other
      expect(mocks.asset.lock).toHaveBeenCalledWith([assetId], AssetLockReason.Marked, authStub.admin.user.id, trx);
      // the group's rows are taken first, in a fixed order, so parallel marks in one stack cannot deadlock
      expect(mocks.asset.lockGroupRows).toHaveBeenCalledWith([assetId], trx);
      expect(mocks.asset.lockGroupRows.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.asset.upsertMetadata.mock.invocationCallOrder[0],
      );
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(assetId, expect.any(Array), trx);
      // what a locked photo may no longer be is released and followed up
      expect(mocks.person.getMissingThumbnailsForAssets).toHaveBeenCalledWith([assetId]);
    });

    it('releases what a locked photo may no longer be even when a later tag step fails', async () => {
      inMetadataTransaction();
      mocks.asset.lock.mockResolvedValue([assetId]);
      mocks.tag.upsertValue.mockRejectedValue(new Error('tag write failed'));

      await expect(
        sut.updateAssetEnrichment(authStub.admin, assetId, { action: AssetImageEnrichmentAction.MarkNsfw }),
      ).rejects.toThrow('tag write failed');

      // the lock committed, so its follow-up ran before the tag step
      expect(mocks.person.getMissingThumbnailsForAssets).toHaveBeenCalledWith([assetId]);
    });

    it('releases what a detected lock may no longer show even when a later tag step fails', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          nsfwDetection: { enabled: true, hideFromLibrary: true },
          imageDescription: { enabled: false },
        },
      });
      mocks.machineLearning.detectNsfw.mockResolvedValue({ isNsfw: true, score: 0.95, labels: { explicit: 0.95 } });
      mocks.asset.lock.mockResolvedValue([assetId]);
      mocks.tag.upsertValue.mockRejectedValue(new Error('tag write failed'));

      await expect(sut.handleNsfwDetection({ id: assetId })).rejects.toThrow('tag write failed');

      expect(mocks.person.getMissingThumbnailsForAssets).toHaveBeenCalledWith([assetId]);
    });

    it('runs no lock follow-up when the lock fails inside the review transaction', async () => {
      inMetadataTransaction();
      mocks.asset.lock.mockRejectedValue(new Error('lock unavailable'));

      await expect(
        sut.updateAssetEnrichment(authStub.admin, assetId, { action: AssetImageEnrichmentAction.MarkNsfw }),
      ).rejects.toThrow('lock unavailable');

      // the transaction (review and projection with it) is rolled back; nothing ran after it
      expect(mocks.tag.upsertValue).not.toHaveBeenCalled();
      expect(mocks.person.getMissingThumbnailsForAssets).not.toHaveBeenCalled();
    });

    it('needs the unlocked session to mark a locked asset safe', async () => {
      mocks.asset.lockGroupMembers.mockResolvedValue([{ id: assetId, ownerId, isLocked: true }]);

      await expect(
        sut.updateAssetEnrichment(authStub.admin, assetId, { action: AssetImageEnrichmentAction.MarkSafe }),
      ).rejects.toThrow('Elevated permission is required');

      expect(mocks.asset.unlock).not.toHaveBeenCalled();
      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
    });

    it('unlocks a locked asset marked safe in the unlocked session', async () => {
      mocks.asset.lockGroupMembers.mockResolvedValue([{ id: assetId, ownerId, isLocked: true }]);
      mocks.asset.unlock.mockResolvedValue([{ assetId, reason: AssetLockReason.Marked }]);
      // a copy: the service edits the metadata it reads
      mocks.asset.getMetadataByKey.mockResolvedValue(structuredClone(detectedMetadata));
      inMetadataTransaction();

      await sut.updateAssetEnrichment(authStub.adminWithElevatedPermission, assetId, {
        action: AssetImageEnrichmentAction.MarkSafe,
      });

      expect(mocks.asset.unlock).toHaveBeenCalledWith([assetId], trx, [
        AssetLockReason.Marked,
        AssetLockReason.Detected,
      ]);
      expect(mocks.asset.lock).not.toHaveBeenCalled();
      // the elevation check reads the group under the transaction's row locks
      expect(mocks.asset.lockGroupMembers).toHaveBeenCalledWith([assetId], trx);
      expect(mocks.asset.lockGroupMembers.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.asset.unlock.mock.invocationCallOrder[0],
      );
      // the owner's other devices learn of the unlocked group
      expect(mocks.asset.getByIdsWithAllRelationsButStacks).toHaveBeenCalledWith(
        [assetId],
        authStub.adminWithElevatedPermission.user.id,
      );
    });

    it('needs the unlocked session when only another member of the group is locked', async () => {
      const siblingId = newUuid();
      mocks.asset.findLockGroupIds.mockResolvedValue([assetId, siblingId]);
      mocks.asset.lockGroupMembers.mockResolvedValue([
        { id: assetId, ownerId, isLocked: false },
        { id: siblingId, ownerId, isLocked: true },
      ]);

      await expect(
        sut.updateAssetEnrichment(authStub.admin, assetId, { action: AssetImageEnrichmentAction.MarkSafe }),
      ).rejects.toThrow('Elevated permission is required');

      expect(mocks.asset.unlock).not.toHaveBeenCalled();
      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
    });

    it('writes the safe review on every member of the group it unlocks, in the same transaction', async () => {
      const siblingId = newUuid();
      mocks.asset.findLockGroupIds.mockResolvedValue([assetId, siblingId]);
      mocks.asset.lockGroupMembers.mockResolvedValue([
        { id: assetId, ownerId, isLocked: true },
        { id: siblingId, ownerId, isLocked: true },
      ]);
      mocks.asset.unlock.mockResolvedValue([
        { assetId, reason: AssetLockReason.Marked },
        { assetId: siblingId, reason: AssetLockReason.Marked },
      ]);
      mocks.asset.getMetadataByKey.mockImplementation(() => Promise.resolve(structuredClone(detectedMetadata)));
      inMetadataTransaction();

      await sut.updateAssetEnrichment(authStub.adminWithElevatedPermission, assetId, {
        action: AssetImageEnrichmentAction.MarkSafe,
      });

      // every member's metadata lock, before the group's rows
      expect(mocks.database.withAssetMetadataLocks).toHaveBeenCalledWith([assetId, siblingId], expect.any(Function));
      for (const id of [assetId, siblingId]) {
        expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(
          id,
          expect.arrayContaining([
            expect.objectContaining({
              value: expect.objectContaining({
                nsfwDetection: expect.objectContaining({
                  review: expect.objectContaining({ action: 'marked-safe', isNsfw: false }),
                }),
              }),
            }),
          ]),
          trx,
        );
      }
    });

    it('keeps an earlier safe review of a member but still saves it again', async () => {
      const siblingId = newUuid();
      const review = {
        action: 'marked-safe',
        isNsfw: false,
        reviewedAt: '2026-01-01T00:00:00.000Z',
        reviewedBy: ownerId,
      };
      mocks.asset.findLockGroupIds.mockResolvedValue([assetId, siblingId]);
      mocks.asset.lockGroupMembers.mockResolvedValue([
        { id: assetId, ownerId, isLocked: true },
        { id: siblingId, ownerId, isLocked: true },
      ]);
      mocks.asset.unlock.mockResolvedValue([
        { assetId, reason: AssetLockReason.Marked },
        { assetId: siblingId, reason: AssetLockReason.Marked },
      ]);
      mocks.asset.getMetadataByKey.mockImplementation((id) =>
        Promise.resolve(
          id === siblingId
            ? {
                ...structuredClone(detectedMetadata),
                value: { nsfwDetection: { ...detectedMetadata.value.nsfwDetection, review } },
              }
            : structuredClone(detectedMetadata),
        ),
      );
      inMetadataTransaction();

      await sut.updateAssetEnrichment(authStub.adminWithElevatedPermission, assetId, {
        action: AssetImageEnrichmentAction.MarkSafe,
      });

      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(
        siblingId,
        [
          expect.objectContaining({
            value: expect.objectContaining({ nsfwDetection: expect.objectContaining({ review }) }),
          }),
        ],
        trx,
      );
    });

    it('leaves a sibling that was not locked with its detector verdict', async () => {
      const siblingId = newUuid();
      mocks.asset.findLockGroupIds.mockResolvedValue([assetId, siblingId]);
      mocks.asset.lockGroupMembers.mockResolvedValue([
        { id: assetId, ownerId, isLocked: false },
        { id: siblingId, ownerId, isLocked: false },
      ]);
      mocks.asset.unlock.mockResolvedValue([]);
      mocks.asset.getMetadataByKey.mockImplementation(() => Promise.resolve(structuredClone(detectedMetadata)));
      inMetadataTransaction();

      await sut.updateAssetEnrichment(authStub.admin, assetId, { action: AssetImageEnrichmentAction.MarkSafe });

      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(assetId, expect.any(Array), trx);
      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalledWith(siblingId, expect.anything(), expect.anything());
      expect(mocks.asset.getMetadataByKey).not.toHaveBeenCalledWith(siblingId, expect.anything(), expect.anything());
    });

    it('writes nothing when the group grew after its metadata locks were taken', async () => {
      const joinedId = newUuid();
      mocks.asset.lockGroupMembers.mockResolvedValue([
        { id: assetId, ownerId, isLocked: true },
        { id: joinedId, ownerId, isLocked: true },
      ]);
      inMetadataTransaction();

      await expect(
        sut.updateAssetEnrichment(authStub.adminWithElevatedPermission, assetId, {
          action: AssetImageEnrichmentAction.MarkSafe,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(mocks.asset.unlock).not.toHaveBeenCalled();
      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
    });

    it('aborts when the unlock releases a member the elevation check never saw', async () => {
      const joinedId = newUuid();
      mocks.asset.lockGroupMembers.mockResolvedValue([{ id: assetId, ownerId, isLocked: false }]);
      mocks.asset.unlock.mockResolvedValue([{ assetId: joinedId, reason: AssetLockReason.Marked }]);
      inMetadataTransaction();

      await expect(
        sut.updateAssetEnrichment(authStub.admin, assetId, { action: AssetImageEnrichmentAction.MarkSafe }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
    });

    it('locks a new detection as detected when hiding sensitive detections is on', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          nsfwDetection: { enabled: true, hideFromLibrary: true },
          imageDescription: { enabled: false },
        },
      });
      mocks.machineLearning.detectNsfw.mockResolvedValue({ isNsfw: true, score: 0.95, labels: { explicit: 0.95 } });
      mocks.asset.lock.mockResolvedValue([assetId]);
      inMetadataTransaction();

      await expect(sut.handleNsfwDetection({ id: assetId })).resolves.toBe(JobStatus.Success);

      // committed with the detection that caused it, then followed up once committed
      expect(mocks.asset.lock).toHaveBeenCalledWith([assetId], AssetLockReason.Detected, null, trx);
      expect(mocks.person.getMissingThumbnailsForAssets).toHaveBeenCalledWith([assetId]);
    });

    it('never locks a detection while hiding sensitive detections is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: false } },
      });
      mocks.machineLearning.detectNsfw.mockResolvedValue({ isNsfw: true, score: 0.95, labels: { explicit: 0.95 } });

      await sut.handleNsfwDetection({ id: assetId });

      expect(mocks.asset.lock).not.toHaveBeenCalled();
    });

    it('lets the owner review win over a later detection', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          nsfwDetection: { enabled: true, hideFromLibrary: true },
          imageDescription: { enabled: false },
        },
      });
      mocks.asset.getMetadataByKey.mockResolvedValue({
        ...detectedMetadata,
        value: {
          nsfwDetection: {
            ...detectedMetadata.value.nsfwDetection,
            review: { action: 'marked-safe', isNsfw: false, reviewedAt: '2026-09-22T00:00:00Z', reviewedBy: ownerId },
          },
        },
      });
      mocks.machineLearning.detectNsfw.mockResolvedValue({ isNsfw: true, score: 0.99, labels: { explicit: 0.99 } });

      await sut.handleNsfwDetection({ id: assetId });

      expect(mocks.asset.lock).not.toHaveBeenCalled();
      // nor does the raw detection put sensitive tags back on what its owner reviewed as safe
      expect(mocks.tag.upsertValue).not.toHaveBeenCalledWith(expect.objectContaining({ value: 'nsfw' }));
    });

    it('keeps a safe review through a failed detection and a positive retry', async () => {
      const review = { action: 'marked-safe', isNsfw: false, reviewedAt: '2026-09-22T00:00:00Z', reviewedBy: ownerId };
      let stored: Record<string, unknown> = {
        nsfwDetection: { ...detectedMetadata.value.nsfwDetection, review },
      };
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          nsfwDetection: { enabled: true, hideFromLibrary: true },
          imageDescription: { enabled: false },
        },
      });
      mocks.asset.getMetadataByKey.mockImplementation(() =>
        Promise.resolve({ value: structuredClone(stored) } as never),
      );
      mocks.asset.upsertMetadata.mockImplementation((_id, entries) => {
        stored = structuredClone(entries[0].value as Record<string, unknown>);
        return Promise.resolve([{ ...entries[0], updatedAt: new Date() }]);
      });
      mocks.machineLearning.detectNsfw
        .mockRejectedValueOnce(new Error('network offline'))
        .mockResolvedValueOnce({ isNsfw: true, score: 0.99, labels: { explicit: 0.99 } });

      await expect(sut.detectLockedContent(assetId)).resolves.toMatchObject({ status: JobStatus.Failed });
      expect(stored.nsfwDetection).toMatchObject({ status: 'failed', review });

      await expect(sut.detectLockedContent(assetId)).resolves.toMatchObject({ status: JobStatus.Success });
      expect(stored.nsfwDetection).toMatchObject({ status: 'success', review });
      expect(mocks.asset.lock).not.toHaveBeenCalled();
    });

    it('keeps a review made during description detection through failure and retry', async () => {
      const review = { action: 'marked-safe', isNsfw: false, reviewedAt: '2026-09-22T00:00:00Z', reviewedBy: ownerId };
      let stored: Record<string, unknown> = {};
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          nsfwDetection: { enabled: true, hideFromLibrary: true },
          imageDescription: { enabled: true },
        },
      });
      mocks.asset.getMetadataByKey.mockImplementation(() =>
        Promise.resolve({ value: structuredClone(stored) } as never),
      );
      mocks.asset.upsertMetadata.mockImplementation((_id, entries) => {
        stored = structuredClone(entries[0].value as Record<string, unknown>);
        return Promise.resolve([{ ...entries[0], updatedAt: new Date() }]);
      });
      mocks.machineLearning.detectNsfw
        .mockImplementationOnce(() => {
          // The owner saves a review after describeAsset's initial snapshot, while inference is in flight.
          stored = {
            nsfwDetection: {
              status: 'success',
              modelName: 'manual-review',
              updatedAt: review.reviewedAt,
              result: { isNsfw: false, score: 0, labels: {} },
              review,
            },
          };
          return Promise.reject(new Error('network offline'));
        })
        .mockResolvedValueOnce({ isNsfw: true, score: 0.99, labels: { explicit: 0.99 } });
      mocks.machineLearning.describeImage.mockResolvedValue({
        description: 'A beach.',
        people: [],
        environment: 'beach',
        objects: [],
        visible_text: [],
        context: '',
        tags: [],
      });

      await expect(sut.describeAsset(assetId)).resolves.toMatchObject({ status: JobStatus.Success });
      expect(stored.nsfwDetection).toMatchObject({ status: 'failed', review });

      await expect(sut.describeAsset(assetId)).resolves.toMatchObject({ status: JobStatus.Success });
      expect(stored.nsfwDetection).toMatchObject({ status: 'success', review });
      expect(mocks.asset.lock).not.toHaveBeenCalled();
    });

    it('never unlocks when a detection comes back safe', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          nsfwDetection: { enabled: true, hideFromLibrary: true },
          imageDescription: { enabled: false },
        },
      });
      mocks.machineLearning.detectNsfw.mockResolvedValue({ isNsfw: false, score: 0.01, labels: { normal: 0.99 } });

      await sut.handleNsfwDetection({ id: assetId });

      expect(mocks.asset.unlock).not.toHaveBeenCalled();
      expect(mocks.asset.lock).not.toHaveBeenCalled();
    });

    it('unlocks only in the unlocked session', async () => {
      await expect(sut.unlockAssets(authStub.admin, { ids: [assetId] })).rejects.toThrow(
        'Elevated permission is required',
      );

      expect(mocks.asset.unlock).not.toHaveBeenCalled();
    });

    it('unlocks a large selection in bounded transactions', async () => {
      const ids = Array.from(
        { length: 450 },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      );
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(ids));
      mocks.asset.unlock.mockResolvedValue([]);

      await sut.unlockAssets(authStub.adminWithElevatedPermission, { ids });

      expect(mocks.asset.unlock).toHaveBeenCalledTimes(3);
      expect(mocks.asset.unlock.mock.calls.map(([batch]) => batch.length)).toEqual([200, 200, 50]);
    });

    it('records the owner review as safe when unlocking what the check counts as sensitive', async () => {
      mocks.asset.unlock.mockResolvedValue([{ assetId, reason: AssetLockReason.Detected }]);
      // a copy: the service edits the metadata it reads
      mocks.asset.getMetadataByKey.mockResolvedValue(structuredClone(detectedMetadata));

      await sut.unlockAssets(authStub.adminWithElevatedPermission, { ids: [assetId] });

      expect(mocks.asset.unlock).toHaveBeenCalledWith([assetId], undefined);
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(
        assetId,
        expect.arrayContaining([
          expect.objectContaining({
            value: expect.objectContaining({
              nsfwDetection: expect.objectContaining({
                review: expect.objectContaining({ action: 'marked-safe', isNsfw: false }),
              }),
            }),
          }),
        ]),
        undefined,
      );
    });

    it('records the owner review even when the check never counted the item as sensitive', async () => {
      mocks.asset.unlock.mockResolvedValue([{ assetId, reason: AssetLockReason.Marked }]);
      mocks.asset.getMetadataByKey.mockResolvedValue(undefined);

      await sut.unlockAssets(authStub.adminWithElevatedPermission, { ids: [assetId] });

      expect(mocks.asset.unlock).toHaveBeenCalledWith([assetId], undefined);
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(
        assetId,
        expect.arrayContaining([
          expect.objectContaining({
            value: expect.objectContaining({
              nsfwDetection: expect.objectContaining({
                review: expect.objectContaining({ action: 'marked-safe', isNsfw: false }),
              }),
            }),
          }),
        ]),
        undefined,
      );
    });

    it('writes the unlock reviews in the unlock transaction and never outside it', async () => {
      mocks.asset.unlock.mockResolvedValue([{ assetId, reason: AssetLockReason.Detected }]);
      mocks.asset.getMetadataByKey.mockResolvedValue(structuredClone(detectedMetadata));
      const transaction = { isTransaction: true } as never;
      mocks.database.withAssetMetadataLocks.mockImplementation((_assetIds, fn) => fn(transaction));

      await sut.unlockAssets(authStub.adminWithElevatedPermission, { ids: [assetId] });

      // one transaction, holding every group member's metadata lock
      expect(mocks.database.withAssetMetadataLocks).toHaveBeenCalledTimes(1);
      expect(mocks.database.withAssetMetadataLocks).toHaveBeenCalledWith([assetId], expect.any(Function));
      expect(mocks.asset.unlock).toHaveBeenCalledWith([assetId], transaction);
      expect(mocks.asset.lockGroupMembers).toHaveBeenCalledWith([assetId], transaction);
      // the review is written in that transaction, not in a per-asset follow-up one
      expect(mocks.asset.upsertMetadata.mock.calls[0]).toEqual([assetId, expect.any(Array), transaction]);
    });

    it('writes no review when the unlock reaches beyond the metadata-locked group', async () => {
      mocks.asset.unlock.mockResolvedValue([{ assetId: newUuid(), reason: AssetLockReason.Marked }]);

      await expect(sut.unlockAssets(authStub.adminWithElevatedPermission, { ids: [assetId] })).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
    });

    it('reviews nothing when nothing was unlocked', async () => {
      mocks.asset.unlock.mockResolvedValue([]);

      await sut.unlockAssets(authStub.adminWithElevatedPermission, { ids: [assetId] });

      expect(mocks.asset.lockGroupMembers).not.toHaveBeenCalled();
      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
    });

    it('locks earlier unreviewed detections when hiding sensitive detections is switched on', async () => {
      mocks.asset.getUnlockedDetectionIds.mockResolvedValue([assetId]);
      mocks.asset.lock.mockResolvedValue([assetId]);
      const oldConfig = { ...defaults, machineLearning: { ...defaults.machineLearning } };
      const newConfig = {
        ...defaults,
        machineLearning: {
          ...defaults.machineLearning,
          nsfwDetection: { ...defaults.machineLearning.nsfwDetection, hideFromLibrary: true },
        },
      };

      await sut.onConfigUpdate({ oldConfig, newConfig });

      expect(mocks.asset.lock).toHaveBeenCalledWith([assetId], AssetLockReason.Detected, null);
    });

    it('unlocks nothing when hiding sensitive detections is switched off', async () => {
      const oldConfig = {
        ...defaults,
        machineLearning: {
          ...defaults.machineLearning,
          nsfwDetection: { ...defaults.machineLearning.nsfwDetection, hideFromLibrary: true },
        },
      };

      await sut.onConfigUpdate({ oldConfig, newConfig: defaults });

      expect(mocks.asset.getUnlockedDetectionIds).not.toHaveBeenCalled();
      expect(mocks.asset.unlock).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.LockedDetectionsState, {
        hideFromLibrary: false,
      });
    });

    it('locks unreviewed detections on start when hiding is on and was not before', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.asset.getUnlockedDetectionIds.mockResolvedValue([assetId]);
      mocks.asset.lock.mockResolvedValue([assetId]);
      const newConfig = {
        ...defaults,
        machineLearning: {
          ...defaults.machineLearning,
          nsfwDetection: { ...defaults.machineLearning.nsfwDetection, hideFromLibrary: true },
        },
      };

      await sut.onConfigInit({ newConfig });

      expect(mocks.systemMetadata.get).toHaveBeenCalledWith(SystemMetadataKey.LockedDetectionsState);
      expect(mocks.asset.lock).toHaveBeenCalledWith([assetId], AssetLockReason.Detected, null);
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.LockedDetectionsState, {
        hideFromLibrary: true,
      });
    });

    it('locks nothing on start when hiding was already on', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ hideFromLibrary: true });
      const newConfig = {
        ...defaults,
        machineLearning: {
          ...defaults.machineLearning,
          nsfwDetection: { ...defaults.machineLearning.nsfwDetection, hideFromLibrary: true },
        },
      };

      await sut.onConfigInit({ newConfig });

      expect(mocks.asset.getUnlockedDetectionIds).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('only remembers the setting on start when hiding is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);

      await sut.onConfigInit({ newConfig: defaults });

      expect(mocks.asset.getUnlockedDetectionIds).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.LockedDetectionsState, {
        hideFromLibrary: false,
      });
    });
  });

  it('should clear previously applied NSFW tags when a rerun detects the asset as safe', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: {
        enabled: true,
        nsfwDetection: {
          enabled: true,
          modelName: 'onnx-community/nsfw_image_detection-ONNX',
          threshold: 0.85,
        },
        imageDescription: { enabled: false },
      },
    });
    mocks.asset.getMetadataByKey.mockResolvedValue({
      key: AssetMetadataKey.MlEnrichment,
      updatedAt: new Date(),
      value: {
        nsfwDetection: {
          status: 'success',
          modelName: 'onnx-community/nsfw_image_detection-ONNX',
          updatedAt: '2026-05-05T00:00:00.000Z',
          appliedTagHash: 'old-hash',
          appliedTagValues: ['nsfw', 'explicit'],
          result: {
            isNsfw: true,
            score: 0.95,
            labels: { explicit: 0.95 },
          },
        },
      },
    });
    mocks.machineLearning.detectNsfw.mockResolvedValue({
      isNsfw: false,
      score: 0.04,
      labels: { normal: 0.96 },
    });
    mocks.asset.getForUpdateTags.mockResolvedValue({ tags: [{ value: 'beach' }] });
    mocks.tag.getByValue
      .mockResolvedValueOnce({
        id: 'nsfw-id',
        value: 'nsfw',
        color: null,
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 'explicit-id',
        value: 'explicit',
        color: null,
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    await expect(sut.handleNsfwDetection({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.tag.removeAssetIds).toHaveBeenCalledWith('nsfw-id', [assetId]);
    expect(mocks.tag.removeAssetIds).toHaveBeenCalledWith('explicit-id', [assetId]);
    expect(mocks.asset.upsertExif).toHaveBeenCalledWith({
      exif: expect.objectContaining({ assetId, tags: ['beach'] }),
      lockedPropertiesBehavior: 'append',
    });
    const lastCall = mocks.asset.upsertMetadata.mock.calls.at(-1)!;
    const saved = lastCall[1][0].value as { nsfwDetection: Record<string, unknown> };
    expect(saved.nsfwDetection.result).toEqual(expect.objectContaining({ isNsfw: false }));
    expect(saved.nsfwDetection).not.toHaveProperty('appliedTagHash');
    expect(saved.nsfwDetection).not.toHaveProperty('appliedTagValues');
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: assetId } });
  });

  it('should clear generated description without removing user text', async () => {
    mocks.asset.getById.mockResolvedValue({
      id: assetId,
      ownerId,
      exifInfo: { description: 'User note\n\nAI description: A generated caption.' },
      tags: [],
    } as never);
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
    mocks.asset.getMetadataByKey.mockResolvedValue({
      key: AssetMetadataKey.MlEnrichment,
      updatedAt: new Date(),
      value: {
        description: {
          status: 'success',
          modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
          updatedAt: '2026-05-05T00:00:00.000Z',
          appliedDescriptionHash: 'hash',
          result: {
            description: 'A generated caption.',
            people: [],
            environment: '',
            objects: [],
            visible_text: [],
            context: '',
            tags: [],
          },
        },
      },
    });

    await sut.updateAssetEnrichment(authStub.admin, assetId, {
      action: AssetImageEnrichmentAction.ClearGeneratedDescription,
    });

    expect(mocks.asset.upsertExif).toHaveBeenCalledWith({
      exif: expect.objectContaining({ assetId, description: 'User note' }),
      lockedPropertiesBehavior: 'append',
    });
    expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(
      assetId,
      expect.arrayContaining([
        expect.objectContaining({
          value: {
            description: expect.not.objectContaining({ appliedDescriptionHash: expect.any(String) }),
          },
        }),
      ]),
      undefined,
    );
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: assetId } });
  });

  it('should not remove manually-authored tags when clearing generated tags without provenance', async () => {
    mocks.asset.getById.mockResolvedValue({
      id: assetId,
      ownerId,
      exifInfo: { description: '' },
      tags: [],
    } as never);
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
    mocks.asset.getMetadataByKey.mockResolvedValue({
      key: AssetMetadataKey.MlEnrichment,
      updatedAt: new Date(),
      value: {
        description: {
          status: 'success',
          modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
          updatedAt: '2026-05-05T00:00:00.000Z',
          appliedTagHash: 'hash',
          appliedTagValues: [],
          result: {
            description: '',
            people: [],
            environment: '',
            objects: [],
            visible_text: [],
            context: '',
            tags: ['Beach'],
          },
        },
      },
    });

    await sut.updateAssetEnrichment(authStub.admin, assetId, {
      action: AssetImageEnrichmentAction.ClearGeneratedTags,
    });

    expect(mocks.tag.getByValue).not.toHaveBeenCalled();
    expect(mocks.tag.removeAssetIds).not.toHaveBeenCalled();
    const lastCall = mocks.asset.upsertMetadata.mock.calls.at(-1)!;
    const saved = lastCall[1][0].value as { description: Record<string, unknown> };
    expect(saved.description).not.toHaveProperty('appliedTagHash');
    expect(saved.description).not.toHaveProperty('appliedTagValues');
    expect(mocks.job.queue).not.toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: assetId } });
  });

  describe('identity injection — face data wiring', () => {
    const enabledConfig = {
      machineLearning: {
        enabled: true,
        nsfwDetection: { enabled: false },
        imageDescription: { enabled: true },
      },
    };

    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue(enabledConfig);
      mocks.machineLearning.describeImage.mockResolvedValue({
        description: 'Conner is playing baseball.',
        people: [],
        environment: 'outdoor field',
        objects: ['baseball bat'],
        visible_text: [],
        context: 'youth baseball game',
        tags: ['baseball', 'outdoors'],
      });
    });

    it('passes named visible faces to the prompt assembler as knownPersons', async () => {
      mocks.person.getFaces.mockResolvedValue([
        {
          id: newUuid(),
          assetId,
          personGroupId: newUuid(),
          imageWidth: 400,
          imageHeight: 500,
          boundingBoxX1: 100,
          boundingBoxX2: 200,
          boundingBoxY1: 100,
          boundingBoxY2: 200,
          isVisible: true,
          deletedAt: null,
          correctedAt: null,
          sourceType: 'machine-learning' as never,
          updatedAt: new Date(),
          updateId: newUuid(),
          person: { id: newUuid(), name: 'Conner', isHidden: false } as never,
        },
      ]);

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      expect(mocks.person.getFaces).toHaveBeenCalledWith(assetId, {
        isVisible: true,
        viewingUserId: expect.any(String),
      });
      // The prompt assembler is called with a prompt that includes the known person hint.
      expect(mocks.machineLearning.describeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        previewFile,
        expect.anything(),
        undefined,
        expect.stringContaining('Conner'),
      );
    });

    it('excludes faces with null personId from knownPersons', async () => {
      mocks.person.getFaces.mockResolvedValue([
        {
          id: newUuid(),
          assetId,
          personGroupId: null,
          imageWidth: 400,
          imageHeight: 500,
          boundingBoxX1: 100,
          boundingBoxX2: 200,
          boundingBoxY1: 100,
          boundingBoxY2: 200,
          isVisible: true,
          deletedAt: null,
          correctedAt: null,
          sourceType: 'machine-learning' as never,
          updatedAt: new Date(),
          updateId: newUuid(),
          person: null,
        },
      ]);

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      // Prompt should NOT contain any name hint.
      expect(mocks.machineLearning.describeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        previewFile,
        expect.anything(),
        undefined,
        expect.not.stringContaining('Known people'),
      );
    });

    it('excludes faces linked to persons with an empty name', async () => {
      mocks.person.getFaces.mockResolvedValue([
        {
          id: newUuid(),
          assetId,
          personGroupId: newUuid(),
          imageWidth: 400,
          imageHeight: 500,
          boundingBoxX1: 100,
          boundingBoxX2: 200,
          boundingBoxY1: 100,
          boundingBoxY2: 200,
          isVisible: true,
          deletedAt: null,
          correctedAt: null,
          sourceType: 'machine-learning' as never,
          updatedAt: new Date(),
          updateId: newUuid(),
          person: { id: newUuid(), name: '', isHidden: false } as never,
        },
      ]);

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.describeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        previewFile,
        expect.anything(),
        undefined,
        expect.not.stringContaining('Known people'),
      );
    });

    it('excludes faces linked to persons whose name is only whitespace', async () => {
      mocks.person.getFaces.mockResolvedValue([
        {
          id: newUuid(),
          assetId,
          personGroupId: newUuid(),
          imageWidth: 400,
          imageHeight: 500,
          boundingBoxX1: 100,
          boundingBoxX2: 200,
          boundingBoxY1: 100,
          boundingBoxY2: 200,
          isVisible: true,
          deletedAt: null,
          correctedAt: null,
          sourceType: 'machine-learning' as never,
          updatedAt: new Date(),
          updateId: newUuid(),
          person: { id: newUuid(), name: ' '.repeat(3), isHidden: false } as never,
        },
      ]);

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.describeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        previewFile,
        expect.anything(),
        undefined,
        expect.not.stringContaining('Known people'),
      );
    });

    it('excludes faces linked to hidden persons', async () => {
      mocks.person.getFaces.mockResolvedValue([
        {
          id: newUuid(),
          assetId,
          personGroupId: newUuid(),
          imageWidth: 400,
          imageHeight: 500,
          boundingBoxX1: 100,
          boundingBoxX2: 200,
          boundingBoxY1: 100,
          boundingBoxY2: 200,
          isVisible: true,
          deletedAt: null,
          correctedAt: null,
          sourceType: 'machine-learning' as never,
          updatedAt: new Date(),
          updateId: newUuid(),
          person: { id: newUuid(), name: 'HiddenPerson', isHidden: true } as never,
        },
      ]);

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.describeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        previewFile,
        expect.anything(),
        undefined,
        expect.not.stringContaining('Known people'),
      );
    });

    it('skips faces with zero imageWidth to avoid NaN in boxCenter', async () => {
      mocks.person.getFaces.mockResolvedValue([
        {
          id: newUuid(),
          assetId,
          personGroupId: newUuid(),
          imageWidth: 0,
          imageHeight: 500,
          boundingBoxX1: 100,
          boundingBoxX2: 200,
          boundingBoxY1: 100,
          boundingBoxY2: 200,
          isVisible: true,
          deletedAt: null,
          correctedAt: null,
          sourceType: 'machine-learning' as never,
          updatedAt: new Date(),
          updateId: newUuid(),
          person: { id: newUuid(), name: 'ZeroWidth', isHidden: false } as never,
        },
      ]);

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.describeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        previewFile,
        expect.anything(),
        undefined,
        expect.not.stringContaining('Known people'),
      );
    });

    it('passes through the ML description unchanged when it already contains the known name', async () => {
      mocks.person.getFaces.mockResolvedValue([
        {
          id: newUuid(),
          assetId,
          personGroupId: newUuid(),
          imageWidth: 400,
          imageHeight: 500,
          boundingBoxX1: 100,
          boundingBoxX2: 200,
          boundingBoxY1: 100,
          boundingBoxY2: 200,
          isVisible: true,
          deletedAt: null,
          correctedAt: null,
          sourceType: 'machine-learning' as never,
          updatedAt: new Date(),
          updateId: newUuid(),
          person: { id: newUuid(), name: 'Conner', isHidden: false } as never,
        },
      ]);
      // ML returns description already containing the known name — no changes needed.
      mocks.machineLearning.describeImage.mockResolvedValue({
        description: 'Conner is playing baseball.',
        people: [],
        environment: 'outdoor field',
        objects: [],
        visible_text: [],
        context: '',
        tags: [],
      });

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      const descriptionCall = mocks.asset.upsertMetadata.mock.calls.find(
        (call) => (call[1][0]?.value as { description?: { result?: unknown } } | undefined)?.description?.result,
      )!;
      const saved = descriptionCall[1][0].value as { description: { result: { description: string } } };
      expect(saved.description.result.description).toBe('Conner is playing baseball.');
    });

    it('still describes the asset when face lookup throws (best-effort identity injection)', async () => {
      mocks.person.getFaces.mockRejectedValueOnce(new Error('db down'));

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      // describeImage must still be called, with a prompt that contains no
      // identity hint (knownPersons was empty due to the lookup failure).
      expect(mocks.machineLearning.describeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        previewFile,
        expect.anything(),
        undefined,
        expect.not.stringContaining('Known people'),
      );
    });

    it('strips hallucinated names before persisting the description', async () => {
      mocks.person.getFaces.mockResolvedValue([
        {
          id: newUuid(),
          assetId,
          personGroupId: newUuid(),
          imageWidth: 400,
          imageHeight: 500,
          boundingBoxX1: 100,
          boundingBoxX2: 200,
          boundingBoxY1: 100,
          boundingBoxY2: 200,
          isVisible: true,
          deletedAt: null,
          correctedAt: null,
          sourceType: 'machine-learning' as never,
          updatedAt: new Date(),
          updateId: newUuid(),
          person: { id: newUuid(), name: 'Conner', isHidden: false } as never,
        },
      ]);
      // ML hallucinated "Madison" — not in knownPersons.
      mocks.machineLearning.describeImage.mockResolvedValue({
        description: 'Conner and Madison are playing baseball.',
        people: [],
        environment: 'outdoor field',
        objects: [],
        visible_text: [],
        context: '',
        tags: [],
      });

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      const descriptionCall = mocks.asset.upsertMetadata.mock.calls.find(
        (call) => (call[1][0]?.value as { description?: { result?: unknown } } | undefined)?.description?.result,
      )!;
      const saved = descriptionCall[1][0].value as {
        description: { result: { description: string }; identityFlags?: { hallucinatedNames?: string[] } };
      };
      expect(saved.description.result.description).toBe('Conner and Someone are playing baseball.');
      expect(saved.description.identityFlags?.hallucinatedNames).toEqual(['Madison']);
    });
  });

  describe('smart-album integration', () => {
    const tags = ['beach', 'sunset'];

    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { enabled: false }, imageDescription: { enabled: true } },
        smartAlbums: { enabled: true },
      });
      mocks.machineLearning.describeImage.mockResolvedValue({
        description: 'A beach scene.',
        people: [],
        environment: 'outdoor',
        objects: [],
        visible_text: [],
        context: '',
        tags,
      });
      // smartAlbum mocks default to no-ops.
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(new Map());
      mocks.smartAlbum.getExcludedSmartAlbumIds.mockResolvedValue(new Set());
      mocks.smartAlbum.getMatchingKinds.mockResolvedValue([]);
      mocks.smartAlbum.getSmartAlbumIdForOwnerAndKind.mockResolvedValue(null);
      mocks.smartAlbum.isExcluded.mockResolvedValue(false);
      mocks.smartAlbum.addAssetToSmartAlbum.mockResolvedValue();
      mocks.smartAlbum.removeAssetFromSmartAlbum.mockResolvedValue();
    });

    it('should invoke smart-album evaluation with the asset, owner, and tags after a successful description', async () => {
      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      // The asset's ownerId is set by the test factory; just verify evaluate was
      // wired through with the right shape and the model-emitted tags.
      expect(mocks.smartAlbum.getAllSmartAlbumIdsForOwner).toHaveBeenCalledTimes(1);
      expect(mocks.smartAlbum.getMatchingKinds).toHaveBeenCalledWith(assetId, expect.any(String));
    });

    it('should not fail the description job when smartAlbumService.evaluate throws', async () => {
      mocks.smartAlbum.getMatchingKinds.mockRejectedValue(new Error('db exploded'));

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Smart-album evaluation failed'));
    });
  });

  describe('video descriptions', () => {
    const videoAssetId = newUuid();
    const source = {
      id: videoAssetId,
      ownerId,
      type: AssetType.Video,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      originalPath: '/data/library/clip.mp4',
      checksum: Buffer.from('aabb', 'hex'),
      fileModifiedAt: new Date('2026-01-01T00:00:00Z'),
      duration: 14_000,
      videoStream: {},
      format: { duration: 14_000 },
    };
    const fingerprint = sourceFingerprint(source);

    const baseVideoAsset = {
      id: videoAssetId,
      ownerId,
      type: AssetType.Video,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      description: '',
      previewFile,
    };

    const frames = [
      { id: newUuid(), assetId: videoAssetId, frameIndex: 2, timestampMs: 9000, path: '/frames/2.jpeg', rank: 1 },
      { id: newUuid(), assetId: videoAssetId, frameIndex: 0, timestampMs: 1000, path: '/frames/0.jpeg', rank: 3 },
      { id: newUuid(), assetId: videoAssetId, frameIndex: 1, timestampMs: 5000, path: '/frames/1.jpeg', rank: 2 },
      { id: newUuid(), assetId: videoAssetId, frameIndex: 3, timestampMs: 13_000, path: '/frames/3.jpeg', rank: 4 },
    ];

    const describedAs = {
      description: 'A short video.',
      people: [],
      environment: 'outdoors',
      objects: [],
      visible_text: [],
      context: '',
      tags: [],
    };

    let moments: Record<string, ReturnType<typeof vi.fn>>;

    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          nsfwDetection: { enabled: false },
          imageDescription: { enabled: true, modelName: 'Qwen/Qwen2.5-VL-3B-Instruct' },
        },
      });
      mocks.assetJob.getForImageEnrichment.mockResolvedValue(baseVideoAsset);
      moments = {
        getVideoSource: vi.fn().mockResolvedValue(source),
        getFingerprints: vi.fn().mockResolvedValue(new Map([[videoAssetId, fingerprint]])),
        getIndex: vi
          .fn()
          .mockResolvedValue({ sourceFingerprint: fingerprint, extractorVersion: VIDEO_MOMENT_EXTRACTOR_VERSION }),
        getFrames: vi.fn().mockResolvedValue(frames),
        replaceFrames: vi.fn(),
        withFrameLock: vi.fn((_assetId: string, callback: () => Promise<unknown>) => callback()),
      };
      sut.useVideoMomentRepository(moments as never);
    });

    it('persists a skipped status with video-frames-unavailable when no frames can be had', async () => {
      moments.getVideoSource.mockResolvedValue(undefined);

      await expect(sut.handleImageDescription({ id: videoAssetId })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.machineLearning.describeImage).not.toHaveBeenCalled();
      expect(mocks.media.composeImageGrid).not.toHaveBeenCalled();

      const skipCall = mocks.asset.upsertMetadata.mock.calls.find(
        (call) =>
          (call[1][0]?.value as { description?: { status?: string } } | undefined)?.description?.status === 'skipped',
      )!;
      expect(skipCall).toBeDefined();
      const saved = skipCall[1][0].value as { description: { status: string; reason: string } };
      expect(saved.description.reason).toBe('video-frames-unavailable');
    });

    it('composes a grid of the reusable frames in time order, without duplicate detection', async () => {
      mocks.machineLearning.describeImage.mockResolvedValue(describedAs);

      await expect(sut.handleImageDescription({ id: videoAssetId })).resolves.toBe(JobStatus.Success);

      expect(mocks.duplicateRepository.getVideoDuplicateFrames).not.toHaveBeenCalled();
      expect(moments.replaceFrames).not.toHaveBeenCalled();
      expect(mocks.media.composeImageGrid).toHaveBeenCalledWith(
        ['/frames/0.jpeg', '/frames/1.jpeg', '/frames/2.jpeg', '/frames/3.jpeg'],
        expect.objectContaining({ cols: 2, rows: 2, output: expect.stringContaining('_description_grid.jpeg') }),
      );

      // The explicit destination selection is the first argument (FL-110); the path follows it.
      const describeCall = mocks.machineLearning.describeImage.mock.calls[0];
      const gridPath = describeCall[1] as string;
      expect(gridPath).toContain('_description_grid.jpeg');
      // Prompt is the 5th arg; it should include the video grid prefix.
      const prompt = describeCall[4] as string;
      expect(prompt).toContain('composite');
      expect(prompt).toContain('frames sampled from a video');

      // Grid file is cleaned up after the run.
      expect(mocks.storage.unlink).toHaveBeenCalledWith(gridPath);
    });

    it('pins the source fingerprint and the confirmed names on the stored description', async () => {
      mocks.machineLearning.describeImage.mockResolvedValue(describedAs);

      await sut.handleImageDescription({ id: videoAssetId });

      const saved = mocks.asset.upsertMetadata.mock.calls
        .map((call) => call[1][0]?.value as { description?: { status?: string; provenance?: Record<string, string> } })
        .find((value) => value?.description?.status === 'success')!;
      expect(saved.description!.provenance).toEqual(
        expect.objectContaining({
          sourceFingerprint: fingerprint,
          identityHash: identityHash([]),
          destinationId: expect.any(String),
        }),
      );
    });

    it('publishes nothing when the original is replaced while the model is working', async () => {
      moments.getFingerprints
        .mockResolvedValueOnce(new Map([[videoAssetId, fingerprint]]))
        .mockResolvedValueOnce(new Map([[videoAssetId, 'replaced']]));
      mocks.machineLearning.describeImage.mockResolvedValue(describedAs);

      await expect(sut.describeAsset(videoAssetId)).resolves.toEqual({
        status: JobStatus.Skipped,
        reasonKey: 'source-changed',
      });

      const published = mocks.asset.upsertMetadata.mock.calls.some(
        (call) =>
          (call[1][0]?.value as { description?: { status?: string } } | undefined)?.description?.status === 'success',
      );
      expect(published).toBe(false);
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
    });

    it('keeps the image-asset path unchanged (no grid compose, no video context)', async () => {
      mocks.assetJob.getForImageEnrichment.mockResolvedValue({
        id: assetId,
        ownerId,
        type: AssetType.Image,
        status: AssetStatus.Active,
        deletedAt: null,
        visibility: AssetVisibility.Timeline,
        description: '',
        previewFile,
      });
      mocks.machineLearning.describeImage.mockResolvedValue({ ...describedAs, description: 'A bright kitchen.' });

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Success);

      expect(mocks.media.composeImageGrid).not.toHaveBeenCalled();
      expect(moments.getVideoSource).not.toHaveBeenCalled();
      const describeCall = mocks.machineLearning.describeImage.mock.calls[0];
      expect(describeCall[1]).toBe(previewFile);
      expect(describeCall[4] as string).not.toContain('composite');
    });
  });

  describe('enrichment plan stages (FL-59)', () => {
    it('sends a pinned plan to the destination it pinned, not the routed one', async () => {
      const pinned = { ...mlDestinationStub.local, id: newUuid() };
      mocks.mlDestination.getById.mockResolvedValue(pinned);
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: false } },
      });
      mocks.machineLearning.detectNsfw.mockResolvedValue({ isNsfw: false, score: 0.01, labels: {} });

      await expect(
        sut.detectLockedContent(assetId, { enrichmentDestinationId: pinned.id, nsfwDetection: { threshold: 0.5 } }),
      ).resolves.toEqual({ status: JobStatus.Success });

      expect(mocks.mlDestination.getRoute).not.toHaveBeenCalled();
      expect(mocks.mlDestination.getById).toHaveBeenCalledWith(pinned.id);
      expect(mocks.machineLearning.detectNsfw).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: pinned.id }),
        previewFile,
        expect.objectContaining({ threshold: 0.5 }),
      );
    });

    it('leaves the description embedding alone when the plan pinned no search destination', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { enabled: true, nsfwDetection: { enabled: false }, imageDescription: { enabled: true } },
      });
      mocks.machineLearning.describeImage.mockResolvedValue({
        description: 'A bright kitchen.',
        people: [],
        environment: 'indoors',
        objects: [],
        visible_text: [],
        context: '',
        tags: [],
      });

      await expect(
        sut.describeAsset(assetId, {
          planRun: true,
          enrichmentDestinationId: mlDestinationStub.local.id,
          searchDestinationId: null,
        }),
      ).resolves.toEqual({ status: JobStatus.Success });

      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
      expect(mocks.mlDestination.getRoute).not.toHaveBeenCalled();
    });

    it('reports a refused destination as a failed stage with the reason', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: false } },
      });
      mocks.mlDestination.getById.mockResolvedValue(undefined);

      const result = await sut.detectLockedContent(assetId, { enrichmentDestinationId: newUuid() });

      expect(result).toEqual(expect.objectContaining({ status: JobStatus.Failed, reasonKey: 'model-error' }));
      expect(mocks.machineLearning.detectNsfw).not.toHaveBeenCalled();
    });

    it('skips the Locked-content check for a video', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: false } },
      });
      mocks.assetJob.getForImageEnrichment.mockResolvedValue({
        id: assetId,
        ownerId,
        type: AssetType.Video,
        status: AssetStatus.Active,
        deletedAt: null,
        visibility: AssetVisibility.Timeline,
        description: '',
        previewFile,
      });

      await expect(sut.detectLockedContent(assetId)).resolves.toEqual({
        status: JobStatus.Skipped,
        reasonKey: 'not-an-image',
      });
    });
  });

  describe('previewDescription (FL-59)', () => {
    it('describes a sample with the draft prompt and writes nothing', async () => {
      mocks.machineLearning.describeImage.mockResolvedValue({
        description: 'A turquoise alpine lake.',
        people: [],
        environment: 'outdoors',
        objects: [],
        visible_text: [],
        context: '',
        tags: ['lake'],
      });
      const draft = {
        ...defaults.machineLearning.imageDescription,
        modelName: 'draft-model',
        prompt: { ...defaults.machineLearning.imageDescription.prompt, customInstructions: 'Name the lake.' },
      };

      const preview = await sut.previewDescription(assetId, {
        imageDescription: draft,
        destinationId: mlDestinationStub.local.id,
      });

      expect(preview).toEqual(
        expect.objectContaining({ status: 'success', candidate: 'A turquoise alpine lake.', modelName: 'draft-model' }),
      );
      expect(mocks.machineLearning.describeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: mlDestinationStub.local.id }),
        previewFile,
        expect.objectContaining({ modelName: 'draft-model' }),
        undefined,
        expect.stringContaining('Name the lake.'),
      );
      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.tag.upsertAssetIds).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.asset.lock).not.toHaveBeenCalled();
    });

    it('reports a model failure without writing a failed status', async () => {
      mocks.machineLearning.describeImage.mockRejectedValue(new Error('model offline'));

      const preview = await sut.previewDescription(assetId, {
        imageDescription: defaults.machineLearning.imageDescription,
        destinationId: mlDestinationStub.local.id,
      });

      expect(preview).toEqual(expect.objectContaining({ status: 'failed', message: 'model offline' }));
      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
    });
  });

  describe('face and person changes (FL-57)', () => {
    const enabledConfig = {
      machineLearning: { enabled: true, nsfwDetection: { enabled: false }, imageDescription: { enabled: true } },
    };
    const namedFace = (name: string) => ({
      id: newUuid(),
      assetId,
      personGroupId: newUuid(),
      imageWidth: 400,
      imageHeight: 500,
      boundingBoxX1: 100,
      boundingBoxX2: 200,
      boundingBoxY1: 100,
      boundingBoxY2: 200,
      isVisible: true,
      deletedAt: null,
      correctedAt: null,
      sourceType: 'machine-learning' as never,
      updatedAt: new Date(),
      updateId: newUuid(),
      person: { id: newUuid(), name, isHidden: false } as never,
    });
    const publishedDescription = () =>
      mocks.asset.upsertMetadata.mock.calls.some(
        (call) =>
          (call[1][0]?.value as { description?: { status?: string } } | undefined)?.description?.status === 'success',
      );

    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue(enabledConfig);
      mocks.machineLearning.describeImage.mockResolvedValue({
        description: 'Ada is at the beach.',
        people: [],
        environment: 'beach',
        objects: [],
        visible_text: [],
        context: '',
        tags: ['beach'],
      });
    });

    it('publishes nothing and describes again when a name changes while the model is working', async () => {
      // the names the prompt got, then the names under the publish lock after a rename
      mocks.person.getFaces.mockResolvedValueOnce([namedFace('Ada')]).mockResolvedValue([namedFace('Ada Lovelace')]);

      await expect(sut.describeAsset(assetId)).resolves.toEqual({
        status: JobStatus.Skipped,
        reasonKey: 'identity-changed',
      });

      expect(publishedDescription()).toBe(false);
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.ImageDescription, data: { id: assetId } });
    });

    it('fails a plan stage instead of queueing, so the plan retries with its pinned destination', async () => {
      const pinned = { ...mlDestinationStub.local, id: newUuid() };
      mocks.mlDestination.getById.mockResolvedValue(pinned);
      mocks.person.getFaces.mockResolvedValueOnce([namedFace('Ada')]).mockResolvedValue([]);

      await expect(sut.describeAsset(assetId, { planRun: true, enrichmentDestinationId: pinned.id })).resolves.toEqual({
        status: JobStatus.Failed,
        reasonKey: 'identity-changed',
      });

      expect(publishedDescription()).toBe(false);
      expect(mocks.job.queue).not.toHaveBeenCalledWith({ name: JobName.ImageDescription, data: { id: assetId } });
    });

    it('publishes when the names are unchanged', async () => {
      mocks.person.getFaces.mockResolvedValue([namedFace('Ada')]);
      await expect(sut.describeAsset(assetId)).resolves.toEqual({ status: JobStatus.Success });
      expect(publishedDescription()).toBe(true);
    });

    it('describes again only the affected assets whose generated description names other people', async () => {
      const stale = newUuid();
      const current = newUuid();
      const manualOnly = newUuid();
      const names = identityHash(['Ada']);
      mocks.asset.getById.mockImplementation((id: string) =>
        Promise.resolve({ id, ownerId, type: AssetType.Image, deletedAt: null } as never),
      );
      mocks.person.getFaces.mockResolvedValue([namedFace('Ada')]);
      mocks.database.withAssetMetadataLock.mockImplementation((_id, fn) => fn({} as never));
      const stored: Record<string, unknown> = {
        [stale]: {
          description: { status: 'success', result: {}, provenance: { identityHash: identityHash(['Eve']) } },
        },
        [current]: { description: { status: 'success', result: {}, provenance: { identityHash: names } } },
        [manualOnly]: {},
      };
      mocks.asset.getMetadataByKey.mockImplementation((id: string) =>
        Promise.resolve({ value: stored[id] ?? {} } as never),
      );
      mocks.person.getAssetIdsForPeople.mockResolvedValueOnce([stale, current, manualOnly]).mockResolvedValue([]);
      const personGroupId = newUuid();

      await expect(sut.handlePersonIdentityRefresh({ ownerId, personGroupIds: [personGroupId] })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mocks.person.getAssetIdsForPeople).toHaveBeenCalledWith(ownerId, [personGroupId], {
        after: undefined,
        limit: expect.any(Number),
      });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.ImageDescription, data: { id: stale } }]);
      expect(mocks.job.queueAll).not.toHaveBeenCalledWith(
        expect.arrayContaining([{ name: JobName.ImageDescription, data: { id: current } }]),
      );
    });

    it('withdraws stale generated captions of an affected video', async () => {
      const video = newUuid();
      const moments = { withdrawStaleCaptions: vi.fn().mockResolvedValue(2) };
      sut.useVideoMomentRepository(moments as never);
      mocks.asset.getById.mockResolvedValue({ id: video, ownerId, type: AssetType.Video, deletedAt: null } as never);
      mocks.person.getFaces.mockResolvedValue([namedFace('Ada')]);
      mocks.database.withAssetMetadataLock.mockImplementation((_id, fn) => fn({} as never));
      mocks.asset.getMetadataByKey.mockResolvedValue({ value: {} } as never);
      mocks.person.getAssetIdsForPeople.mockResolvedValue([]);

      await sut.handlePersonIdentityRefresh({ ownerId, assetIds: [video] });

      expect(moments.withdrawStaleCaptions).toHaveBeenCalledWith(video, identityHash(['Ada']));
      expect(mocks.job.queueAll).toHaveBeenCalledWith([]);
    });
  });

  describe('Frameleaf Cloud description batches (FL-163)', () => {
    const cloud = mlDestinationStub.frameleafCloudConsented;
    const configure = (autoDescribe: boolean, settings: { enabled?: boolean; descriptions?: string } = {}) =>
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          (key === SystemMetadataKey.SystemConfig
            ? {
                machineLearning: {
                  enabled: true,
                  nsfwDetection: { enabled: true },
                  imageDescription: { enabled: true },
                },
                frameleafCloud: {
                  cloudMl: {
                    ...defaults.frameleafCloud.cloudMl,
                    enabled: settings.enabled ?? true,
                    routing: {
                      ...defaults.frameleafCloud.cloudMl.routing,
                      descriptions: settings.descriptions ?? 'cloud',
                    },
                    autoDescribe: { enabled: autoDescribe, dailyBudgetUsd: 2 },
                  },
                },
              }
            : null) as never,
        ),
      );

    beforeEach(() => {
      mocks.mlDestination.getRoute.mockResolvedValue({
        workload: MlWorkload.Enrichment,
        destinationId: cloud.id,
        modelId: null,
        updatedAt: new Date(),
      });
      mocks.mlDestination.getById.mockResolvedValue(cloud);
      mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
    });

    it('never describes a photo routed to Frameleaf Cloud on its own, and sends nothing from here', async () => {
      configure(false);

      await expect(sut.describeAsset(assetId)).resolves.toEqual({
        status: JobStatus.Skipped,
        reasonKey: 'cloud-batch',
      });

      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
      expect(mocks.machineLearning.detectNsfw).not.toHaveBeenCalled();
      expect(mocks.machineLearning.describeImage).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('adds the photo to the automatic queue when new photos are described automatically', async () => {
      configure(true);

      await expect(sut.handleImageDescription({ id: assetId })).resolves.toBe(JobStatus.Skipped);
      // new photos are written to the queue in batches, not one read-modify-write each
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      await sut.flushCloudDescriptionQueue();

      expect(mocks.database.withLock).toHaveBeenCalledWith(
        DatabaseLock.FrameleafCloudMlBatchQueue,
        expect.any(Function),
      );
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.FrameleafCloudDescriptionQueue, {
        items: [{ assetId, ownerId, queuedAt: expect.any(String) }],
        lastBatchAt: {},
      });
      expect(mocks.machineLearning.describeImage).not.toHaveBeenCalled();
    });

    it.each([
      ['processing is turned off', { enabled: false }],
      ['descriptions are kept on this server', { descriptions: 'local' }],
    ])('refuses, rather than waits, while %s (review P2)', async (_label, settings) => {
      configure(true, settings);

      const result = await sut.describeAsset(assetId);

      expect(result).toEqual(expect.objectContaining({ status: JobStatus.Failed, reasonKey: 'cloud-turned-off' }));
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith(
        assetId,
        [
          expect.objectContaining({
            key: AssetMetadataKey.MlEnrichment,
            value: expect.objectContaining({
              description: expect.objectContaining({
                status: 'failed',
                error: expect.stringMatching(/Nothing was sent/),
              }),
            }),
          }),
        ],
        undefined,
      );
      await sut.flushCloudDescriptionQueue();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.machineLearning.describeImage).not.toHaveBeenCalled();
    });

    it('leaves a video routed to Frameleaf Cloud undescribed rather than describing it here', async () => {
      configure(true);
      mocks.assetJob.getForImageEnrichment.mockResolvedValue({
        id: assetId,
        ownerId,
        type: AssetType.Video,
        status: AssetStatus.Active,
        deletedAt: null,
        visibility: AssetVisibility.Timeline,
        description: '',
        previewFile,
      });

      await expect(sut.describeAsset(assetId)).resolves.toEqual({
        status: JobStatus.Skipped,
        reasonKey: 'cloud-photos-only',
      });
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.machineLearning.describeImage).not.toHaveBeenCalled();
    });

    it('sends a plan pinned to Frameleaf Cloud to batches too', async () => {
      configure(false);

      await expect(
        sut.describeAsset(assetId, { planRun: true, enrichmentDestinationId: cloud.id, searchDestinationId: null }),
      ).resolves.toEqual({ status: JobStatus.Skipped, reasonKey: 'cloud-batch' });

      expect(mocks.mlDestination.getRoute).not.toHaveBeenCalled();
      expect(mocks.machineLearning.describeImage).not.toHaveBeenCalled();
    });

    it('does not claim batches for describe-all while cloud processing is off (review re-check)', async () => {
      configure(false, { enabled: false });
      mocks.assetJob.streamForImageDescriptionJob.mockReturnValue(makeStream([{ id: assetId }]));

      await expect(sut.handleQueueImageDescription({ force: false })).resolves.toBe(JobStatus.Success);

      // each photo is then refused with the reason (cloud-turned-off), never described here
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.ImageDescription, data: { id: assetId } }]);
    });

    it('queues no library-wide description jobs while descriptions are routed to Frameleaf Cloud', async () => {
      configure(false);
      mocks.assetJob.streamForImageDescriptionJob.mockReturnValue(makeStream([{ id: assetId }]));

      await expect(sut.handleQueueImageDescription({ force: false })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.assetJob.streamForImageDescriptionJob).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });
});
