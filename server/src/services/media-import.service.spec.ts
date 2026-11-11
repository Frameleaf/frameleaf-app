import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  MediaCreatorItemsQueryDto,
  MediaImportCreateDto,
  MediaSubscriptionCreateDto,
  MediaSubscriptionUpdateDto,
  MediaWatchUpdateDto,
} from 'src/dtos/media-import.dto.js';
import { AssetType, JobStatus, Permission } from 'src/enum.js';
import {
  type MediaDownloadInspection,
  MediaDownloaderRepository,
} from 'src/repositories/media-downloader.repository.js';
import {
  type MediaCreatorItem,
  type MediaImport,
  MediaImportRepository,
  type MediaSubscription,
} from 'src/repositories/media-import.repository.js';
import { MediaImportService } from 'src/services/media-import.service.js';
import { mediaSourceKey } from 'src/utils/media-import.js';
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

it('lists imports with one item query for the whole page', async () => {
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
  const rows = [randomUUID(), randomUUID()].map(
    (id) =>
      ({
        id,
        ownerId: authStub.user1.user.id,
        state: 'ready',
        albumId: null,
        subscriptionId: null,
        connectionId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        error: null,
        inspection,
      }) as unknown as MediaImport,
  );
  const item = (state: string) => ({ id: randomUUID(), entry, state, assetId: null, error: null, bytes: 0 }) as never;
  repository.actor.mockResolvedValue(undefined);
  repository.list.mockResolvedValue(rows);
  repository.itemsByImport.mockResolvedValue(new Map([[rows[0].id, [item('saved'), item('failed')]]]));
  const { imports } = await service.list(authStub.user1);
  expect(repository.itemsByImport).toHaveBeenCalledExactlyOnceWith(rows.map((row) => row.id));
  expect(repository.items).not.toHaveBeenCalled();
  expect(imports.map(({ id, discovered, saved, failed }) => ({ id, discovered, saved, failed }))).toEqual([
    { id: rows[0].id, discovered: 2, saved: 1, failed: 1 },
    { id: rows[1].id, discovered: 0, saved: 0, failed: 0 },
  ]);
  expect(imports[0].items).toHaveLength(2);
});

let media: string;
beforeAll(async () => {
  media = await mkdtemp(join(tmpdir(), 'media-import-spec-'));
  StorageCore.setMediaLocation(media);
});
afterAll(() => rm(media, { recursive: true, force: true }));

const subscriptionRow = (values: Partial<MediaSubscription> = {}) =>
  ({
    id: randomUUID(),
    ownerId: authStub.user1.user.id,
    provider: 'fixture',
    creatorId: 'creator',
    creator: 'Creator',
    url: 'https://example.org/creator',
    extractionUrl: null,
    albumId: randomUUID(),
    connectionId: null,
    mediaCreatorId: randomUUID(),
    history: { mode: 'recent', count: 30 },
    saves: { shorts: false },
    quality: '720',
    intervalMinutes: 60,
    status: 'active',
    checkpoint: 'older-page',
    historyComplete: false,
    lastSuccessAt: null,
    lastReconcileAt: null,
    nextCheckAt: new Date(),
    createdAt: new Date(),
    limitation: null,
    error: null,
    ...values,
  }) as MediaSubscription;

