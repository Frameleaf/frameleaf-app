import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetType, AssetVisibility, JobName, JobStatus } from 'src/enum.js';
import { ScanSplitUnavailableError } from 'src/repositories/machine-learning.repository.js';
import { ScanSplitQuotaError } from 'src/repositories/scan-split.repository.js';
import { ScanSplitService } from 'src/services/scan-split.service.js';
import { TrashReviewAction } from 'src/utils/trash-review.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const auth = authStub.admin;
const scan = {
  id: 'scan',
  ownerId: auth.user.id,
  type: AssetType.Image,
  originalPath: '/synthetic/sheet.tif',
  originalFileName: 'sheet.tif',
  fileCreatedAt: new Date('1999-05-01T10:00:00Z'),
  fileModifiedAt: new Date('2026-01-02T10:00:00Z'),
  localDateTime: new Date('1999-05-01T12:00:00Z'),
  deletedAt: null,
  isOffline: false,
  exifImageWidth: 4000,
  exifImageHeight: 3000,
  orientation: '1',
  timeZone: 'Europe/Oslo',
  make: 'Epson',
  model: 'V600',
  latitude: null,
  longitude: null,
  fileSizeInByte: 12_000_000,
};
const corners = (left: number, top: number, width = 1000, height = 800) => [
  { x: left, y: top },
  { x: left + width, y: top },
  { x: left + width, y: top + height },
  { x: left, y: top + height },
];

