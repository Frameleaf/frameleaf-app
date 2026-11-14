import { readFileSync } from 'node:fs';
import { AssetFileType, AssetType, AssetVisibility, JobName, JobStatus, UserMetadataKey } from 'src/enum.js';
import { DevelopImportService } from 'src/services/develop-import.service.js';

const sample = readFileSync('test/fixtures/develop-import/lightroom-exposure.xmp');
const setup = () => {
  const createImportedVersion = vi.fn();
  const assets = {
    getById: vi.fn().mockResolvedValue({
      id: 'asset',
      ownerId: 'owner',
      checksum: Buffer.from('source'),
      type: AssetType.Image,
      visibility: AssetVisibility.Timeline,
      files: [{ type: AssetFileType.Sidecar, isEdited: false, path: '/test/photo.xmp' }],
    }),
  };
  const users = { getMetadata: vi.fn().mockResolvedValue([]) };
  const storage = {
    stat: vi.fn().mockResolvedValue({ size: sample.length }),
    readFile: vi.fn().mockResolvedValue(sample),
  };
  const jobs = { queue: vi.fn() };
  const service = new DevelopImportService(
    { createImportedVersion } as never,
    assets as never,
    users as never,
    storage as never,
    jobs as never,
  );
  return { service, createImportedVersion, assets, users, storage, jobs };
};
describe(DevelopImportService.name, () => {
  it('queues a private import after metadata extraction', async () => {
    const { service, jobs } = setup();
    await service.queueImport({ assetId: 'asset', userId: 'owner' });
    expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.DevelopImport, data: { id: 'asset' } });
  });
  it('does not read the sidecar or create a version while switched off', async () => {
    const { service, users, storage, createImportedVersion } = setup();
    users.getMetadata.mockResolvedValue([
      { key: UserMetadataKey.Preferences, value: { develop: { importXmpEdits: false } } },
    ] as never);
    expect(await service.handleImport({ id: 'asset' })).toBe(JobStatus.Skipped);
    expect(storage.readFile).not.toHaveBeenCalled();
    expect(createImportedVersion).not.toHaveBeenCalled();
  });
  it('ignores XML formatting changes in the import identity', async () => {
    const { service, storage, createImportedVersion } = setup();
    await service.handleImport({ id: 'asset' });
    storage.readFile.mockResolvedValue(Buffer.from(sample.toString().replaceAll('><', '>\n  <')));
    await service.handleImport({ id: 'asset' });
    expect(createImportedVersion.mock.calls[0][2]).toBe(createImportedVersion.mock.calls[1][2]);
  });
  it('changes the identity when sidecar settings change', async () => {
    const { service, storage, createImportedVersion } = setup();
    await service.handleImport({ id: 'asset' });
    storage.readFile.mockResolvedValue(Buffer.from(sample.toString().replace('1.25', '1.50')));
    await service.handleImport({ id: 'asset' });
    expect(createImportedVersion.mock.calls[0][2]).not.toBe(createImportedVersion.mock.calls[1][2]);
  });
  it('prefers darktable controls while preserving both source envelopes', async () => {
    const { service, storage, createImportedVersion } = setup();
    const xml = readFileSync('test/fixtures/develop-import/darktable-native-canon.xmp', 'utf8').replace(
      '<rdf:Description',
      '<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="3"',
    );
    storage.readFile.mockResolvedValue(Buffer.from(xml));
    await service.handleImport({ id: 'asset' });
    expect(createImportedVersion).toHaveBeenCalledWith(
      'asset',
      expect.objectContaining({
        exposure: 0,
        imported: expect.objectContaining({
          lightroom: expect.objectContaining({ Exposure2012: '3' }),
          darktable: expect.any(Object),
        }),
      }),
      expect.any(String),
      'darktable',
    );
  });
  it('passes a stable digest and preserved settings to the inactive version writer', async () => {
    const { service, createImportedVersion } = setup();
    await service.handleImport({ id: 'asset' });
    await service.handleImport({ id: 'asset' });
    expect(createImportedVersion.mock.calls[0]).toEqual(createImportedVersion.mock.calls[1]);
    expect(createImportedVersion).toHaveBeenCalledWith(
      'asset',
      expect.objectContaining({
        imported: expect.objectContaining({
          lightroom: expect.objectContaining({ Exposure2012: '1.25', Contrast2012: '15' }),
        }),
      }),
      expect.stringMatching(/^[0-9a-f]{64}$/),
      'Lightroom',
    );
  });
});