describe('subscription options', () => {
  const run = async (subscription: MediaSubscription, enumerated: Partial<MediaDownloadInspection>) => {
    const repository = automock(MediaImportRepository, { args: [{}, {}] });
    const downloader = automock(MediaDownloaderRepository);
    const service = new MediaImportService(
      repository,
      downloader,
      {} as never,
      {} as never,
      { limits: () => Promise.resolve({ maxSize: 1000 }) } as never,
      {} as never,
      {} as never,
    );
    const row = {
      id: randomUUID(),
      ownerId: subscription.ownerId,
      state: 'inspecting',
      generation: 1,
      subscriptionGeneration: 1,
      connectionId: null,
      subscriptionId: subscription.id,
      mediaCreatorId: null,
      quality: subscription.quality,
      urls: [subscription.url],
      inspection: { ...inspection, kind: 'feed' },
      retries: 0,
      availableAt: new Date(0),
    } as unknown as MediaImport;
    repository.getWorker.mockResolvedValue(row);
    repository.authority.mockReturnValue({
      ownerId: row.ownerId,
      importId: row.id,
      generation: 1,
      subscriptionGeneration: 1,
      jobId: randomUUID(),
      jobToken: randomUUID(),
    });
    repository.assertAuthority.mockResolvedValue({ row, user: UserFactory.create({ id: row.ownerId }) });
    repository.withCapacity.mockImplementation(async (_row, _provider, action) => action());
    repository.subscription.mockResolvedValue(subscription);
    repository.discovered.mockResolvedValue(undefined);
    repository.transition.mockResolvedValue(undefined);
    repository.finishSubscription.mockResolvedValue(undefined);
    repository.items.mockResolvedValue([]);
    downloader.enumerate.mockResolvedValue({ ...inspection, kind: 'feed', entries: [], ...enumerated });
    expect(await service.handleImport({ id: row.id })).toBe(JobStatus.Success);
    return { options: downloader.enumerate.mock.calls[0][1]!, found: repository.discovered.mock.calls[0][1] };
  };

  it('takes the latest few from the top with the chosen kinds, then counts that history as complete', async () => {
    const { options, found } = await run(subscriptionRow(), {
      complete: false,
      checkpoint: 'next',
      limitation: 'limit',
    });
    expect(options).toMatchObject({ checkpoint: null, since: null, limit: 30, saves: { shorts: false } });
    expect(found).toMatchObject({ complete: true, checkpoint: null, limitation: null });
  });

  it('leaves a recent history unfinished when the site answered only in part', async () => {
    const { found } = await run(subscriptionRow(), { complete: false, checkpoint: 'next', limitation: 'partial' });
    expect(found).toMatchObject({ complete: false, checkpoint: 'next', limitation: 'partial' });
  });

  it('carries on from its checkpoint once the latest few are in', async () => {
    const subscription = subscriptionRow({ historyComplete: true });
    const { options } = await run(subscription, {});
    expect(options).toMatchObject({
      checkpoint: 'older-page',
      since: subscription.createdAt.toISOString(),
      limit: 100,
    });
  });

  it('answers older clients with a reach they know and newer ones with the real one', async () => {
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
    repository.actor.mockResolvedValue(undefined);
    repository.subscriptions.mockResolvedValue([
      subscriptionRow(),
      subscriptionRow({ history: { mode: 'since', since: '2026-01-01T00:00:00Z' } }),
    ]);
    repository.subscriptionCounts.mockResolvedValue({ discovered: 0, saved: 0, skipped: 0, failed: 0 });
    const { subscriptions } = await service.subscriptions(authStub.user1);
    expect(subscriptions[0]).toMatchObject({
      history: { mode: 'new' },
      reach: { mode: 'recent', count: 30 },
      saves: { shorts: false },
      quality: '720',
    });
    expect(subscriptions[1].history).toEqual({ mode: 'since', since: '2026-01-01T00:00:00Z' });
  });

  it('requires how far back on create and rejects unknown kinds, qualities and counts', () => {
    const create = (values: object) =>
      MediaSubscriptionCreateDto.schema.safeParse({ inspectionId: randomUUID(), idempotencyKey: 'key', ...values });
    expect(create({}).success).toBe(false);
    expect(create({ history: { mode: 'recent' } }).data).toMatchObject({ saves: {}, quality: 'best' });
    expect(create({ history: { mode: 'recent', count: 200 } }).success).toBe(true);
    expect(create({ history: { mode: 'recent', count: 201 } }).success).toBe(false);
    expect(create({ history: { mode: 'all', count: 20 } }).success).toBe(false);
    expect(create({ history: { mode: 'since' } }).success).toBe(false);
    expect(create({ history: { mode: 'new' }, saves: { shorts: false, stories: true } }).success).toBe(false);
    expect(create({ history: { mode: 'new' }, quality: '4k' }).success).toBe(false);
    const update = MediaSubscriptionUpdateDto.schema.safeParse({
      history: { mode: 'since', since: '2026-01-01T00:00:00Z' },
      saves: { reposts: true },
      quality: 'audio',
    });
    expect(update.success).toBe(true);
    expect(MediaSubscriptionUpdateDto.schema.safeParse({ saves: { other: true } }).success).toBe(false);
    const single = { inspectionId: randomUUID(), itemIds: [randomUUID()], idempotencyKey: 'key' };
    expect(MediaImportCreateDto.schema.parse(single)).toMatchObject({ quality: 'best' });
    expect(MediaImportCreateDto.schema.safeParse({ ...single, quality: '1080' }).success).toBe(true);
    expect(MediaWatchUpdateDto.schema.parse({ watched: true })).toEqual({ watched: true, position: 0 });
    expect(MediaWatchUpdateDto.schema.safeParse({ watched: true, position: -1 }).success).toBe(false);
    expect(MediaCreatorItemsQueryDto.schema.parse({ unwatched: 'true', page: '2' })).toEqual({
      unwatched: true,
      sort: 'newest',
      page: 2,
    });
    expect(MediaCreatorItemsQueryDto.schema.safeParse({ section: 'story' }).success).toBe(false);
  });
});

