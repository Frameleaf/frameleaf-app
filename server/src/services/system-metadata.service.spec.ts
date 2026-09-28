import { SystemMetadataKey } from 'src/enum.js';
import { SystemMetadataService } from 'src/services/system-metadata.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(SystemMetadataService.name, () => {
  let sut: SystemMetadataService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SystemMetadataService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getAdminOnboarding', () => {
    it('should report Frameleaf setup completion', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ completed: true });
      await expect(sut.getAdminOnboarding()).resolves.toEqual({ isOnboarded: true });
      expect(mocks.systemMetadata.get).toHaveBeenCalledWith(SystemMetadataKey.FrameleafSetup);
    });

    it('should default isOnboarded to false', async () => {
      await expect(sut.getAdminOnboarding()).resolves.toEqual({ isOnboarded: false });
    });
  });

  describe('updateAdminOnboarding', () => {
    it('should mark setup complete', async () => {
      await expect(sut.updateAdminOnboarding({ isOnboarded: true })).resolves.toBeUndefined();
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.AdminOnboarding, { isOnboarded: true });
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
        SystemMetadataKey.FrameleafSetup,
        expect.objectContaining({ completed: true, completedAt: expect.any(String) }),
      );
    });

    it('should reopen setup', async () => {
      await expect(sut.updateAdminOnboarding({ isOnboarded: false })).resolves.toBeUndefined();
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.AdminOnboarding, { isOnboarded: false });
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
        SystemMetadataKey.FrameleafSetup,
        expect.objectContaining({ completed: false, completedAt: null }),
      );
    });
  });

  describe('Frameleaf setup (FL-176)', () => {
    const progress = {
      version: 1,
      step: 'library',
      reached: 3,
      choices: { signIn: 'local' as const, accountCreated: true, adminName: 'Ada', nightlyBackup: true },
    };

    it('reports an existing library when no flow was saved and the server has more than a new admin', async () => {
      mocks.user.getUserStats.mockResolvedValue([
        { userId: 'u1', photos: 0, videos: 0, usage: 0 },
        { userId: 'u2', photos: 3, videos: 0, usage: 10 },
      ] as never);
      await expect(sut.getFrameleafSetup()).resolves.toEqual({
        completed: false,
        completedAt: null,
        flow: 'existing',
        progress: null,
      });
    });

    it('reads a server with one account and nothing uploaded as a new server when no flow was saved', async () => {
      mocks.user.getUserStats.mockResolvedValue([{ userId: 'u1', photos: 0, videos: 0, usage: 0 }] as never);
      await expect(sut.getFrameleafSetup()).resolves.toMatchObject({ flow: 'new' });
      await expect(sut.updateFrameleafSetup({ progress })).resolves.toMatchObject({ flow: 'new' });
    });

    it('reads a single account that already has photos as an existing library', async () => {
      mocks.user.getUserStats.mockResolvedValue([{ userId: 'u1', photos: 40, videos: 2, usage: 99 }] as never);
      await expect(sut.getFrameleafSetup()).resolves.toMatchObject({ flow: 'existing' });
    });

    it('saves progress and fixes the flow on the first save', async () => {
      await expect(sut.updateFrameleafSetup({ flow: 'new', progress })).resolves.toEqual({
        completed: false,
        completedAt: null,
        flow: 'new',
        progress,
      });
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
        SystemMetadataKey.FrameleafSetup,
        expect.objectContaining({ flow: 'new', progress, completed: false }),
      );
    });

    it('never changes a saved flow', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ flow: 'existing', completed: false });
      await expect(sut.updateFrameleafSetup({ flow: 'new', progress })).resolves.toMatchObject({ flow: 'existing' });
    });

    it('drops a stored payload that no longer validates', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        flow: 'new',
        progress: { version: 1, step: 'x', password: 'secret' },
      });
      await expect(sut.getFrameleafSetup()).resolves.toMatchObject({ progress: null });
    });

    it('refuses to finish without an admin', async () => {
      mocks.user.hasAdmin.mockResolvedValue(false);
      await expect(sut.finishFrameleafSetup()).rejects.toThrow('Create the admin account');
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('refuses to finish when storage is not writable', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);
      mocks.storage.checkFileExists.mockResolvedValue(false);
      mocks.storage.checkDiskUsage.mockResolvedValue({ available: 0, free: 0, total: 0 });
      await expect(sut.finishFrameleafSetup()).rejects.toThrow("can't write");
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('finishes setup and marks the server onboarded', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.storage.checkDiskUsage.mockResolvedValue({ available: 5e11, free: 5e11, total: 1e12 });
      mocks.systemMetadata.get.mockResolvedValue({ flow: 'new', progress });
      await expect(sut.finishFrameleafSetup()).resolves.toMatchObject({ completed: true, flow: 'new' });
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.AdminOnboarding, { isOnboarded: true });
    });

    it('reports storage space', async () => {
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.storage.checkDiskUsage.mockResolvedValue({ available: 4e11, free: 5e11, total: 1e12 });
      await expect(sut.getFrameleafSetupStorage()).resolves.toMatchObject({
        writable: true,
        freeBytes: 4e11,
        totalBytes: 1e12,
      });
    });

    it('totals the library across accounts', async () => {
      mocks.user.getUserStats.mockResolvedValue([
        { userId: 'u1', photos: 10, videos: 2, usage: 1000 },
        { userId: 'u2', photos: 5, videos: 0, usage: 500 },
      ] as never);
      mocks.person.getNumberOfPeople.mockResolvedValue({ total: 3, hidden: 0 });
      mocks.album.getAll.mockResolvedValue([{}, {}] as never);
      await expect(sut.getFrameleafSetupLibrary()).resolves.toEqual({
        items: 17,
        people: 6,
        albums: 4,
        bytes: 1500,
        users: 2,
      });
    });
  });

  describe('getReverseGeocodingState', () => {
    it('should get reverse geocoding state', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ lastUpdate: '2024-01-01', lastImportFileName: 'foo.bar' });
      await expect(sut.getReverseGeocodingState()).resolves.toEqual({
        lastUpdate: '2024-01-01',
        lastImportFileName: 'foo.bar',
      });
    });

    it('should default reverse geocoding state to null', async () => {
      await expect(sut.getReverseGeocodingState()).resolves.toEqual({
        lastUpdate: null,
        lastImportFileName: null,
      });
    });
  });
});
