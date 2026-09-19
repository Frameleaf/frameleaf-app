import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { ICloudConnection, ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';

describe(ICloudStagingService.name, () => {
  let directory: string;
  let root: string;
  let resource: ICloudResource;
  let connection: ICloudConnection;
  let sut: ICloudStagingService;
  const repository = { progress: vi.fn(), get: vi.fn(), withSession: vi.fn() };
  const transport = { download: vi.fn(), decodeSession: vi.fn(), encodeSession: vi.fn() };
  const libraries = { getAll: vi.fn() };
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await realpath(await mkdtemp(join(tmpdir(), 'icloud-stage-')));
    root = join(directory, 'private-stage');
    vi.stubEnv('IMMICH_ICLOUD_STAGING_PATH', root);
    vi.stubEnv('IMMICH_ICLOUD_FREE_SPACE_BYTES', '0');
    StorageCore.setMediaLocation(join(directory, 'managed'));
    connection = {
      id: randomUUID(),
      ownerId: randomUUID(),
      label: 'test',
      state: 'connected',
      encryptedSession: 'encrypted',
      config: ICloudConfigSchema.parse({}),
      lastError: null,
      nextRunAt: null,
    };
    resource = {
      id: randomUUID(),
      leaseToken: randomUUID(),
      connectionId: connection.id,
      ownerId: connection.ownerId,
      expectedSize: 4,
      library: { area: 'private', zoneID: { zoneName: 'PrimarySync' } },
      fingerprint: 'opaque',
      recordId: 'master',
      resourceKey: 'resOriginalRes',
      stagingPath: null,
    } as ICloudResource;
    repository.progress.mockResolvedValue(true);
    repository.get.mockResolvedValue(connection);
    repository.withSession.mockImplementation(async (_id, _owner, callback) => {
      const result = await callback(connection);
      return result.value;
    });
    libraries.getAll.mockResolvedValue([]);
    transport.download.mockImplementation(() =>
      Promise.resolve({
        stream: Readable.from([Buffer.from('data')]),
        session: { version: 1 },
        fingerprint: 'opaque',
        size: 4,
      }),
    );
    sut = new ICloudStagingService(repository as never, transport as never, libraries as never);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('streams exact bytes, publishes complete only, reuses a crash marker and retains until cleanup', async () => {
    const path = await sut.download(connection, resource);
    expect(await readFile(path, 'utf8')).toBe('data');
    expect(repository.progress).toHaveBeenCalledWith(resource, { status: 'staging', stagingPath: path });
    resource.stagingPath = path;
    expect(await sut.download(connection, resource)).toBe(path);
    expect(transport.download).toHaveBeenCalledTimes(1);
    await sut.cleanup(resource);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects public staging permissions, exhausted disk and a revoked lease before transfer', async () => {
    await sut.root();
    await chmod(root, 0o755);
    await expect(sut.download(connection, resource)).rejects.toThrow('staging_permissions_invalid');
    await chmod(root, 0o700);
    vi.stubEnv('IMMICH_ICLOUD_FREE_SPACE_BYTES', '9223372036854775807');
    await expect(sut.download(connection, resource)).rejects.toThrow('staging_disk_full');
    vi.stubEnv('IMMICH_ICLOUD_FREE_SPACE_BYTES', '0');
    repository.progress.mockResolvedValueOnce(false);
    await expect(sut.download(connection, resource)).rejects.toThrow('lease_changed');
    expect(transport.download).not.toHaveBeenCalled();
    await expect(readFile(join(root, resource.id, 'complete'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects truncated and oversized transfers without a complete marker', async () => {
    transport.download.mockResolvedValueOnce({
      stream: Readable.from([Buffer.from('dat')]),
      session: {},
      fingerprint: 'opaque',
      size: 4,
    });
    await expect(sut.download(connection, resource)).rejects.toThrow('source_size_mismatch');
    await expect(readFile(join(root, resource.id, 'complete'))).rejects.toMatchObject({ code: 'ENOENT' });
    transport.download.mockResolvedValueOnce({
      stream: Readable.from([Buffer.from('excess')]),
      session: {},
      fingerprint: 'opaque',
      size: 4,
    });
    await expect(sut.download(connection, resource)).rejects.toThrow('source_size_mismatch');
  });

  it('rejects scanned roots, aliases, malicious resource-directory symlinks and changed fingerprints', async () => {
    libraries.getAll.mockResolvedValue([{ importPaths: [directory] }]);
    await expect(sut.root()).rejects.toThrow('staging_overlaps_library');
    libraries.getAll.mockResolvedValue([]);
    await sut.root();
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'complete'), 'safe');
    await symlink(outside, join(root, resource.id));
    await expect(sut.download(connection, resource)).rejects.toThrow('staging_symlink');
    expect(await readFile(join(outside, 'complete'), 'utf8')).toBe('safe');
    resource.id = randomUUID();
    transport.download.mockResolvedValueOnce({
      stream: Readable.from([Buffer.from('data')]),
      session: {},
      fingerprint: 'changed',
      size: 4,
    });
    await expect(sut.download(connection, resource)).rejects.toThrow('source_identity_changed');
  });
});
