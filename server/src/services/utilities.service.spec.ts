import { UtilitiesService } from 'src/services/utilities.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(UtilitiesService.name, () => {
  let sut: UtilitiesService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(UtilitiesService));
    mocks.duplicateRepository.countGroupsForOwner.mockResolvedValue(12);
    mocks.map.getMapStatistics.mockResolvedValue({ archived: 0, partner: 0, unlocated: 214 });
    mocks.integrityReport.getFindingsOverview.mockResolvedValue({ missing: 3, damaged: 1, stray: 0, rawToMatch: 0 });
    mocks.physicalFileTrash.list.mockResolvedValue({ items: [], total: 86, totalBytes: 410_000_000 });
  });

  it("counts a member's own tools and leaves the server-wide checks out (FL-519)", async () => {
    const auth = AuthFactory.create({ isAdmin: false });

    await expect(sut.getSummary(auth)).resolves.toEqual({
      duplicateGroups: 12,
      withoutPlace: 214,
      missingFiles: null,
      damagedFiles: null,
      unusedFiles: null,
      unusedBytes: null,
    });
    expect(mocks.integrityReport.getFindingsOverview).not.toHaveBeenCalled();
    expect(mocks.physicalFileTrash.list).not.toHaveBeenCalled();
  });

  it('adds missing, damaged and unused files for an administrator', async () => {
    const auth = AuthFactory.create({ isAdmin: true });

    await expect(sut.getSummary(auth)).resolves.toEqual({
      duplicateGroups: 12,
      withoutPlace: 214,
      missingFiles: 3,
      damagedFiles: 1,
      unusedFiles: 86,
      unusedBytes: 410_000_000,
    });
    expect(mocks.physicalFileTrash.list).toHaveBeenCalledWith({ skip: 0, take: 0, lockedOwnerId: auth.user.id });
  });
});
