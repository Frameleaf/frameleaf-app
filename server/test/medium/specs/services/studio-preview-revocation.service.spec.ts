import { Kysely } from 'kysely';
import { AlbumKind, AlbumUserRole, AssetType, StudioPreviewQuality, StudioPreviewStatus } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioExportRepository } from 'src/repositories/studio-export.repository.js';
import { StudioPreviewRepository } from 'src/repositories/studio-preview.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { StudioPreviewService, studioPreviewFrameFolder } from 'src/services/studio-preview.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { StudioDestination } from 'src/utils/studio-resources.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { automock, getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => database?.destroy());

it.each([
  'storage validation',
  'grant verification',
  'project deletion',
  'reviewer removal',
  'grant refresh',
  'operation replacement',
] as const)('protects a pending preview across %s', async (boundary) => {
  const { sut: resources, ctx } = newMediumService(StudioResourceService, {
    database,
    real: [AccessRepository, AssetRepository, CryptoRepository],
    mock: [LoggingRepository],
  });
  const { user: owner } = await ctx.newUser();
  const { user: recipient } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id, type: AssetType.Image });
  const shares = new ItemShareRepository(database);
  await shares.add(owner.id, [asset.id], [recipient.id]);
  const auth = factory.auth({ user: recipient });
  const graph = { id: 'sequence', tracks: [{ id: 'video', kind: 'video', clips: [{ assetId: asset.id }] }] };
  const projects = new StudioProjectRepository(database);
  const { album } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Space });
  await ctx.newAlbumUser({ albumId: album.id, userId: recipient.id, role: AlbumUserRole.Viewer });
  const projectOwner = boundary === 'reviewer removal' ? owner.id : recipient.id;
  const { project } = await projects.createWithRevision({
    ownerId: projectOwner,
    spaceId: album.id,
    name: 'Shared source preview',
    revision: {
      authorId: projectOwner,
      envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'test', graph },
      digest: 'revision-1',
      graphBytes: JSON.stringify(graph).length,
      summary: {},
      requestKey: null,
    },
  });
  const { manifest } = await resources.resolveProjectResources(auth, {
    projectId: project.id,
    ownerId: projectOwner,
    revision: 1,
    graph,
    destination: StudioDestination.Local,
  });
  expect(manifest.complete).toBe(true);
  expect(manifest.entries).toEqual([expect.objectContaining({ id: asset.id, sourceAccess: 'shared' })]);

  const frames = new StudioPreviewRepository(database, new DerivativePrivacyRepository(database));
  const operations = new MediaOperationRepository(database);
  const storage = automock(StorageRepository, { args: [ctx.getMock(LoggingRepository)], strict: false });
  storage.stat.mockResolvedValue({ isFile: () => true, size: 2048 } as never);
  storage.unlinkDir.mockResolvedValue();
  const projectService = new StudioProjectService(
    ctx.getMock(LoggingRepository),
    projects,
    ctx.get(AccessRepository),
    resources,
    automock(WebsocketRepository, { args: [undefined, ctx.getMock(LoggingRepository)], strict: false }),
  );
  const sut = new StudioPreviewService(
    ctx.getMock(LoggingRepository),
    frames,
    operations,
    resources,
    projectService,
    storage,
    automock(StudioExportRepository, { strict: false }),
    ctx.get(UserRepository),
  );
  const request = (time: number) =>
    sut.requestForManifest(auth, manifest, {
      time: { numerator: String(time), denominator: '1' },
      quality: StudioPreviewQuality.Draft,
      viewportWidth: 960,
      viewportHeight: 540,
    });
  const output = (frameId: string) => ({
    path: `${studioPreviewFrameFolder(recipient.id, frameId)}/frame.png`,
    checksum: 'c'.repeat(64),
    sizeInBytes: '2048',
    contentType: 'image/png',
  });
  const { preview: previous } = await request(0);
  const previousOperation = await operations.getForOwner(previous.operationId!, recipient.id);
  await expect(sut.onRenderCompleted(previousOperation!, output(previous.id))).resolves.toEqual({ published: true });
  await expect(sut.getFrame(auth, previous.id, {})).resolves.toMatchObject({
    file: { path: output(previous.id).path },
  });

  const { preview: pending } = await request(1);
  const operation = await operations.getForOwner(pending.operationId!, recipient.id);
  if (boundary === 'grant refresh' || boundary === 'operation replacement') {
    // The failed verifier holds an old row while a real re-request renews that same cache entry.
    await database
      .updateTable('studio_preview_frame')
      .set({ grantToken: 'expired-token' })
      .where('id', '=', pending.id)
      .execute();
    const verify = resources.verifyReadGrant.bind(resources);
    vi.spyOn(resources, 'verifyReadGrant').mockImplementationOnce(async (...args) => {
      const refused = await verify(...args);
      expect(refused.valid).toBe(false);
      if (boundary === 'operation replacement') await frames.evict([pending.id]);
      const refreshed = await request(1);
      expect(refreshed.preview.id).toBe(pending.id);
      return refused;
    });
    await expect(sut.onRenderCompleted(operation!, output(pending.id))).rejects.toThrow('Preview binding changed');
    const refreshed = (await frames.getForOwner(pending.id, recipient.id))!;
    expect(refreshed.status).toBe(StudioPreviewStatus.Rendering);
    expect(refreshed.grantToken).not.toBe('expired-token');
    expect(refreshed.operationId === pending.operationId).toBe(boundary === 'grant refresh');
    expect(storage.unlinkDir).not.toHaveBeenCalled();
    const currentOperation = await operations.getForOwner(refreshed.operationId!, recipient.id);
    await expect(sut.onRenderCompleted(currentOperation!, output(pending.id))).resolves.toEqual({ published: true });
    await expect(sut.getFrame(auth, pending.id, {})).resolves.toMatchObject({
      file: { path: output(pending.id).path },
    });
    return;
  }
  if (boundary === 'storage validation') {
    storage.stat.mockImplementationOnce(async () => {
      await shares.remove(owner.id, [asset.id], [recipient.id]);
      return { isFile: () => true, size: 2048 } as never;
    });
  } else if (boundary === 'grant verification') {
    const verify = resources.verifyReadGrant.bind(resources);
    vi.spyOn(resources, 'verifyReadGrant').mockImplementationOnce(async (...args) => {
      const granted = await verify(...args);
      expect(granted.valid).toBe(true);
      await shares.remove(owner.id, [asset.id], [recipient.id]);
      return granted;
    });
  } else {
    const readable = projectService.getReadableRevision.bind(projectService);
    vi.spyOn(projectService, 'getReadableRevision').mockImplementationOnce(async (...args) => {
      const head = await readable(...args);
      expect(head).toBe(1);
      if (boundary === 'project deletion') {
        await database
          .updateTable('studio_project')
          .set({ deletedAt: new Date() })
          .where('id', '=', project.id)
          .execute();
      } else {
        await database
          .deleteFrom('album_user')
          .where('albumId', '=', album.id)
          .where('userId', '=', recipient.id)
          .execute();
      }
      return head;
    });
  }
  await expect(sut.onRenderCompleted(operation!, output(pending.id))).resolves.toEqual({ published: false });
  await expect(frames.getForOwner(pending.id, recipient.id)).resolves.toMatchObject({
    status: StudioPreviewStatus.Evicted,
    framePath: null,
  });
  await expect(sut.getFrame(auth, pending.id, {})).rejects.toThrow();
  await expect(frames.getForOwner(previous.id, recipient.id)).resolves.toMatchObject({
    status: StudioPreviewStatus.Ready,
    framePath: output(previous.id).path,
  });
  expect(storage.unlinkDir).not.toHaveBeenCalledWith(studioPreviewFrameFolder(recipient.id, previous.id), {
    recursive: true,
    force: true,
  });
  await expect(
    resources.verifyReadGrant((await frames.getForOwner(previous.id, recipient.id))!.grantToken!, {
      workerId: auth.session?.id ?? recipient.id,
      auth,
    }),
  ).resolves.toMatchObject({ valid: boundary === 'project deletion' || boundary === 'reviewer removal' });
});
