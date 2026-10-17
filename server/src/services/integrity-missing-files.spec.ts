import { createHash } from 'node:crypto';
import { IntegrityReport, JobStatus } from 'src/enum.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { newTestService } from 'test/utils.js';

const items = [
  { path: '/synthetic/present', reportId: 'outdated', assetId: 'asset-a', fileAssetId: null },
  { path: '/synthetic/unavailable', reportId: null, assetId: 'asset-b', fileAssetId: null },
];

it.each(['EACCES', 'EIO', 'ELOOP', 'ENOTDIR'])(
  'does not turn %s into missing reports or successful progress',
  async (code) => {
    const { sut, mocks } = newTestService(IntegrityService);
    const failure = Object.assign(new Error('stat failed'), { code });
    mocks.storage.stat.mockResolvedValueOnce({} as never).mockRejectedValueOnce(failure);
    await expect(sut.handleMissingFiles({ runId: 'run', items })).rejects.toBe(failure);
    expect(mocks.integrityReport.deleteByIds).not.toHaveBeenCalled();
    expect(mocks.integrityReport.create).not.toHaveBeenCalled();
    expect(mocks.systemMetadata.updateIntegrityRun).not.toHaveBeenCalled();
  },
);

it('retains missing-file report behavior for ENOENT and removes resolved reports', async () => {
  const { sut, mocks } = newTestService(IntegrityService);
  mocks.storage.stat
    .mockResolvedValueOnce({} as never)
    .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await expect(sut.handleMissingFiles({ items })).resolves.toBe(JobStatus.Success);
  expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['outdated']);
  expect(mocks.integrityReport.create).toHaveBeenCalledWith([
    { type: IntegrityReport.MissingFile, path: items[1].path, assetId: 'asset-b', fileAssetId: null },
  ]);
});

it.each(['handleMissingRefresh', 'handleUntrackedRefresh'] as const)(
  'retains reports when %s cannot inspect a path',
  async (handler) => {
    const { sut, mocks } = newTestService(IntegrityService);
    const failure = Object.assign(new Error('read denied'), { code: 'EACCES' });
    mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);
    mocks.storage.stat.mockRejectedValue(failure);
    await expect(sut[handler]({ items: [{ path: '/synthetic/unreadable', reportId: 'report' }] })).rejects.toBe(
      failure,
    );
    expect(mocks.integrityReport.deleteByIds).not.toHaveBeenCalled();
  },
);

it('does not compare a partial checksum after a read failure', async () => {
  const { sut, mocks } = newTestService(IntegrityService);
  const failure = Object.assign(new Error('read failed'), { code: 'EIO' });
  mocks.storage.createPlainReadStream.mockImplementation(() => {
    throw failure;
  });
  const checksum = createHash('sha1').digest('hex');
  await expect(
    sut.handleChecksumRefresh({
      items: [{ path: '/synthetic/unreadable', reportId: 'report', checksum, checksumAlgorithm: 'sha1' }],
    }),
  ).rejects.toBe(failure);
  expect(mocks.integrityReport.deleteByIds).not.toHaveBeenCalled();
});

it.each(['handleMissingRefresh', 'handleUntrackedRefresh'] as const)(
  'preserves present and absent path behavior in %s',
  async (handler) => {
    const { sut, mocks } = newTestService(IntegrityService);
    mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);
    mocks.storage.stat
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(
      sut[handler]({
        items: [
          { path: '/synthetic/present', reportId: 'present' },
          { path: '/synthetic/missing', reportId: 'missing' },
        ],
      }),
    ).resolves.toBe(JobStatus.Success);
    expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith([
      handler === 'handleMissingRefresh' ? 'present' : 'missing',
    ]);
  },
);

it('removes a checksum report whose path no longer exists', async () => {
  const { sut, mocks } = newTestService(IntegrityService);
  mocks.storage.createPlainReadStream.mockImplementation(() => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  await expect(
    sut.handleChecksumRefresh({
      items: [
        {
          path: '/synthetic/missing',
          reportId: 'missing',
          checksum: '00',
          checksumAlgorithm: 'sha1',
        },
      ],
    }),
  ).resolves.toBe(JobStatus.Success);
  expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['missing']);
});
