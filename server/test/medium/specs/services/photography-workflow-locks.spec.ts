import { ConflictException } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, AssetLockReason, AssetVisibility, JobStatus } from 'src/enum.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let folder: string;
beforeAll(async () => {
  db = await getKyselyDB();
  folder = await mkdtemp(path.join(os.tmpdir(), 'photography-locks-'));
});
afterAll(async () => {
  await db?.destroy();
  if (folder) await rm(folder, { recursive: true, force: true });
});

it('rechecks canonical source and logo locks for published metadata, pixels and pinned archives, then restores access on unlock', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { session: ownerSession } = await ctx.newSession({ userId: user.id });
  const auth = factory.auth({ user, session: { id: ownerSession.id, hasElevatedPermission: false } });
  const pixels = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#667788' } })
    .png()
    .toBuffer();
  const files = Object.fromEntries(
    ['original', 'master', 'preview', 'thumbnail', 'output', 'approval', 'logo'].map((name) => [
      name,
      path.join(folder, `${name}.png`),
    ]),
  );
  for (const file of Object.values(files)) await writeFile(file, pixels);
  const { asset: source } = await ctx.newAsset({
    ownerId: user.id,
    originalFileName: 'private-portrait.jpg',
    originalPath: files.original,
  });
  const { asset: archived } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
  const { asset: jpeg } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'pair.jpg' });
  const { asset: raw } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'pair.CR3' });
  const pairId = newUuid();
  for (const asset of [jpeg, raw]) await ctx.newExif({ assetId: asset.id, autoStackId: pairId });
  for (const asset of [source, archived, jpeg, raw])
    await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: files.preview, isEdited: false });
  const { asset: logo } = await ctx.newAsset({ ownerId: user.id, originalPath: files.logo });
  await ctx.newExif({ assetId: logo.id, fileSizeInByte: pixels.length });
  const { album } = await ctx.newAlbum({ ownerId: user.id }, [source.id, archived.id, jpeg.id, raw.id]);
  const shootId = newUuid();
  const brand = {
    name: 'North Studio',
    tagline: '',
    email: '',
    phone: '',
    logoInitials: 'NS',
    logoAssetId: logo.id as string | null,
    color: '#577059',
    background: '#f5f3ed',
    textColor: '#263329',
    font: 'editorial' as const,
    watermarkColor: '#ffffff',
    watermarkOpacity: 45,
    watermarkPosition: 'bottom-right',
    watermarkSize: 6,
  };
  const repository = new PhotographyWorkflowRepository(db);
  const storage = {
    createZipStream: vi.fn(() => ({ stream: { destroy: vi.fn() }, addFile: vi.fn(), finalize: async () => {} })),
  };
  const service = new PhotographyWorkflowService(
    repository,
    {
      get: async () => ({ value: { shoots: [{ id: shootId, albumId: album.id, name: 'Portrait' }], brand } }),
    } as never,
    { get: async () => ({ albumUsers: [{ user: { id: user.id } }], isSmart: false, kind: 'album' }) } as never,
    new AssetDevelopRepository(db),
    {} as never,
    { queue: vi.fn(async () => {}) } as never,
    storage as never,
  );
  const intake = await service.intake(auth, shootId, { expectedRevision: null });
  expect(intake.captures).toHaveLength(3);
  expect(intake.captures.every((capture) => capture.eligible)).toBe(true);
  expect(intake.captures.flatMap((capture) => capture.assetIds).sort()).toEqual(
    [source.id, archived.id, jpeg.id, raw.id].sort(),
  );
  const captureId = intake.captures.find((capture) => capture.assetId === source.id)!.id;
  const groupId = intake.captures.find((capture) => capture.assetId === jpeg.id)!.id;
  const invitation = await service.createRecipient(auth, shootId, {
    expectedRevision: intake.revision,
    name: 'Client',
    password: null,
    expiresAt: null,
    canProof: true,
    canDownload: true,
    captureIds: null,
  });
  const guest = await service.session(shootId, { token: invitation.invitation.token });
  const pins: { captureId: string; revisionId: string; outputId: string; orderId: string }[] = [];
  for (const [asset, id] of [
    [source, captureId],
    [raw, groupId],
  ] as const) {
    const { rows } = await sql<{ id: string }>`INSERT INTO public.asset_develop_revision
      ("assetId", "ownerId", revision, recipe, status, "masterPath", "sourceChecksum")
      VALUES (${asset.id}::uuid, ${user.id}::uuid, 1, '{}'::jsonb, 'rendered', ${files.master}, ${asset.checksum})
      RETURNING id`.execute(db);
    pins.push({ captureId: id, revisionId: rows[0].id, outputId: newUuid(), orderId: newUuid() });
  }
  const { rows: rejectedRows } = await sql<{ id: string }>`INSERT INTO public.asset_develop_revision
    ("assetId", "ownerId", revision, recipe, status, "masterPath", "sourceChecksum")
    VALUES (${source.id}::uuid, ${user.id}::uuid, 2, '{}'::jsonb, 'rendered', ${files.master}, ${source.checksum})
    RETURNING id`.execute(db);
  const rejection = {
    recipientId: guest.recipientId,
    captureId,
    revisionId: rejectedRows[0].id,
    approved: false,
    note: 'Keep the original colours',
    createdAt: new Date().toISOString(),
  };
  const row = (await repository.get(shootId))!;
  await repository.mutate(shootId, user.id, album.id, row.revision, row.value, (value) => {
    const watermark = { ...value.config.proofWatermark, type: 'both' as const, logoAssetId: logo.id };
    value.config.proofWatermark = watermark;
    value.config.webWatermark = watermark;
    value.published = {
      generationId: newUuid(),
      config: structuredClone(value.config),
      chapters: [],
      brand,
      logoPath: files.logo,
      photos: pins.map((pin) => {
        const capture = value.captures.find((capture) => capture.id === pin.captureId)!;
        capture.proofRevisionId = pin.revisionId;
        capture.approvedRevisionId = pin.revisionId;
        capture.approvalRequested = true;
        capture.state = 'approved';
        return {
          captureId: capture.id,
          number: capture.number,
          chapterId: null,
          previewPath: files.preview,
          thumbnailPath: files.thumbnail,
          revisionId: pin.revisionId,
        };
      }),
    };
    for (const pin of pins) {
      value.approvedVersions!.push({
        captureId: pin.captureId,
        revisionId: pin.revisionId,
        approvedAt: new Date().toISOString(),
      });
      value.approvals.push({
        recipientId: guest.recipientId,
        captureId: pin.captureId,
        revisionId: pin.revisionId,
        approved: true,
        note: '',
        createdAt: new Date().toISOString(),
      });
      const output = {
        id: pin.outputId,
        key: 'web',
        label: 'Web',
        kind: 'web' as const,
        revisionId: pin.revisionId,
        approved: true,
        clientApprovalRequired: true,
        explicitRevision: true,
        approvalPreviewPath: files.approval,
        proofWatermark: watermark,
        finalPath: files.output,
        exportWatermark: watermark,
        exportSpec: { format: 'jpeg' as const, quality: 90 as const, maxEdge: 2048 },
      };
      value.orders.push({
        id: pin.orderId,
        recipientId: guest.recipientId,
        roundId: null,
        status: 'free',
        currency: 'CAD',
        total: 0,
        captureIds: [pin.captureId],
        terms: '',
        paymentTiming: 'after-approval',
        pricing: { includedCount: 1, additionalPrice: 0, collectionPrice: null, bundles: [], option: 'included' },
        items: [
          {
            captureId: pin.captureId,
            revisionId: pin.revisionId,
            approved: true,
            clientApprovalRequired: true,
            finalPath: files.output,
            exportWatermark: watermark,
            exportSpec: output.exportSpec,
            outputs: [output],
          },
        ],
        createdAt: new Date().toISOString(),
        acceptedAt: new Date().toISOString(),
        checkoutId: null,
        paymentIntentId: null,
      });
    }
    value.approvals.push(rejection);
  });
  const historical = await service.get(auth, shootId);
  expect(historical.approvals).toContainEqual(rejection);
  expect(JSON.stringify([historical.captures, historical.approvedVersions, historical.orders])).not.toContain(
    rejection.revisionId,
  );
  await service.saveSite(auth, {
    expectedRevision: null,
    site: {
      enabled: true,
      title: brand.name,
      about: '',
      services: '',
      contact: '',
      presentation: { layout: 'editorial', spacing: 'comfortable', font: 'editorial', palette: 'studio' },
      portfolio: pins.map((pin) => ({ shootId, captureId: pin.captureId, consent: true })),
    },
  });
  const byteReaders = (pin: (typeof pins)[number]) => [
    () => service.file(shootId, guest.session, pin.captureId, 'preview'),
    () => service.file(shootId, guest.session, pin.captureId, 'thumbnail'),
    () => service.outputPreview(shootId, guest.session, pin.captureId, pin.outputId),
    () => service.outputFile(shootId, guest.session, pin.captureId, pin.outputId),
    () => service.file(shootId, guest.session, pin.captureId, 'download'),
    () => service.publicPhoto(user.id, shootId, pin.captureId),
  ];
  const expectedPaths = [files.preview, files.thumbnail, files.approval, files.output, files.output, files.preview];
  const archives = [];
  for (const pin of pins) {
    for (const [index, read] of byteReaders(pin).entries())
      await expect(read()).resolves.toMatchObject({ path: expectedPaths[index] });
    const archive = await service.zip(shootId, guest.session, { captureIds: [pin.captureId] });
    archives.push(archive.id);
    await expect(service.archive(shootId, guest.session, archive.id)).resolves.toMatchObject({
      type: 'application/zip',
    });
  }
  expect((await service.gallery(shootId, guest.session)).photos).toHaveLength(2);
  await expect(service.galleryLogo(shootId, guest.session)).resolves.toMatchObject({ path: files.logo });
  expect((await service.publicLogo(user.id)).length).toBeGreaterThan(0);
  const stored = (await repository.get(shootId))!.value;

  // A canonical lock leaves timeline/archive visibility and album membership untouched.
  await db
    .insertInto('asset_lock')
    .values({ assetId: source.id, reason: AssetLockReason.Marked, lockedBy: user.id })
    .execute();
  const owner = await service.get(auth, shootId);
  expect(owner.captures.find((capture) => capture.id === captureId)).toMatchObject({
    eligible: false,
    assetId: null,
    assetIds: [],
    fileName: null,
    checksum: null,
    camera: null,
    capturedAt: null,
    proofRevisionId: null,
    approvedRevisionId: null,
  });
  expect(owner.approvedVersions.every((version) => version.captureId !== captureId)).toBe(true);
  expect(owner.approvals.every((approval) => approval.captureId !== captureId)).toBe(true);
  const hidden = await service.gallery(shootId, guest.session);
  expect(hidden.photos.map((photo) => photo.id)).toEqual([groupId]);
  for (const view of [owner, hidden])
    expect(view.orders.find((order) => order.id === pins[0].orderId)).toMatchObject({ captureIds: [], items: [] });
  for (const read of byteReaders(pins[0])) await expect(read()).rejects.toThrow();
  await expect(service.zip(shootId, guest.session, { captureIds: [captureId] })).rejects.toThrow();
  await expect(service.archive(shootId, guest.session, archives[0])).rejects.toThrow();
  expect((await service.publicSite(user.id)).portfolio.map((photo) => photo.captureId)).toEqual([groupId]);
  expect(
    await repository.eligibleRevisions(
      (await repository.get(shootId))!,
      pins.map((pin) => pin.revisionId),
    ),
  ).toEqual(new Set([pins[1].revisionId]));
  expect((await repository.get(shootId))!.value.captures).toEqual(stored.captures);
  expect((await repository.get(shootId))!.value.orders).toEqual(stored.orders);
  expect(
    await db
      .selectFrom('asset')
      .select(['id', 'visibility'])
      .where('id', 'in', [source.id, archived.id])
      .orderBy('id')
      .execute(),
  ).toEqual(
    [
      { id: source.id, visibility: AssetVisibility.Timeline },
      { id: archived.id, visibility: AssetVisibility.Archive },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  expect(await db.selectFrom('album_asset').select('assetId').where('albumId', '=', album.id).execute()).toHaveLength(
    4,
  );
  await db.deleteFrom('asset_lock').where('assetId', '=', source.id).execute();

  // A revision can use a non-primary RAW source whose JPEG capture remains unlocked.
  await db
    .insertInto('asset_lock')
    .values({ assetId: raw.id, reason: AssetLockReason.Marked, lockedBy: user.id })
    .execute();
  const groupedOwner = await service.get(auth, shootId);
  expect(groupedOwner.captures.find((capture) => capture.id === groupId)).toMatchObject({
    eligible: true,
    assetId: jpeg.id,
    assetIds: [jpeg.id],
    proofRevisionId: null,
    approvedRevisionId: null,
  });
  expect((await service.gallery(shootId, guest.session)).photos.map((photo) => photo.id)).toEqual([captureId]);
  for (const read of byteReaders(pins[1])) await expect(read()).rejects.toThrow();
  await expect(service.archive(shootId, guest.session, archives[1])).rejects.toThrow();
  expect(
    await repository.eligibleRevisions(
      (await repository.get(shootId))!,
      pins.map((pin) => pin.revisionId),
    ),
  ).toEqual(new Set([pins[0].revisionId]));
  await db.deleteFrom('asset_lock').where('assetId', '=', raw.id).execute();

  // Cached pixels also contain the pinned logo, even when their photograph is unlocked.
  await db
    .insertInto('asset_lock')
    .values({ assetId: logo.id, reason: AssetLockReason.Marked, lockedBy: user.id })
    .execute();
  expect((await service.gallery(shootId, guest.session)).brand.logoUrl).toBeNull();
  expect((await service.publicSite(user.id)).brand.logoUrl).toBeNull();
  for (const view of [await service.get(auth, shootId), await service.gallery(shootId, guest.session)])
    expect(view.orders.find((order) => order.id === pins[0].orderId)!.items[0].outputs[0]).toMatchObject({
      ready: false,
      approvalPreviewUrl: null,
    });
  await expect(service.galleryLogo(shootId, guest.session)).rejects.toThrow();
  await expect(service.publicLogo(user.id)).rejects.toThrow();
  for (const read of byteReaders(pins[0])) await expect(read()).rejects.toThrow();
  await expect(service.zip(shootId, guest.session, { captureIds: [captureId] })).rejects.toThrow();
  await expect(service.archive(shootId, guest.session, archives[0])).rejects.toThrow();
  await db.deleteFrom('asset_lock').where('assetId', '=', logo.id).execute();

  const restored = await service.get(auth, shootId);
  expect(restored.captures.every((capture) => capture.eligible)).toBe(true);
  expect(restored.captures.find((capture) => capture.id === captureId)).toMatchObject({
    assetId: source.id,
    fileName: source.originalFileName,
    proofRevisionId: pins[0].revisionId,
    approvedRevisionId: pins[0].revisionId,
  });
  expect(restored.approvedVersions).toHaveLength(2);
  expect(restored.approvals).toHaveLength(3);
  expect(restored.approvals).toContainEqual(rejection);
  expect(restored.orders.every((order) => order.items.length === 1)).toBe(true);
  expect(
    await repository.eligibleRevisions(
      (await repository.get(shootId))!,
      pins.map((pin) => pin.revisionId),
    ),
  ).toEqual(new Set(pins.map((pin) => pin.revisionId)));
  expect((await service.gallery(shootId, guest.session)).photos).toHaveLength(2);
  expect((await service.publicSite(user.id)).portfolio).toHaveLength(2);
  await expect(service.galleryLogo(shootId, guest.session)).resolves.toMatchObject({ path: files.logo });
  expect((await service.publicLogo(user.id)).length).toBeGreaterThan(0);
  for (const [index, pin] of pins.entries()) {
    for (const [fileIndex, read] of byteReaders(pin).entries())
      await expect(read()).resolves.toMatchObject({ path: expectedPaths[fileIndex] });
    await expect(service.archive(shootId, guest.session, archives[index])).resolves.toMatchObject({
      type: 'application/zip',
    });
    await expect(service.zip(shootId, guest.session, { captureIds: [pin.captureId] })).resolves.toMatchObject({
      status: 'ready',
    });
  }

  // Legacy proofs have no watermark provenance; a later gallery setting cannot establish it.
  let current = (await repository.get(shootId))!;
  await repository.mutate(shootId, user.id, album.id, current.revision, current.value, (value) => {
    const published = value.published!;
    published.brand.logoAssetId = null;
    published.logoPath = null;
    published.config.proofWatermark = { ...published.config.proofWatermark, type: 'text', logoAssetId: null };
    published.config.webWatermark = null;
    delete value.orders[0].items[0].outputs![0].proofWatermark;
  });
  await expect(service.outputPreview(shootId, guest.session, captureId, pins[0].outputId)).rejects.toBeInstanceOf(
    ConflictException,
  );
  for (const view of [await service.get(auth, shootId), await service.gallery(shootId, guest.session)])
    expect(
      view.orders.find((order) => order.id === pins[0].orderId)!.items[0].outputs[0].approvalPreviewUrl,
    ).toBeNull();
  expect((await repository.get(shootId))!.value.orders[0].items[0].outputs![0].approvalPreviewPath).toBe(
    files.approval,
  );

  // The locked old proof must not prevent a clean final or a replacement publication.
  current = (await repository.get(shootId))!;
  await repository.mutate(shootId, user.id, album.id, current.revision, current.value, (value) => {
    value.published = structuredClone(stored.published);
    value.config.proofWatermark = { ...value.config.proofWatermark, type: 'text', logoAssetId: null };
    value.config.webWatermark = null;
    for (const order of value.orders)
      for (const item of order.items) {
        item.outputs![0].exportWatermark = null;
        item.exportWatermark = null;
      }
  });
  brand.logoAssetId = null;
  await db
    .insertInto('asset_lock')
    .values({ assetId: logo.id, reason: AssetLockReason.Marked, lockedBy: user.id })
    .execute();
  for (const view of [await service.get(auth, shootId), await service.gallery(shootId, guest.session)])
    for (const pin of pins)
      expect(view.orders.find((order) => order.id === pin.orderId)!.items[0].outputs[0]).toMatchObject({
        ready: true,
        approvalPreviewUrl: null,
      });
  await expect(service.file(shootId, guest.session, captureId, 'preview')).rejects.toThrow();
  await expect(service.outputFile(shootId, guest.session, captureId, pins[0].outputId)).resolves.toMatchObject({
    path: files.output,
  });
  await expect(service.file(shootId, guest.session, captureId, 'download')).resolves.toMatchObject({
    path: files.output,
  });
  await expect(service.archive(shootId, guest.session, archives[0])).resolves.toMatchObject({
    type: 'application/zip',
  });
  await service.publish(auth, shootId, {
    expectedRevision: (await repository.get(shootId))!.revision,
    scope: 'all-eligible',
  });
  const location = vi.spyOn(StorageCore, 'getFolderLocation').mockReturnValue(folder);
  try {
    expect(await service.render({ id: shootId })).toBe(JobStatus.Success);
  } finally {
    location.mockRestore();
  }
  const replacement = (await repository.get(shootId))!.value;
  expect(replacement.publication?.status).toBe('ready');
  expect(replacement.published?.brand.logoAssetId).toBeNull();
  expect(replacement.orders[0].items[0].outputs![0].proofWatermark).toMatchObject({ type: 'text', logoAssetId: null });
  await expect(service.file(shootId, guest.session, captureId, 'preview')).resolves.toMatchObject({
    path: replacement.published!.photos.find((photo) => photo.captureId === captureId)!.previewPath,
  });
  await expect(service.outputPreview(shootId, guest.session, captureId, pins[0].outputId)).resolves.toMatchObject({
    path: replacement.orders[0].items[0].outputs![0].approvalPreviewPath,
  });
  await db.deleteFrom('asset_lock').where('assetId', '=', logo.id).execute();
});