const setup = () => {
  let uuid = 0;
  const repository = {
    getScan: vi.fn().mockResolvedValue(scan),
    getCrops: vi.fn().mockResolvedValue([]),
    publish: vi.fn().mockResolvedValue({ locked: false }),
    removeCrops: vi.fn().mockResolvedValue(undefined),
    getSource: vi.fn().mockResolvedValue(undefined),
    isInScanAlbum: vi.fn().mockResolvedValue(false),
  };
  const access = { asset: { checkOwnerAccess: vi.fn().mockResolvedValue(new Set(['scan'])) } };
  const assets = {
    getByChecksums: vi.fn().mockResolvedValue([]),
    getLockedEncryptionItems: vi.fn().mockResolvedValue([]),
  };
  const checksums = { recordAssetChecksums: vi.fn().mockResolvedValue(undefined) };
  const crypto = {
    randomUUID: vi.fn(() => `00000000-0000-4000-8000-00000000000${++uuid}`),
    hashFileDigests: vi.fn((path: string) =>
      Promise.resolve({ sha1: Buffer.from(`sha1 ${path}`), sha256: Buffer.from(`sha256 ${path}`), sizeInBytes: 700 }),
    ),
  };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const jobs = { queue: vi.fn().mockResolvedValue(undefined), queueAll: vi.fn().mockResolvedValue(undefined) };
  const logger = { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const machineLearning = { scanSplitLocal: vi.fn() };
  const media = {
    getOrientedSize: vi.fn().mockResolvedValue({ width: 4000, height: 3000 }),
    renderDownloadJpeg: vi.fn().mockResolvedValue(undefined),
    renderScanCrop: vi.fn().mockResolvedValue({ width: 1000, height: 800 }),
    writeExif: vi.fn().mockResolvedValue(true),
  };
  const physicalFiles = { ensureOriginalPhysicalFile: vi.fn().mockResolvedValue(undefined) };
  const storage = {
    mkdirSync: vi.fn(),
    readFile: vi.fn().mockResolvedValue(Buffer.from('upright jpeg')),
    unlinkIfExists: vi.fn().mockResolvedValue(undefined),
    unlinkDir: vi.fn((folder: string) => rm(folder, { recursive: true, force: true })),
  };
  const trash = { applyReviewed: vi.fn().mockImplementation((_owner, _action, ids) => Promise.resolve(ids)) };
  const sut = new ScanSplitService(
    repository as never,
    access as never,
    assets as never,
    checksums as never,
    crypto as never,
    events as never,
    jobs as never,
    logger as never,
    machineLearning as never,
    media as never,
    physicalFiles as never,
    storage as never,
    trash as never,
  );
  return { sut, repository, access, assets, checksums, crypto, events, jobs, machineLearning, media, storage, trash };
};

describe(ScanSplitService.name, () => {
  beforeAll(() => StorageCore.setMediaLocation('/data'));

  describe('getInfo', () => {
    const crop = (assetId: string, extra: object = {}) => ({
      assetId,
      quad: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
      rotation: 90,
      createdAt: new Date('2026-11-22T10:00:00Z'),
      visibility: AssetVisibility.Archive,
      edited: false,
      trashed: false,
      ...extra,
    });

    it("lists a scan's photos with the same edited rule the split job uses, without the trashed ones", async () => {
      const { sut, repository } = setup();
      repository.getCrops.mockResolvedValue([crop('a', { edited: true }), crop('b'), crop('c', { trashed: true })]);

      const info = await sut.getInfo(auth, 'scan');

      expect(info).toMatchObject({ width: 4000, height: 3000, cropCount: 2, editedCount: 1, sourceAssetId: null });
      expect(info.crops.map(({ assetId }) => assetId)).toEqual(['a', 'b']);
      expect(info.crops[0]).toMatchObject({ rotation: 90, edited: true, createdAt: '2026-11-22T10:00:00.000Z' });
      expect(info.crops[0].quad[1]).toEqual({ x: 100, y: 0 });
    });

    it('counts a Locked photo of an unlocked scan without listing it', async () => {
      const { sut, repository } = setup();
      repository.getCrops.mockResolvedValue([crop('a'), crop('hidden', { visibility: AssetVisibility.Locked })]);

      const info = await sut.getInfo(auth, 'scan');

      expect(info.cropCount).toBe(2);
      expect(info.crops.map(({ assetId }) => assetId)).toEqual(['a']);
    });

    it('names the scan on a photo cut from it, but not a Locked scan on an unlocked photo', async () => {
      const { sut, repository } = setup();
      const source = {
        id: 'source',
        ownerId: auth.user.id,
        originalFileName: 'Scan 014.jpg',
        sourceVisibility: AssetVisibility.Archive,
        cropVisibility: AssetVisibility.Timeline,
      };
      repository.getSource.mockResolvedValue(source);
      await expect(sut.getInfo(auth, 'scan')).resolves.toMatchObject({
        sourceAssetId: 'source',
        sourceFileName: 'Scan 014.jpg',
      });

      repository.getSource.mockResolvedValue({ ...source, sourceVisibility: AssetVisibility.Locked });
      await expect(sut.getInfo(auth, 'scan')).resolves.toMatchObject({ sourceAssetId: null, sourceFileName: null });
    });

    it('refuses someone who does not own the photo', async () => {
      const { sut, access, repository } = setup();
      access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.getInfo(auth, 'scan')).rejects.toThrow(BadRequestException);
      expect(repository.getCrops).not.toHaveBeenCalled();
    });
  });

  describe('offer', () => {
    const twoPrints = {
      width: 2048,
      height: 1536,
      prints: [0, 1].map((index) => ({
        quad: [
          [index * 500, 0],
          [index * 500 + 400, 0],
          [index * 500 + 400, 400],
          [index * 500, 400],
        ],
        rotation: 0,
        confidence: 0.9,
      })),
    };

    it('never looks at a normal upload', async () => {
      const { sut, machineLearning, media, jobs } = setup();

      await expect(sut.offer(auth, 'scan')).resolves.toEqual({ printCount: 0, inScanAlbum: false });

      expect(media.renderDownloadJpeg).not.toHaveBeenCalled();
      expect(machineLearning.scanSplitLocal).not.toHaveBeenCalled();
      expect(jobs.queue).not.toHaveBeenCalled();
    });

    it('counts the prints of an upload to an album that holds scans, and does not split it', async () => {
      const { sut, repository, machineLearning, jobs } = setup();
      repository.isInScanAlbum.mockResolvedValue(true);
      machineLearning.scanSplitLocal.mockResolvedValue(twoPrints);

      await expect(sut.offer(auth, 'scan')).resolves.toEqual({ printCount: 2, inScanAlbum: true });

      expect(jobs.queue).not.toHaveBeenCalled();
      expect(repository.publish).not.toHaveBeenCalled();
    });

    it('does not offer again for a scan that was already split', async () => {
      const { sut, repository, machineLearning } = setup();
      repository.isInScanAlbum.mockResolvedValue(true);
      repository.getCrops.mockResolvedValue([{ assetId: 'a', trashed: false, edited: false }]);

      await expect(sut.offer(auth, 'scan')).resolves.toEqual({ printCount: 0, inScanAlbum: true });
      expect(machineLearning.scanSplitLocal).not.toHaveBeenCalled();
    });

    it('is simply no offer when no ML worker is available', async () => {
      const { sut, repository, machineLearning } = setup();
      repository.isInScanAlbum.mockResolvedValue(true);
      machineLearning.scanSplitLocal.mockRejectedValue(new ScanSplitUnavailableError('none'));

      await expect(sut.offer(auth, 'scan')).resolves.toEqual({ printCount: 0, inScanAlbum: true });
    });
  });

  describe('detect', () => {
    it("answers the prints in the scan's own pixels and saves nothing", async () => {
      const { sut, machineLearning, media, repository, jobs } = setup();
      // found on a 2,048-pixel copy of a 4,000-pixel scan
      machineLearning.scanSplitLocal.mockResolvedValue({
        width: 2048,
        height: 1536,
        prints: [
          {
            quad: [
              [102.4, 51.2],
              [1024, 51.2],
              [1024, 768],
              [102.4, 768],
            ],
            rotation: 0,
            confidence: 0.97,
          },
        ],
      });

      await expect(sut.detect(auth, 'scan')).resolves.toEqual({
        width: 4000,
        height: 3000,
        prints: [
          {
            quad: [
              { x: 200, y: 100 },
              { x: 2000, y: 100 },
              { x: 2000, y: 1500 },
              { x: 200, y: 1500 },
            ],
            rotation: 0,
            confidence: 0.97,
          },
        ],
      });
      expect(media.renderDownloadJpeg).toHaveBeenCalledWith(
        scan.originalPath,
        expect.stringMatching(/scan\.jpg$/),
        2048,
      );
      expect(machineLearning.scanSplitLocal).toHaveBeenCalledWith(Buffer.from('upright jpeg'));
      expect(repository.publish).not.toHaveBeenCalled();
      expect(jobs.queue).not.toHaveBeenCalled();
    });

    it('is for the owner of the scan only', async () => {
      const { sut, access, machineLearning } = setup();
      access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.detect(auth, 'scan')).rejects.toBeInstanceOf(BadRequestException);
      expect(access.asset.checkOwnerAccess.mock.calls[0].slice(0, 2)).toEqual([auth.user.id, new Set(['scan'])]);
      expect(machineLearning.scanSplitLocal).not.toHaveBeenCalled();
    });

    it('says so when no local worker can look for prints', async () => {
      const { sut, machineLearning } = setup();
      machineLearning.scanSplitLocal.mockRejectedValue(new ScanSplitUnavailableError('off'));
      await expect(sut.detect(auth, 'scan')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it.each([
      ['a video', { type: AssetType.Video }],
      ['a photo in the trash', { deletedAt: new Date() }],
      ['a photo whose file is missing', { isOffline: true }],
    ])('refuses %s', async (_name, change) => {
      const { sut, repository } = setup();
      repository.getScan.mockResolvedValue({ ...scan, ...change });
      await expect(sut.detect(auth, 'scan')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('split', () => {
    it('queues the confirmed prints for the scan', async () => {
      const { sut, jobs, access } = setup();
      await sut.split(auth, 'scan', {
        crops: [
          { quad: corners(100, 100), rotation: 0 },
          { quad: corners(2000, 100), rotation: 270 },
        ],
      });
      expect(access.asset.checkOwnerAccess).toHaveBeenCalled();
      expect(jobs.queue).toHaveBeenCalledExactlyOnceWith({
        name: JobName.ScanSplit,
        data: {
          id: 'scan',
          crops: [
            {
              quad: [
                [100, 100],
                [1100, 100],
                [1100, 900],
                [100, 900],
              ],
              rotation: 0,
            },
            {
              quad: [
                [2000, 100],
                [3000, 100],
                [3000, 900],
                [2000, 900],
              ],
              rotation: 270,
            },
          ],
        },
      });
    });

    it('is for the owner of the scan only', async () => {
      const { sut, access, jobs } = setup();
      access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.split(auth, 'scan', { crops: [{ quad: corners(0, 0), rotation: 0 }] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(jobs.queue).not.toHaveBeenCalled();
    });

    it('refuses a corner outside the scan', async () => {
      const { sut, jobs } = setup();
      await expect(sut.split(auth, 'scan', { crops: [{ quad: corners(3500, 100), rotation: 0 }] })).rejects.toThrow(
        'A corner is outside the scan',
      );
      expect(jobs.queue).not.toHaveBeenCalled();
    });

    it('reads the bounds of a scan stored on its side from the scan as it is displayed', async () => {
      const { sut, repository, jobs } = setup();
      // stored 4000x3000 and turned by its orientation: displayed 3000 wide, 4000 high
      repository.getScan.mockResolvedValue({ ...scan, orientation: '6' });
      await expect(sut.split(auth, 'scan', { crops: [{ quad: corners(2500, 100), rotation: 0 }] })).rejects.toThrow(
        'A corner is outside the scan',
      );
      await sut.split(auth, 'scan', { crops: [{ quad: corners(100, 3000), rotation: 0 }] });
      expect(jobs.queue).toHaveBeenCalledTimes(1);
    });

    it('refuses a print too small to be a photo', async () => {
      const { sut } = setup();
      await expect(
        sut.split(auth, 'scan', { crops: [{ quad: corners(100, 100, 10, 800), rotation: 0 }] }),
      ).rejects.toThrow('A print is too small to cut out');
    });

    it('refuses with the quota error when the photos would not fit', async () => {
      const { sut, jobs } = setup();
      // one print covering a twelfth of a 12 MB scan: about 1 MB
      const crops = [{ quad: corners(0, 0, 1000, 1000), rotation: 0 }];
      const user = { ...auth.user, quotaSizeInBytes: 5_000_000, quotaUsageInBytes: 4_500_000 };
      await expect(sut.split({ ...auth, user }, 'scan', { crops })).rejects.toThrow('Quota has been exceeded!');
      expect(jobs.queue).not.toHaveBeenCalled();

      await sut.split({ ...auth, user: { ...user, quotaUsageInBytes: 1_000_000 } }, 'scan', { crops });
      expect(jobs.queue).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleSplit', () => {
    const crops = [
      {
        quad: [
          [100, 100],
          [1100, 100],
          [1100, 900],
          [100, 900],
        ] as [number, number][],
        rotation: 90,
      },
    ];

    it('renders each print from the original at full size into the upload folder', async () => {
      const { sut, media, repository, checksums } = setup();
      await expect(sut.handleSplit({ id: 'scan', crops })).resolves.toBe(JobStatus.Success);

      const path = `/data/upload/${auth.user.id}/00/00/00000000-0000-4000-8000-000000000001.jpg`;
      expect(media.renderScanCrop).toHaveBeenCalledWith(
        scan.originalPath,
        path,
        { centerX: 600, centerY: 500, width: 1000, height: 800, angle: 0 },
        90,
      );
      // the scanner's make and model go into the file; the scan has no place
      expect(media.writeExif).toHaveBeenCalledWith({ make: 'Epson', model: 'V600' }, path);
      expect(repository.publish).toHaveBeenCalledWith(
        'scan',
        [
          expect.objectContaining({
            asset: expect.objectContaining({
              ownerId: auth.user.id,
              type: AssetType.Image,
              originalPath: path,
              originalFileName: 'sheet-1.jpg',
              checksum: Buffer.from(`sha256 ${path}`),
              fileCreatedAt: scan.fileCreatedAt,
              localDateTime: scan.localDateTime,
            }),
            sizeInBytes: 700,
            width: 1000,
            height: 800,
            quad: crops[0].quad,
            rotation: 90,
          }),
        ],
        'Europe/Oslo',
      );
      expect(checksums.recordAssetChecksums).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: '00000000-0000-4000-8000-000000000001', sizeInBytes: 700, path }),
      );
    });

    it('queues sealing of the files written for a Locked scan', async () => {
      const { sut, repository, assets, jobs } = setup();
      repository.publish.mockResolvedValue({ locked: true });
      const id = '00000000-0000-4000-8000-000000000001';
      assets.getLockedEncryptionItems.mockResolvedValue([{ id, ownerId: auth.user.id, pending: false }]);
      await sut.handleSplit({ id: 'scan', crops });
      expect(assets.getLockedEncryptionItems).toHaveBeenCalledWith([id]);
      expect(jobs.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedSeal, data: { id } }]);
    });

    it('replaces earlier photos that were not edited, and only those', async () => {
      const { sut, repository, trash, events } = setup();
      repository.getCrops.mockResolvedValue([
        { assetId: 'untouched', edited: false, trashed: false },
        { assetId: 'edited', edited: true, trashed: false },
        { assetId: 'in-trash', edited: false, trashed: true },
      ]);
      await sut.handleSplit({ id: 'scan', crops });
      expect(trash.applyReviewed).toHaveBeenCalledExactlyOnceWith(
        auth.user.id,
        TrashReviewAction.Trash,
        ['untouched'],
        { lockedOwnerId: auth.user.id },
        expect.any(Function),
      );
      expect(events.emit).toHaveBeenCalledWith('AssetTrashAll', { assetIds: ['untouched'], userId: auth.user.id });
      expect(repository.removeCrops).toHaveBeenCalledExactlyOnceWith(['untouched']);
    });

    it('removes what it rendered and fails when the photos do not fit in the quota', async () => {
      const { sut, repository, storage, jobs, trash } = setup();
      repository.getCrops.mockResolvedValue([{ assetId: 'untouched', edited: false, trashed: false }]);
      repository.publish.mockRejectedValue(new ScanSplitQuotaError('Quota has been exceeded!'));
      await expect(sut.handleSplit({ id: 'scan', crops })).resolves.toBe(JobStatus.Failed);
      expect(storage.unlinkIfExists).toHaveBeenCalledWith(
        `/data/upload/${auth.user.id}/00/00/00000000-0000-4000-8000-000000000001.jpg`,
      );
      expect(jobs.queue).not.toHaveBeenCalled();
      // the earlier photos stay: nothing replaced them
      expect(trash.applyReviewed).not.toHaveBeenCalled();
    });

    it('skips a scan that is gone', async () => {
      const { sut, repository, media } = setup();
      repository.getScan.mockResolvedValue(undefined);
      await expect(sut.handleSplit({ id: 'scan', crops })).resolves.toBe(JobStatus.Skipped);
      expect(media.renderScanCrop).not.toHaveBeenCalled();
    });
  });
});
