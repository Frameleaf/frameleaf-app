import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetFileType, JobName, JobStatus } from 'src/enum.js';
import { AssetOriginField } from 'src/repositories/partner-origin.repository.js';
import { FaceFolderExclusionService } from 'src/services/face-folder-exclusion.service.js';
import { PartnerCopyService } from 'src/services/partner-copy.service.js';
import { PersonService } from 'src/services/person.service.js';
import { normaliseFaceFolderPrefix } from 'src/utils/face-folder-exclusion.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { getForDetectedFaces } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const orderable = <T extends object>(value: T) => {
  const query: T & { clearOrderBy: () => unknown } = { ...value, clearOrderBy: () => query };
  return query;
};

describe('FL-934 face folder exclusions', () => {
  describe(normaliseFaceFolderPrefix.name, () => {
    it.each([
      ['/photos/scan', '/photos/scan/'],
      ['/photos/scan/', '/photos/scan/'],
      ['  /photos//scan///  ', '/photos/scan/'],
      ['/photos/./old/../scan', '/photos/scan/'],
    ])('stores %j as %j', (input, expected) => {
      expect(normaliseFaceFolderPrefix(input)).toBe(expected);
    });

    it.each([
      '',
      ' '.repeat(3),
      '/',
      '//',
      '/..',
      '/photos/..',
      'photos/scan',
      './scan',
      '/pho\0tos',
      `/${'a'.repeat(4096)}`,
    ])('refuses %j', (input) => {
      expect(normaliseFaceFolderPrefix(input)).toBeNull();
    });

    it('ends in a slash, so a folder never takes in a sibling that starts with its name', () => {
      const prefix = normaliseFaceFolderPrefix('/photos/scan')!;
      expect('/photos/scan/a.jpg'.startsWith(prefix)).toBe(true);
      expect('/photos/scans/a.jpg'.startsWith(prefix)).toBe(false);
    });
  });

  describe(FaceFolderExclusionService.name, () => {
    let sut: FaceFolderExclusionService;
    let mocks: ServiceMocks;
    const auth = AuthFactory.create();
    const exclusion = { id: newUuid(), pathPrefix: '/photos/scans/', createdAt: new Date('2026-11-15T10:00:00.000Z') };

    beforeEach(() => {
      ({ sut, mocks } = newTestService(FaceFolderExclusionService));
    });

    it('lists only the caller’s own folders', async () => {
      mocks.person.getFaceFolderExclusions.mockResolvedValue([exclusion]);
      await expect(sut.getAll(auth)).resolves.toEqual([
        { id: exclusion.id, pathPrefix: '/photos/scans/', createdAt: '2026-11-15T10:00:00.000Z' },
      ]);
      expect(mocks.person.getFaceFolderExclusions).toHaveBeenCalledWith(auth.user.id);
    });

    describe('preview', () => {
      it('counts the faces that would go and stay, for the stored folder', async () => {
        mocks.person.getFaceFolderPreview.mockResolvedValue({ assetCount: 4, removableFaceCount: 6, keptFaceCount: 2 });
        await expect(sut.preview(auth, { pathPrefix: '/photos/scans' })).resolves.toEqual({
          pathPrefix: '/photos/scans/',
          assetCount: 4,
          removableFaceCount: 6,
          keptFaceCount: 2,
        });
        expect(mocks.person.getFaceFolderPreview).toHaveBeenCalledWith(auth.user.id, '/photos/scans/');
        expect(mocks.person.removeUnconfirmedFolderFaces).not.toHaveBeenCalled();
      });

      it.each(['/', 'photos'])('refuses %j', async (pathPrefix) => {
        await expect(sut.preview(auth, { pathPrefix })).rejects.toBeInstanceOf(BadRequestException);
        expect(mocks.person.getFaceFolderPreview).not.toHaveBeenCalled();
      });
    });

    describe('create', () => {
      it.each(['/', '', 'relative/path'])('refuses %j and changes nothing', async (pathPrefix) => {
        await expect(sut.create(auth, { pathPrefix })).rejects.toBeInstanceOf(BadRequestException);
        expect(mocks.person.createFaceFolderExclusion).not.toHaveBeenCalled();
        expect(mocks.person.removeUnconfirmedFolderFaces).not.toHaveBeenCalled();
      });

      it('stores the folder, removes its unconfirmed faces under the merge lock and marks its photos done', async () => {
        const featured = [{ ownerId: auth.user.id, personGroupId: newUuid() }];
        const assetIds = [newUuid(), newUuid()];
        let locked = false;
        mocks.person.withMergeWrite.mockImplementation(async (write) => {
          locked = true;
          try {
            return await write();
          } finally {
            locked = false;
          }
        });
        mocks.person.createFaceFolderExclusion.mockResolvedValue(exclusion);
        mocks.person.removeUnconfirmedFolderFaces.mockImplementation(() => {
          expect(locked).toBe(true);
          return Promise.resolve({ faceCount: 3, assetIds, featured });
        });
        mocks.person.getBestFace.mockResolvedValue(undefined);
        mocks.person.update.mockResolvedValue({} as never);

        await expect(sut.create(auth, { pathPrefix: '/photos/scans' })).resolves.toEqual({
          id: exclusion.id,
          pathPrefix: '/photos/scans/',
          createdAt: '2026-11-15T10:00:00.000Z',
          removedFaceCount: 3,
        });

        expect(mocks.person.createFaceFolderExclusion).toHaveBeenCalledWith(auth.user.id, '/photos/scans/');
        expect(mocks.person.removeUnconfirmedFolderFaces).toHaveBeenCalledWith(auth.user.id, '/photos/scans/');
        expect(mocks.person.withMergeWrite).toHaveBeenCalledWith(expect.any(Function), auth.user.id);
        expect(mocks.person.markFaceFolderExcludedDetected).toHaveBeenCalledWith(auth.user.id);
        // the person whose main photo went gets another (none left here, so none)
        expect(mocks.person.getBestFace).toHaveBeenCalledWith(featured[0].personGroupId, auth.user.id);
        expect(mocks.job.queueAll).toHaveBeenCalledWith([
          { name: JobName.SidecarWrite, data: { id: assetIds[0], facesOnly: true } },
          { name: JobName.SidecarWrite, data: { id: assetIds[1], facesOnly: true } },
          { name: JobName.PersonIdentityRefresh, data: { ownerId: auth.user.id, assetIds } },
          { name: JobName.PersonCleanup },
        ]);
        // faces never follow out of a folder its owner left out, so partner copies are not touched
        expect(mocks.partnerOrigin.getIdsWithFollowers).not.toHaveBeenCalled();
      });

      it('queues nothing when no face had to go', async () => {
        mocks.person.createFaceFolderExclusion.mockResolvedValue(exclusion);
        mocks.person.removeUnconfirmedFolderFaces.mockResolvedValue({ faceCount: 0, assetIds: [], featured: [] });

        await expect(sut.create(auth, { pathPrefix: '/photos/scans/' })).resolves.toMatchObject({
          removedFaceCount: 0,
        });
        expect(mocks.person.markFaceFolderExcludedDetected).toHaveBeenCalledWith(auth.user.id);
        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      });
    });

    describe('delete', () => {
      it('takes the folder back in and finds faces there again', async () => {
        const selection = { kind: 'selection' };
        mocks.person.deleteFaceFolderExclusion.mockResolvedValue(exclusion);
        mocks.assetJob.selectionForFaceFolderDetection.mockReturnValue(selection as never);

        await sut.delete(auth, exclusion.id);

        expect(mocks.person.deleteFaceFolderExclusion).toHaveBeenCalledWith(auth.user.id, exclusion.id);
        expect(mocks.person.resetFaceFolderDetected).toHaveBeenCalledWith(auth.user.id, '/photos/scans/');
        expect(mocks.assetJob.selectionForFaceFolderDetection).toHaveBeenCalledWith(auth.user.id, '/photos/scans/');
        expect(mocks.job.queueSelection).toHaveBeenCalledWith(JobName.AssetDetectFaces, selection);
      });

      it('is not found for another owner’s folder', async () => {
        mocks.person.deleteFaceFolderExclusion.mockResolvedValue(undefined);
        await expect(sut.delete(auth, exclusion.id)).rejects.toBeInstanceOf(NotFoundException);
        expect(mocks.job.queueSelection).not.toHaveBeenCalled();
        expect(mocks.person.resetFaceFolderDetected).not.toHaveBeenCalled();
      });
    });
  });

  describe(PersonService.name, () => {
    let sut: PersonService;
    let mocks: ServiceMocks;

    beforeEach(() => {
      ({ sut, mocks } = newTestService(PersonService));
    });

    it('marks excluded photos done before queuing everything else', async () => {
      const order: string[] = [];
      mocks.person.markFaceFolderExcludedDetected.mockImplementation(() => {
        order.push('mark');
        return Promise.resolve(2);
      });
      mocks.job.queueSelection.mockImplementation(() => {
        order.push('queue');
        return Promise.resolve({ runId: 'run', inserted: 1 });
      });
      mocks.assetJob.selectionForDetectFacesJob.mockReturnValue(orderable({ selected: [] }) as never);

      await expect(sut.handleQueueDetectFaces({ force: true })).resolves.toBe(JobStatus.Success);
      expect(mocks.person.markFaceFolderExcludedDetected).toHaveBeenCalledWith();
      expect(order).toEqual(['mark', 'queue']);
    });

    it('never reads a photo in an excluded folder, here, on Frameleaf Cloud or on Frameleaf Desktop', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue({
        ...getForDetectedFaces(asset),
        isFaceFolderExcluded: true,
      });

      await expect(sut.handleDetectFaces({ id: asset.id })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.machineLearning.detectFaces).not.toHaveBeenCalled();
      expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: asset.id,
        facesRecognizedAt: expect.any(Date),
      });
    });

    it('detects a photo outside any excluded folder as before', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.machineLearning.detectFaces.mockResolvedValue({ imageHeight: 1, imageWidth: 1, faces: [] });

      await sut.handleDetectFaces({ id: asset.id });
      expect(mocks.machineLearning.detectFaces).toHaveBeenCalled();
    });

    it('does not store faces that arrive after the folder was left out', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue({
        ...getForDetectedFaces(asset),
        isFaceFolderExcluded: true,
      });

      await sut.publishDetectedFaces(asset.id, {
        previewPath: asset.files[0].path,
        checksum: asset.checksum.toString('hex'),
        imageWidth: 10,
        imageHeight: 10,
        faces: [{ boundingBox: { x1: 1, y1: 1, x2: 5, y2: 5 }, embedding: '[1,2,3]' }],
      });

      expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: asset.id,
        facesRecognizedAt: expect.any(Date),
      });
    });

    it('lets a partner copy find its own faces when the source’s owner left that folder out', async () => {
      const copy = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(copy));
      mocks.partnerOrigin.getOrigin.mockResolvedValue({
        id: copy.id,
        sourceId: 'source',
        ownerId: 'partner',
        rootOwnerId: 'owner',
        partnerSharedById: 'owner',
        overriddenFields: [],
        following: true,
      });
      mocks.partnerOrigin.getLiveSourceId.mockResolvedValue('source');
      mocks.person.getFaceFolderExcludedAssetIds.mockResolvedValue(new Set(['source']));
      mocks.machineLearning.detectFaces.mockResolvedValue({ imageHeight: 1, imageWidth: 1, faces: [] });

      await sut.handleDetectFaces({ id: copy.id });

      expect(mocks.person.getFaceFolderExcludedAssetIds).toHaveBeenCalledWith(['source']);
      expect(mocks.machineLearning.detectFaces).toHaveBeenCalled();
      expect(mocks.job.queueOutsideRun).not.toHaveBeenCalled();
    });
  });

  describe(PartnerCopyService.name, () => {
    let sut: PartnerCopyService;
    let mocks: ServiceMocks;
    const follower = {
      id: 'copy',
      sourceId: 'source',
      ownerId: 'partner',
      rootOwnerId: 'owner',
      partnerSharedById: 'owner',
      overriddenFields: [],
      following: true,
    };

    beforeEach(() => {
      ({ sut, mocks } = newTestService(PartnerCopyService));
      mocks.partnerOrigin.getFollowers.mockResolvedValue([follower]);
      mocks.partnerOrigin.withFollowingOrigin.mockImplementation(async (_kind, _sourceId, _id, apply) =>
        apply(follower),
      );
    });

    it.each([['source'], ['copy']])(
      'carries no faces when the photo is in a folder its owner left out (%s)',
      async (excluded) => {
        mocks.person.getFaceFolderExcludedAssetIds.mockResolvedValue(new Set([excluded]));

        await sut.handlePropagate({
          kind: 'asset',
          sourceId: 'source',
          fields: [AssetOriginField.Faces, AssetOriginField.Tags],
        });

        expect(mocks.person.getFaceFolderExcludedAssetIds).toHaveBeenCalledWith(['source', 'copy']);
        expect(mocks.partnerOrigin.applyAssetFields).toHaveBeenCalledWith('source', 'copy', [AssetOriginField.Tags]);
        expect(mocks.person.deleteFacesOfAsset).not.toHaveBeenCalled();
        expect(mocks.job.queueAll).toHaveBeenCalledWith([
          {
            name: JobName.PartnerPropagate,
            data: { kind: 'asset', sourceId: 'copy', fields: [AssetOriginField.Tags] },
          },
        ]);
      },
    );
  });
});
