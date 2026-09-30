import { SystemMetadataKey } from 'src/enum.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { newSystemMetadataRepositoryMock } from 'test/repositories/system-metadata.repository.mock.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { serverIdentity, stableServerId } from 'src/utils/frameleaf-server-identity.js';

const asRepo = (mock: ReturnType<typeof newSystemMetadataRepositoryMock>) => mock as unknown as SystemMetadataRepository;

const configRepository = { getEnv: () => mockEnvData({ frameleafCloud: { url: 'https://api.frameleaf.cloud' } as any }) } as any;

describe('stableServerId', () => {
  it('creates and persists an id on first use', async () => {
    const systemMetadataRepository = newSystemMetadataRepositoryMock();
    systemMetadataRepository.get.mockResolvedValue(null as never);
    const id = await stableServerId({ systemMetadataRepository: asRepo(systemMetadataRepository) });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(systemMetadataRepository.set).toHaveBeenCalledWith(
      SystemMetadataKey.FrameleafServerId,
      expect.objectContaining({ id }),
    );
  });

  it('reuses the stored id without writing again', async () => {
    const systemMetadataRepository = newSystemMetadataRepositoryMock();
    systemMetadataRepository.get.mockResolvedValue({ id: 'stored-id', createdAt: '2026-01-01T00:00:00.000Z' } as never);
    await expect(stableServerId({ systemMetadataRepository: asRepo(systemMetadataRepository) })).resolves.toBe('stored-id');
    expect(systemMetadataRepository.set).not.toHaveBeenCalled();
  });
});

describe('serverIdentity', () => {
  it('returns the Frameleaf Cloud instance id, marked linked, while linked', async () => {
    const systemMetadataRepository = newSystemMetadataRepositoryMock();
    const metadata = new Map<string, unknown>([
      [SystemMetadataKey.FrameleafCloudLink, { status: 'linked', cloudUrl: 'https://api.frameleaf.cloud', instanceId: 'instance-1' }],
    ]);
    systemMetadataRepository.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
    await expect(serverIdentity({ configRepository, systemMetadataRepository: asRepo(systemMetadataRepository) })).resolves.toEqual({
      id: 'instance-1',
      linked: true,
    });
  });

  it('falls back to the stable local id while unlinked', async () => {
    const systemMetadataRepository = newSystemMetadataRepositoryMock();
    systemMetadataRepository.get.mockResolvedValue(null as never);
    await expect(serverIdentity({ configRepository, systemMetadataRepository: asRepo(systemMetadataRepository) })).resolves.toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      linked: false,
    });
  });
});