describe('creators', () => {
  const setup = () => {
    const repository = automock(MediaImportRepository, { args: [{}, {}] });
    const downloader = automock(MediaDownloaderRepository);
    const uploads = { limits: () => Promise.resolve({ maxSize: 1000 }), importMedia: vi.fn() };
    const service = new MediaImportService(
      repository,
      downloader,
      {} as never,
      {} as never,
      uploads as never,
      {} as never,
      {} as never,
    );
    repository.actor.mockResolvedValue(undefined);
    return { repository, downloader, uploads, service };
  };
  const creatorRow = (values: object = {}) => ({
    id: randomUUID(),
    ownerId: authStub.user1.user.id,
    provider: 'youtube',
    creatorId: 'UCfixture',
    name: 'Mara Ellis',
    handle: '@maraellis',
    about: 'Timber framing',
    url: 'https://www.youtube.com/@maraellis',
    avatarUrl: 'https://cdn.example.org/avatar?sig=private',
    avatarPath: '/private/avatar.jpg',
    bannerUrl: 'https://cdn.example.org/banner?sig=private',
    bannerPath: null,
    albumId: randomUUID(),
    parentAlbumId: null,
    seenAt: new Date('2026-11-01'),
    createdAt: new Date('2026-10-01'),
    updatedAt: new Date('2026-10-01'),
    subscription: null,
    savedCount: 3,
    newCount: 2,
    ...values,
  });

  it('lists followed and added creators without any address of another site’s pictures', async () => {
    const { repository, service } = setup();
    const subscription = subscriptionRow({ limitation: 'limit', lastSuccessAt: new Date('2026-11-09') });
    repository.creators.mockResolvedValue([
      creatorRow({ subscription }),
      creatorRow({ url: 'javascript:alert(1)', avatarPath: null }),
    ] as never);
    const { creators } = await service.creators(authStub.user1);
    expect(repository.actor).toHaveBeenCalledWith(authStub.user1, Permission.MediaImportRead);
    expect(creators[0]).toMatchObject({
      name: 'Mara Ellis',
      handle: '@maraellis',
      hasAvatar: true,
      hasBanner: false,
      following: true,
      savedCount: 3,
      newCount: 2,
      subscription: {
        id: subscription.id,
        status: 'active',
        intervalMinutes: 60,
        history: { mode: 'recent', count: 30 },
        saves: { shorts: false },
        quality: '720',
        lastSuccessAt: '2026-11-09T00:00:00.000Z',
        limitation: 'limit',
      },
    });
    expect(creators[1]).toMatchObject({ following: false, subscription: null, url: null, hasAvatar: false });
    expect(JSON.stringify(creators)).not.toContain('cdn.example.org');
    expect(JSON.stringify(creators)).not.toContain('/private/');
  });

  it('describes an item for the details panel and withholds an unsafe source link', async () => {
    const { repository, service } = setup();
    const item = (values: object = {}) =>
      ({
        assetId: randomUUID(),
        type: AssetType.Video,
        creatorId: randomUUID(),
        section: 'short',
        title: 'Scribing a post to stone',
        postText: 'One minute, one scribe.',
        tags: ['shorts'],
        publishedAt: new Date('2026-10-12'),
        savedAt: new Date('2026-10-13'),
        duration: 42,
        postId: 'post',
        playlistId: null,
        playlistTitle: null,
        pageUrl: 'https://www.youtube.com/shorts/one',
        posterPath: '/private/poster.jpg',
        watched: true,
        position: 12,
        subscribed: true,
        ...values,
      }) as MediaCreatorItem;
    repository.creatorItems.mockResolvedValue([
      item(),
      item({
        type: AssetType.Image,
        section: 'unknown',
        pageUrl: 'javascript:alert(1)',
        watched: null,
        position: null,
        subscribed: false,
        posterPath: null,
      }),
      ...Array.from({ length: 49 }, () => item()),
    ]);
    const id = randomUUID();
    const dto = MediaCreatorItemsQueryDto.schema.parse({ page: 3 });
    const response = await service.creatorItems(authStub.user1, id, dto);
    expect(repository.creatorItems).toHaveBeenCalledWith(authStub.user1.user.id, id, dto);
    expect(response).toMatchObject({ page: 3, hasNextPage: true });
    expect(response.items).toHaveLength(50);
    expect(response.items[0]).toMatchObject({
      kind: 'video',
      section: 'short',
      title: 'Scribing a post to stone',
      description: 'One minute, one scribe.',
      tags: ['shorts'],
      publishedAt: '2026-10-12T00:00:00.000Z',
      duration: 42,
      postId: 'post',
      pageUrl: 'https://www.youtube.com/shorts/one',
      savedBy: 'subscription',
      hasPoster: true,
      watched: true,
      position: 12,
    });
    expect(response.items[1]).toMatchObject({
      kind: 'image',
      section: null,
      pageUrl: null,
      savedBy: 'download',
      hasPoster: false,
      watched: false,
      position: 0,
    });
    expect(JSON.stringify(response)).not.toContain('/private/');
  });

  it('records watched state and a visit only for the signed-in account', async () => {
    const { repository, service } = setup();
    const assetId = randomUUID();
    repository.watch.mockResolvedValue({
      ownerId: authStub.user1.user.id,
      assetId,
      watched: true,
      position: 30,
      updatedAt: new Date('2026-11-10'),
    });
    expect(await service.watch(authStub.user1, assetId, { watched: true, position: 30 })).toEqual({
      assetId,
      watched: true,
      position: 30,
      updatedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(repository.watch).toHaveBeenCalledWith(authStub.user1.user.id, assetId, { watched: true, position: 30 });
    const row = creatorRow({ newCount: 0 });
    repository.creators.mockResolvedValue([row] as never);
    repository.seen.mockResolvedValue(undefined);
    expect((await service.seen(authStub.user1, row.id)).newCount).toBe(0);
    expect(repository.seen).toHaveBeenCalledWith(authStub.user1.user.id, row.id);
    expect(repository.actor).toHaveBeenCalledWith(authStub.user1, Permission.MediaImportUpdate);
    repository.creators.mockResolvedValue([]);
    await expect(service.creator(authStub.user1, randomUUID())).rejects.toThrow('Creator unavailable');
  });

  it('serves only the kept copy of a picture', async () => {
    const { repository, service } = setup();
    const row = creatorRow();
    repository.creator.mockResolvedValue(row as never);
    expect(await service.creatorImage(authStub.user1, row.id, 'avatar')).toMatchObject({
      path: '/private/avatar.jpg',
      contentType: 'image/jpeg',
    });
    await expect(service.creatorImage(authStub.user1, row.id, 'banner')).rejects.toThrow('Picture unavailable');
    repository.poster.mockResolvedValue('/private/poster.webp');
    expect(await service.poster(authStub.user1, randomUUID())).toMatchObject({ contentType: 'image/webp' });
  });

  it('downloads at the chosen quality, then keeps the creator’s pictures and the video’s cover', async () => {
    const { repository, downloader, uploads, service } = setup();
    const video = { ...entry, kind: 'video' as const, thumbnailUrl: 'https://cdn.example.org/cover.jpg' };
    const creator = creatorRow({ avatarPath: null, bannerUrl: null });
    const row = {
      id: randomUUID(),
      ownerId: authStub.user1.user.id,
      state: 'queued',
      generation: 1,
      subscriptionGeneration: null,
      connectionId: null,
      subscriptionId: null,
      mediaCreatorId: creator.id,
      quality: '1080',
      streamMp4: false,
      retries: 0,
      urls: [entry.pageUrl],
      availableAt: new Date(0),
    } as unknown as MediaImport;
    const authority = {
      ownerId: row.ownerId,
      importId: row.id,
      generation: 1,
      subscriptionGeneration: null,
      jobId: randomUUID(),
      jobToken: randomUUID(),
    };
    const item = {
      id: randomUUID(),
      entry: video,
      sourceKey: mediaSourceKey(video),
      state: 'discovered',
      createdAt: new Date(),
    };
    const assetId = randomUUID();
    repository.getWorker.mockResolvedValue(row);
    repository.authority.mockReturnValue(authority);
    repository.assertAuthority.mockResolvedValue({ row, user: UserFactory.create({ id: row.ownerId }) });
    repository.withCapacity.mockImplementation(async (_row, _provider, action) => action());
    repository.creator.mockResolvedValue(creator as never);
    repository.items.mockResolvedValueOnce([item as never]).mockResolvedValue([{ ...item, state: 'saved' } as never]);
    repository.suppressed.mockResolvedValue(false);
    repository.reusePublished.mockResolvedValue(false);
    repository.progress.mockResolvedValue(undefined);
    repository.transition.mockResolvedValue(undefined);
    repository.setPoster.mockResolvedValue(undefined);
    downloader.download.mockResolvedValue([{ path: '/tmp/media.mp4', size: 10, entry: video } as never]);
    downloader.fetchImage
      .mockRejectedValueOnce(new Error('picture host is down'))
      .mockImplementationOnce(async (_url, { directory }) => {
        const path = join(directory, 'fetched-media.jpg');
        await writeFile(path, 'cover');
        return { path } as never;
      });
    uploads.importMedia.mockResolvedValue(assetId);

    expect(await service.handleImport({ id: row.id })).toBe(JobStatus.Success);
    expect(downloader.download).toHaveBeenCalledWith(video, expect.objectContaining({ quality: '1080' }));
    expect(downloader.fetchImage.mock.calls.map(([url]) => url)).toEqual([creator.avatarUrl, video.thumbnailUrl]);
    // A picture that cannot be fetched is left out; it never fails the import.
    expect(repository.setCreatorImage).not.toHaveBeenCalled();
    const poster = join(media, 'thumbs', row.ownerId, 'media-creators', 'posters', `${assetId}.jpg`);
    expect(repository.setPoster).toHaveBeenCalledWith(row.ownerId, assetId, video, poster);
    expect(existsSync(poster)).toBe(true);
    expect(repository.transition).toHaveBeenLastCalledWith(authority, 'saved');
  });
});
