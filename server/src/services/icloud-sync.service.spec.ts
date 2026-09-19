import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, JobName, JobStatus } from 'src/enum.js';
import { ICloudTransportError } from 'src/repositories/icloud-transport.repository.js';
import { ICloudSyncService } from 'src/services/icloud-sync.service.js';

describe(ICloudSyncService.name, () => {
  const connection = {
    id: 'connection',
    ownerId: 'owner',
    label: 'Photos',
    state: 'connected',
    config: ICloudConfigSchema.parse({}),
    encryptedSession: 'ciphertext',
    lastError: null,
    nextRunAt: null,
  };
  const resource = {
    id: 'resource',
    ownerId: 'owner',
    connectionId: 'connection',
    leaseToken: 'lease',
    status: 'pending',
    expectedSize: 4,
    source: { originalFileName: 'renamed.jpg', type: AssetType.Image, isHidden: true },
    pendingJobs: [],
  };
  const repository = {
    refreshResource: vi.fn(),
    invalidateCursor: vi.fn(),
    block: vi.fn(),
    finalize: vi.fn(),
    defer: vi.fn(),
    counts: vi.fn(),
    get: vi.fn(),
    startRun: vi.fn(),
    withSession: vi.fn(),
    checkpoint: vi.fn(),
    inventory: vi.fn(),
    savePage: vi.fn(),
    claim: vi.fn(),
    resource: vi.fn(),
    finish: vi.fn(),
    clearOutbox: vi.fn(),
    hasPending: vi.fn(),
    completeRun: vi.fn(),
    update: vi.fn(),
    admitAuth: vi.fn(),
  };
  const transport = { decodeSession: vi.fn(), encodeSession: vi.fn(), authenticate: vi.fn() };
  const staging = { download: vi.fn(), cleanup: vi.fn() };
  const recovery = { verifyMapped: vi.fn(), reconcile: vi.fn() };
  const jobs = { queue: vi.fn() };
  const albums = { reconcile: vi.fn() };
  let sut: ICloudSyncService;
  beforeEach(() => {
    vi.clearAllMocks();
    repository.get.mockResolvedValue(connection);
    repository.withSession.mockImplementation(async (_id, _owner, callback) => {
      const result = await callback(connection);
      return result.value;
    });
    repository.checkpoint.mockResolvedValue({ complete: true });
    repository.inventory.mockResolvedValue({ libraries: [], albums: [] });
    repository.claim.mockResolvedValueOnce(resource).mockResolvedValue(undefined);
    repository.resource.mockResolvedValue({
      ...resource,
      status: 'committed',
      pendingJobs: [{ name: JobName.AssetGenerateThumbnails, data: { id: 'same-asset' } }],
    });
    repository.hasPending.mockResolvedValue(false);
    staging.download.mockResolvedValue('/private/complete');
    recovery.verifyMapped.mockResolvedValue(undefined);
    recovery.reconcile.mockResolvedValue({ outcome: 'repaired-missing', assetId: 'same-asset' });
    jobs.queue.mockResolvedValue(undefined);
    albums.reconcile.mockResolvedValue(true);
    repository.finalize.mockImplementation(async (_resource, cleanup) => {
      await cleanup();
      return true;
    });
    sut = new ICloudSyncService(
      repository as never,
      transport as never,
      staging as never,
      recovery as never,
      jobs as never,
      {} as never,
      albums as never,
      albums as never,
      {} as never,
      albums as never,
    );
  });

  it('recovers a damaged unchanged mapping, forwards hidden visibility and only cleans after durable outbox dispatch', async () => {
    expect(await sut.handleSync({ id: 'connection' })).toBe(JobStatus.Success);
    expect(recovery.verifyMapped).toHaveBeenCalledOnce();
    expect(staging.download).toHaveBeenCalledOnce();
    expect(recovery.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'resource',
        stagedPath: '/private/complete',
        sourceHidden: true,
        originalFileName: 'renamed.jpg',
      }),
    );
    expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.AssetGenerateThumbnails, data: { id: 'same-asset' } });
    expect(staging.cleanup.mock.invocationCallOrder[0]).toBeGreaterThan(
      repository.clearOutbox.mock.invocationCallOrder[0],
    );
    expect(repository.finalize).toHaveBeenCalledWith(resource, expect.any(Function));
  });

  it('avoids transfer only after verified reuse and preserves intentionally trashed mappings', async () => {
    recovery.verifyMapped.mockResolvedValue({ outcome: 'reused', assetId: 'same-asset' });
    await sut.handleSync({ id: 'connection' });
    expect(staging.download).not.toHaveBeenCalled();
    expect(recovery.reconcile).not.toHaveBeenCalled();
    expect(staging.cleanup).toHaveBeenCalledTimes(1);
    expect(repository.finalize).toHaveBeenCalledWith(resource, expect.any(Function));
    staging.cleanup.mockClear();
    repository.claim.mockResolvedValueOnce(resource);
    recovery.verifyMapped.mockResolvedValue({ outcome: 'preserve-trashed', reason: 'destination_not_active' });
    await sut.handleSync({ id: 'connection' });
    expect(repository.finish).toHaveBeenLastCalledWith(resource, 'preserve-trashed', 'destination_not_active');
    expect(staging.cleanup).not.toHaveBeenCalled();
  });

  it('retains committed state and good staging when follow-up dispatch fails', async () => {
    jobs.queue.mockRejectedValueOnce(new Error('queue unavailable'));
    await sut.handleSync({ id: 'connection' });
    expect(staging.cleanup).not.toHaveBeenCalled();
    expect(repository.clearOutbox).not.toHaveBeenCalled();
    expect(repository.finish).toHaveBeenCalledWith(resource, 'committed', 'icloud_transfer_failed');
  });

  it('rejects cross-owner and insecure credential submission before calling Apple, and redacts provider errors', async () => {
    const auth = { user: { id: 'owner' }, session: {} } as never;
    const dto = { action: 'login', appleId: 'user@example.test', password: 'private-password' } as const;
    await expect(sut.authenticate(auth, 'connection', dto, false)).rejects.toThrow('icloud_requires_https');
    expect(transport.authenticate).not.toHaveBeenCalled();
    repository.get.mockResolvedValueOnce(undefined);
    await expect(sut.authenticate(auth, 'other-connection', dto, true)).rejects.toThrow();
    expect(transport.authenticate).not.toHaveBeenCalled();
    repository.admitAuth.mockResolvedValue(true);
    transport.authenticate.mockRejectedValue(new ICloudTransportError('reauthentication_required'));
    repository.counts = vi.fn().mockResolvedValue({});
    await sut.authenticate(auth, 'connection', dto, true);
    expect(repository.block).toHaveBeenCalledWith(
      'connection',
      'owner',
      'reauthentication-required',
      'reauthentication_required',
    );
  });
  it('refreshes changed resources without consuming the invalid cursor reset budget', async () => {
    staging.download.mockRejectedValueOnce(new ICloudTransportError('resource_changed'));
    repository.resource.mockResolvedValueOnce(resource);
    await sut.handleSync({ id: 'connection' });
    expect(repository.finish).toHaveBeenCalledWith(resource, 'retry', 'resource_changed');
    expect(repository.refreshResource).toHaveBeenCalledWith(resource);
    expect(repository.invalidateCursor).not.toHaveBeenCalled();
    expect(repository.block).not.toHaveBeenCalled();
  });
  it('uses the bounded cursor recovery path only for an invalid change token', async () => {
    repository.withSession.mockRejectedValueOnce(new ICloudTransportError('invalid_change_token'));
    expect(await sut.handleSync({ id: 'connection' })).toBe(JobStatus.Failed);
    expect(repository.invalidateCursor).toHaveBeenCalledWith('connection', 'owner');
    expect(repository.refreshResource).not.toHaveBeenCalled();
  });
});
