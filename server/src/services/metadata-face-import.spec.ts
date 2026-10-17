import { randomUUID } from 'node:crypto';
import { AssetVisibility, ExifOrientation, JobName } from 'src/enum.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { newTestService } from 'test/utils.js';

it.each([false, true])('reuses a new tagged person across case variants, locked=%s', async (isLocked) => {
  const { sut, mocks } = newTestService(MetadataService);
  mocks.person.getDistinctNames.mockResolvedValue([]);
  mocks.crypto.randomUUID.mockImplementation(randomUUID);
  const area = { X: 0.2, Y: 0.3, W: 0.1, H: 0.2, Unit: 'normalized' };
  await sut['applyTaggedFaces'](
    {
      id: 'asset',
      ownerId: 'owner',
      clusterGroupId: 'cluster',
      originalPath: '/synthetic/photo.jpg',
      visibility: AssetVisibility.Timeline,
      isLocked,
      faces: [],
    },
    {
      RegionInfo: {
        AppliedToDimensions: { W: 1000, H: 500, Unit: 'pixel' },
        RegionList: [
          { Name: 'Alice', Type: 'Face', Area: area },
          { Name: 'ALICE', Type: 'Face', Area: { ...area, X: 0.8 } },
        ],
      },
    } as never,
  );
  const faces = mocks.person.refreshFaces.mock.calls[0][0];
  expect(faces).toHaveLength(2);
  expect(faces[0].personGroupId).toBe(faces[1].personGroupId);
  expect(faces[0].id).not.toBe(faces[1].id);
  expect(mocks.person.createAll).toHaveBeenCalledExactlyOnceWith([
    { name: 'Alice', ownerId: 'owner', personGroupId: faces[0].personGroupId },
  ]);
  expect(mocks.person.createGroups).toHaveBeenCalledExactlyOnceWith([
    { id: faces[0].personGroupId, clusterGroupId: 'cluster' },
  ]);
  expect(mocks.job.queueAll).toHaveBeenCalledWith(
    isLocked
      ? []
      : [{ name: JobName.PersonGenerateThumbnail, data: { ownerId: 'owner', personGroupId: faces[0].personGroupId } }],
  );
  if (isLocked) {
    expect(mocks.person.updateAll).not.toHaveBeenCalled();
  } else {
    expect(mocks.person.updateAll).toHaveBeenCalledWith([
      { personGroupId: faces[0].personGroupId, ownerId: 'owner', faceAssetId: faces[0].id },
    ]);
  }
});

it('preserves numeric-string precision and input metadata while orienting faces', () => {
  const service = Object.create(MetadataService.prototype) as MetadataService;
  const area = Object.freeze({
    X: '0.12345678901234567',
    Y: '0.76543210987654321',
    W: '0.2',
    H: '0.1',
    Unit: 'normalized',
  });
  const dimensions = Object.freeze({ W: 1000, H: 500, Unit: 'pixel' });
  const info = Object.freeze({
    AppliedToDimensions: dimensions,
    RegionList: Object.freeze([Object.freeze({ Name: 'Alice', Type: 'Face', Area: area })]),
  });
  expect(service['orientRegionInfo'](info as never, ExifOrientation.Horizontal)).toBe(info);
  const rotated = service['orientRegionInfo'](info as never, ExifOrientation.MirrorHorizontalRotate90CW);
  expect(rotated.AppliedToDimensions).toEqual({ W: 500, H: 1000, Unit: 'pixel' });
  expect(rotated.RegionList[0].Area).toEqual({
    X: 1 - Number(area.Y),
    Y: 1 - Number(area.X),
    W: 0.1,
    H: 0.2,
    Unit: 'normalized',
  });
  expect(info.RegionList[0].Area).toBe(area);
  expect(info.AppliedToDimensions).toBe(dimensions);
});
