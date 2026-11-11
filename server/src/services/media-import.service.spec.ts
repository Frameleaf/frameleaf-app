import { randomUUID } from 'node:crypto';
import { JobStatus } from 'src/enum.js';
import {
  type MediaDownloadInspection,
  MediaDownloaderRepository,
} from 'src/repositories/media-downloader.repository.js';
import { type MediaImport, MediaImportRepository } from 'src/repositories/media-import.repository.js';
import { MediaImportService } from 'src/services/media-import.service.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { automock } from 'test/utils.js';

const entry = {
  provider: 'fixture',
  creatorId: 'creator',
  postId: 'post',
  attachmentId: 'image',
  pageUrl: 'https://example.org/post',
  mediaUrl: 'https://cdn.example.org/file?secret=private',
  title: 'Post',
  description: 'Text',
  creator: 'Creator',
  publishedAt: null,
  kind: 'image' as const,
};
const inspection: MediaDownloadInspection = {
  kind: 'item',
  provider: 'fixture',
  creatorId: 'creator',
  creator: 'Creator',
  canonicalUrl: entry.pageUrl,
  title: 'Post',
  complete: true,
  checkpoint: null,
  limitation: null,
  entries: [entry],
};

it('limits combined previews and never starts an implicit feed download', async () => {
  const repository = automock(MediaImportRepository, { args: [{}, {}] });
  const downloader = automock(MediaDownloaderRepository);
  const service = new MediaImportService(
    repository,
    downloader,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const row = {
    id: randomUUID(),
    ownerId: authStub.user1.user.id,
    state: 'inspecting',
    generation: 1,
    subscriptionGeneration: null,
    connectionId: null,
    subscriptionId: null,
    urls: [entry.pageUrl, 'https://example.org/feed'],
    availableAt: new Date(0),
  } as MediaImport;
  const authority = {
    ownerId: row.ownerId,
    importId: row.id,
    generation: 1,
    subscriptionGeneration: null,
    jobId: randomUUID(),
    jobToken: randomUUID(),
  };
  repository.getWorker.mockResolvedValue(row);
  repository.authority.mockReturnValue(authority);
  repository.assertAuthority.mockResolvedValue({ row, user: UserFactory.create({ id: row.ownerId }) });
  repository.withCapacity.mockImplementation(async (_row, _provider, action) => action());
  repository.discovered.mockResolvedValue(undefined);
  downloader.inspect.mockResolvedValueOnce(inspection).mockResolvedValueOnce({
    ...inspection,
    kind: 'feed',
    entries: Array.from({ length: 500 }, (_, index) => ({ ...entry, attachmentId: String(index) })),
  });
  expect(await service.handleImport({ id: row.id })).toBe(JobStatus.Success);
  const preview = repository.discovered.mock.calls[0][1];
  expect(preview).toMatchObject({
    kind: 'feed',
    complete: false,
    creatorId: null,
    limitation: 'Preview is limited to 500 attachments',
  });
  expect(preview.entries).toHaveLength(500);
  expect(downloader.download).not.toHaveBeenCalled();
});

it('returns source provenance without private media URLs', async () => {
  const repository = automock(MediaImportRepository, { args: [{}, {}] });
  const service = new MediaImportService(
    repository,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const row = {
    id: randomUUID(),
    ownerId: authStub.user1.user.id,
    state: 'ready',
    albumId: null,
    subscriptionId: null,
    connectionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    error: null,
    inspection,
  } as unknown as MediaImport;
  repository.actor.mockResolvedValue(undefined);
  repository.get.mockResolvedValue(row);
  repository.items.mockResolvedValue([
    { id: randomUUID(), entry, state: 'discovered', assetId: null, error: null, bytes: 0 } as never,
  ]);
  const response = await service.get(authStub.user1, row.id);
  expect(response.items[0].pageUrl).toBe(entry.pageUrl);
  expect(JSON.stringify(response)).not.toContain('secret=private');
  expect(response.items[0]).not.toHaveProperty('mediaUrl');
});

it('stops a running extractor when its durable authority is revoked', async () => {
  vi.useFakeTimers();
  try {
    const repository = automock(MediaImportRepository, { args: [{}, {}] });
    const downloader = automock(MediaDownloaderRepository);
    const service = new MediaImportService(
      repository,
      downloader,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const row = {
      id: randomUUID(),
      ownerId: authStub.user1.user.id,
      state: 'inspecting',
      generation: 1,
      subscriptionGeneration: null,
      connectionId: null,
      subscriptionId: null,
      urls: [entry.pageUrl],
      availableAt: new Date(0),
    } as MediaImport;
    const authority = {
      ownerId: row.ownerId,
      importId: row.id,
      generation: 1,
      subscriptionGeneration: null,
      jobId: randomUUID(),
      jobToken: randomUUID(),
    };
    repository.getWorker.mockResolvedValue(row);
    repository.authority.mockReturnValue(authority);
    const active = { row, user: UserFactory.create({ id: row.ownerId }) };
    repository.assertAuthority
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(active)
      .mockRejectedValue(new Error('authority revoked'));
    repository.withCapacity.mockImplementation(async (_row, _provider, action) => action());
    repository.failAttempt.mockResolvedValue(undefined);
    const started = Promise.withResolvers<AbortSignal>();
    downloader.inspect.mockImplementation(async (_url, options) => {
      started.resolve(options!.signal!);
      return new Promise((_, reject) =>
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }),
      );
    });
    const result = service.handleImport({ id: row.id });
    const signal = await started.promise;
    await vi.advanceTimersByTimeAsync(5000);
    expect(signal.aborted).toBe(true);
    expect(await result).toBe(JobStatus.Failed);
    expect(repository.failAttempt).toHaveBeenCalledWith(authority, expect.any(String), 'paused', false);
  } finally {
    vi.useRealTimers();
  }
});
