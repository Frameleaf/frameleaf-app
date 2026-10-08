import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AssetRestoration } from 'src/repositories/asset-restoration.repository.js';
import type { StudioResourceRights } from 'src/utils/studio-rights.generated.js';
import { AuthSession } from 'src/database.js';
import { AssetRestorationStatus } from 'src/dtos/asset-restoration.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetFileType, AssetLockReason, AssetType, AssetVisibility, ColorTransfer, JobName } from 'src/enum.js';
import {
  STUDIO_GRANT_TTL_SECONDS,
  StudioAuthorizedManifest,
  StudioProjectResourceContext,
  StudioReadGrantPayload,
  StudioResourceService,
} from 'src/services/studio-resource.service.js';
import {
  STUDIO_MAX_GRAPH_BYTES,
  STUDIO_MAX_REFERENCES,
  StudioDestination,
  StudioRefusalReason,
  StudioResourceKind,
  studioRestoredMediaId,
} from 'src/utils/studio-resources.js';
import { studioProducerModels } from 'src/utils/studio-rights.js';
import { AssetFileFactory } from 'test/factories/asset-file.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/**
 * FL-86: the reviewed rights table the resolver consults. It starts empty, so every resource is
 * blocked as unknown; a test admits a row by writing it here.
 */
const rightsTable = vi.hoisted(() => ({}) as Record<string, StudioResourceRights>);
vi.mock('src/utils/studio-rights.generated.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/utils/studio-rights.generated.js')>();
  return { ...actual, studioResourceRights: rightsTable };
});
const admit = (id: string, uses: Partial<Pick<StudioResourceRights, 'localRuntime' | 'hostedUse'>> = {}) => {
  rightsTable[id] = {
    kind: id.split(':', 1)[0],
    license: null,
    redistribution: 'blocked',
    localRuntime: 'allowed',
    hostedUse: 'blocked',
    approvedOn: null,
    restrictions: {},
    ...uses,
  };
};

/** A reviewed row the owner has not approved: every use blocked. */
const block = (id: string) => {
  rightsTable[id] = {
    kind: id.split(':', 1)[0],
    license: null,
    redistribution: 'blocked',
    localRuntime: 'blocked',
    hostedUse: 'blocked',
    approvedOn: null,
    restrictions: {},
  };
};

const sequenceWith = (...clips: Record<string, unknown>[]) => ({
  id: 'seq-main',
  tracks: [{ id: 't-video', kind: 'video', clips }],
});

describe(StudioResourceService.name, () => {
  let sut: StudioResourceService;
  let mocks: ServiceMocks;
  let auth: AuthDto;

  const context = (
    graph: unknown,
    overrides: Partial<StudioProjectResourceContext> = {},
  ): StudioProjectResourceContext => ({
    projectId: newUuid(),
    ownerId: auth.user.id,
    revision: 3,
    graph,
    destination: StudioDestination.Local,
    ...overrides,
  });

  const ownedVideo = (dto: Parameters<typeof AssetFactory.create>[0] = {}) =>
    AssetFactory.create({ ownerId: auth.user.id, type: AssetType.Video, ...dto });

  const allowOwned = (...ids: string[]) => mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(ids));

  beforeEach(async () => {
    ({ sut, mocks } = newTestService(StudioResourceService));
    auth = AuthFactory.create();
    // This existing unit fixture has no lifecycle transitions; derive owners from its asset facts.
    // The actual signed-grant/Trash/restore boundary is qualified separately against canonical PG.
    mocks.integrityReport.sourceEpochs.mockImplementation(async (ids) => {
      const last = mocks.asset.getByIds.mock.results.at(-1)?.value;
      const rows = last ? await last : [];
      return ids.map((assetId) => ({
        assetId,
        ownerId: rows.find((row: { id: string; ownerId: string }) => row.id === assetId)?.ownerId ?? auth.user.id,
        epoch: '0',
      }));
    });
    // These isolated unit assets have no owner-local stream. Preserve the actual mocked
    // asset ownership; PG admission tests cover a real stream and final insertion fences.
    mocks.integrityReport.interactiveAdmissionViews.mockImplementation(async (ids) => {
      // The production observation precedes getByIds; read this fixture's configured rows
      // without recording an extra asset API call or inventing a source owner.
      const configured = mocks.asset.getByIds.getMockImplementation();
      const rows = configured ? await configured(ids) : [];
      return ids.flatMap((assetId) => {
        const asset = rows.find((row: { id: string; ownerId: string }) => row.id === assetId);
        return asset ? [{ assetId, ownerId: asset.ownerId, streamEpoch: null, sequence: '0' }] : [];
      });
    });
    const actual = await vi.importActual<typeof import('src/utils/studio-rights.generated.js')>(
      'src/utils/studio-rights.generated.js',
    );
    for (const key of Object.keys(rightsTable)) {
      delete rightsTable[key];
    }
    Object.assign(rightsTable, actual.studioResourceRights);
  });

  it('canonical complete captions resolve without granting their provenance media bytes', async () => {
    const { manifest } = await sut.resolveProjectResources(
      auth,
      context({
        id: 'main',
        timeline: {
          tracks: [],
          items: [
            {
              id: 'caption',
              type: 'subtitle',
              cues: [{ id: 'cue', startSeconds: 0, endSeconds: 1, text: 'owned immutable caption' }],
              source: { type: 'transcript', mediaId: newUuid(), clipId: 'retired' },
            },
          ],
        },
      }),
    );
    expect(manifest.complete).toBe(true);
    expect(manifest.entries).toEqual([
      expect.objectContaining({ kind: StudioResourceKind.Captions, grant: 'none', checksum: null, path: null }),
    ]);
    expect(mocks.asset.getByIds).not.toHaveBeenCalled();
  });

  it('unused canonical definitions cannot hide cyclic nesting', async () => {
    const { manifest, refused } = await sut.resolveProjectResources(
      auth,
      context({
        id: 'main',
        timeline: {
          tracks: [],
          items: [],
          compositions: [{ id: 'unused', tracks: [], items: [{ type: 'composition', compositionId: 'unused' }] }],
        },
      }),
    );
    expect(manifest.complete).toBe(false);
    expect(refused).toContainEqual(
      expect.objectContaining({
        id: 'unused',
        reason: StudioRefusalReason.CyclicSequence,
        graphPath: '/timeline/compositions/0/items/0',
      }),
    );
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('preconditions', () => {
    it('refuses a cloud destination without explicit consent before touching anything', async () => {
      await expect(
        sut.resolveProjectResources(
          auth,
          context(sequenceWith({ assetId: newUuid() }), { destination: StudioDestination.FrameleafCloud }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.getByIds).not.toHaveBeenCalled();
    });

    it('resolves for a cloud destination only when consent is recorded on the job', async () => {
      const asset = ownedVideo();
      mocks.asset.getByIds.mockResolvedValue([asset]);
      allowOwned(asset.id);

      const { manifest } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: asset.id }), {
          destination: StudioDestination.FrameleafCloud,
          cloudConsent: true,
        }),
      );

      expect(manifest.destination).toBe(StudioDestination.FrameleafCloud);
      expect(manifest.privacy.leavesMachine).toBe(true);
      expect(manifest.complete).toBe(true);
    });

    it('refuses an unknown destination', async () => {
      await expect(
        sut.resolveProjectResources(auth, context({}, { destination: 'usb' as StudioDestination })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an oversized graph before enumerating it', async () => {
      const graph = { padding: 'x'.repeat(STUDIO_MAX_GRAPH_BYTES + 1), assetId: newUuid() };
      await expect(sut.resolveProjectResources(auth, context(graph))).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.getByIds).not.toHaveBeenCalled();
    });

    it('refuses every reference for a shared-link session', async () => {
      const sharedLinkAuth = AuthFactory.from().sharedLink().build();
      const { manifest, refused } = await sut.resolveProjectResources(
        sharedLinkAuth,
        context(sequenceWith({ assetId: newUuid() }, { kind: 'title', style: 'Minimal' })),
      );

      expect(manifest.entries).toEqual([]);
      expect(manifest.complete).toBe(false);
      expect(refused.map((item) => item.reason)).toEqual([
        StudioRefusalReason.SharedLinkSession,
        StudioRefusalReason.SharedLinkSession,
      ]);
      expect(mocks.asset.getByIds).not.toHaveBeenCalled();
    });
  });

  describe('library assets', () => {
    it('authorizes an owned asset with its checksum and original path, for render only', async () => {
      const asset = ownedVideo();
      mocks.asset.getByIds.mockResolvedValue([asset]);
      allowOwned(asset.id);

      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: asset.id })),
      );

      expect(refused).toEqual([]);
      expect(manifest.complete).toBe(true);
      expect(manifest.entries).toEqual([
        expect.objectContaining({
          key: `library-asset:${asset.id}`,
          kind: StudioResourceKind.LibraryAsset,
          ownerId: auth.user.id,
          checksum: asset.checksum.toString('base64'),
          path: asset.originalPath,
          sourceAccess: 'owner',
          grant: 'render',
        }),
      ]);
      expect(manifest.privacy).toEqual({
        includesSharedSources: false,
        includesPersonalData: true,
        originalAccess: false,
        leavesMachine: false,
      });
      expect(manifest.userId).toBe(auth.user.id);
      expect(manifest.digest).toMatch(/^[\da-f]{64}$/);
    });

    it('goes through the library access check for the acting user, not the project owner', async () => {
      const asset = ownedVideo();
      mocks.asset.getByIds.mockResolvedValue([asset]);
      allowOwned(asset.id);

      await sut.resolveProjectResources(auth, context(sequenceWith({ assetId: asset.id }), { ownerId: newUuid() }));

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([asset.id]), undefined);
    });

    it('labels shared album sources so the output inherits their privacy (FL-326: no partner access)', async () => {
      const shared = AssetFactory.create({ ownerId: newUuid(), type: AssetType.Image });
      const partner = AssetFactory.create({ ownerId: newUuid(), type: AssetType.Image });
      mocks.asset.getByIds.mockResolvedValue([shared, partner]);
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([shared.id, partner.id]));

      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: shared.id }, { assetId: partner.id })),
      );

      expect(refused).toEqual([]);
      expect(manifest.entries.map((entry) => entry.sourceAccess)).toEqual(['shared', 'shared']);
      expect(manifest.privacy.includesSharedSources).toBe(true);
    });

    it('refuses Locked media even for an elevated session, and says so only to that owner', async () => {
      const locked = ownedVideo({ visibility: AssetVisibility.Locked });
      mocks.asset.getByIds.mockResolvedValue([locked]);
      allowOwned(locked.id);
      const elevated: AuthDto = { ...auth, session: { id: 'sid', hasElevatedPermission: true } as AuthSession };

      const { manifest, refused } = await sut.resolveProjectResources(
        elevated,
        context(sequenceWith({ assetId: locked.id })),
      );

      expect(manifest.complete).toBe(false);
      expect(refused).toEqual([
        expect.objectContaining({
          id: locked.id,
          kind: StudioResourceKind.LibraryAsset,
          reason: StudioRefusalReason.Locked,
        }),
      ]);
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([locked.id]), true);
    });

    it("places the owner's own marks, detections and old Locked folder items in an unlocked session (FL-195)", async () => {
      const marked = ownedVideo({ visibility: AssetVisibility.Timeline });
      const detected = ownedVideo({ visibility: AssetVisibility.Timeline });
      const legacy = ownedVideo({ visibility: AssetVisibility.Timeline });
      mocks.asset.getByIds.mockResolvedValue([
        { ...marked, isLocked: true },
        { ...detected, isLocked: true },
        { ...legacy, isLocked: true },
      ]);
      mocks.asset.getLockReasons.mockResolvedValue([
        { assetId: marked.id, reason: AssetLockReason.Marked, lockedAt: new Date() },
        { assetId: detected.id, reason: AssetLockReason.Detected, lockedAt: new Date() },
        { assetId: legacy.id, reason: AssetLockReason.ImmichLockedFolder, lockedAt: new Date() },
      ]);
      allowOwned(marked.id, detected.id, legacy.id);
      const elevated: AuthDto = { ...auth, session: { id: 'sid', hasElevatedPermission: true } as AuthSession };

      const { manifest, refused } = await sut.resolveProjectResources(
        elevated,
        context(sequenceWith({ assetId: marked.id }, { assetId: detected.id }, { assetId: legacy.id })),
      );

      expect(manifest.entries.map((entry) => entry.id)).toEqual([marked.id, detected.id, legacy.id]);
      expect(refused).toEqual([]);
    });

    it('keeps a revealed lock in the project but resolves it as missing once the session locks (FL-195)', async () => {
      const marked = ownedVideo({ visibility: AssetVisibility.Timeline });
      mocks.asset.getByIds.mockResolvedValue([{ ...marked, isLocked: true }]);
      mocks.asset.getLockReasons.mockResolvedValue([
        { assetId: marked.id, reason: AssetLockReason.Marked, lockedAt: new Date() },
      ]);
      allowOwned(marked.id);

      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: marked.id })),
      );

      expect(manifest.complete).toBe(false);
      expect(refused).toEqual([
        expect.objectContaining({ id: marked.id, reason: StudioRefusalReason.NotFound, detail: 'No such asset.' }),
      ]);
    });

    it("reports the owner's own Locked media as missing in an ordinary session", async () => {
      const locked = ownedVideo({ visibility: AssetVisibility.Locked });
      const missing = newUuid();
      mocks.asset.getByIds.mockResolvedValue([locked]);

      const { refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: locked.id }, { assetId: missing })),
      );

      expect(refused.map(({ id, reason, detail }) => [id, reason, detail])).toEqual([
        [locked.id, StudioRefusalReason.NotFound, 'No such asset.'],
        [missing, StudioRefusalReason.NotFound, 'No such asset.'],
      ]);
    });

    it("never reports someone else's Locked media as Locked, even to an elevated session", async () => {
      const theirs = AssetFactory.create({
        ownerId: newUuid(),
        type: AssetType.Video,
        visibility: AssetVisibility.Locked,
      });
      mocks.asset.getByIds.mockResolvedValue([theirs]);
      // even if an access path wrongly admitted it, the refusal must not name its Locked state
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([theirs.id]));
      const elevated: AuthDto = { ...auth, session: { id: 'sid', hasElevatedPermission: true } as AuthSession };

      const { refused } = await sut.resolveProjectResources(elevated, context(sequenceWith({ assetId: theirs.id })));

      expect(refused).toEqual([
        expect.objectContaining({ id: theirs.id, reason: StudioRefusalReason.NotFound, detail: 'No such asset.' }),
      ]);
    });

    it('resolves Locked media for a background runner acting as the owner, and only then', async () => {
      const locked = ownedVideo({ visibility: AssetVisibility.Locked });
      mocks.asset.getByIds.mockResolvedValue([locked]);
      allowOwned(locked.id);
      const runner: AuthDto = {
        ...auth,
        session: { id: 'worker-session', hasElevatedPermission: true } as AuthSession,
      };

      const { manifest, refused } = await sut.resolveProjectResources(
        runner,
        context(sequenceWith({ assetId: locked.id }), { backgroundRunner: true }),
      );

      expect(refused).toEqual([]);
      expect(manifest.complete).toBe(true);
      expect(manifest.entries).toEqual([
        expect.objectContaining({ id: locked.id, kind: StudioResourceKind.LibraryAsset, sourceAccess: 'owner' }),
      ]);
      // The same runner auth without the explicit flag is the interactive rule: Locked is refused.
      const interactive = await sut.resolveProjectResources(runner, context(sequenceWith({ assetId: locked.id })));
      expect(interactive.refused.map((item) => item.reason)).toEqual([StudioRefusalReason.Locked]);
    });

    it('refuses trashed, offline, non-media and unknown assets with distinct reasons', async () => {
      const trashed = ownedVideo({ deletedAt: new Date() });
      const offline = ownedVideo({ isOffline: true });
      const audioFile = ownedVideo({ type: AssetType.Audio });
      const missing = newUuid();
      mocks.asset.getByIds.mockResolvedValue([trashed, offline, audioFile]);
      allowOwned(trashed.id, offline.id, audioFile.id);

      const { refused } = await sut.resolveProjectResources(
        auth,
        context(
          sequenceWith(
            { assetId: trashed.id },
            { assetId: offline.id },
            { assetId: audioFile.id },
            { assetId: missing },
          ),
        ),
      );

      expect(refused.map((item) => [item.id, item.reason])).toEqual([
        [trashed.id, StudioRefusalReason.Trashed],
        [offline.id, StudioRefusalReason.Offline],
        [audioFile.id, StudioRefusalReason.UnsupportedMediaType],
        [missing, StudioRefusalReason.NotFound],
      ]);
    });

    it("tells hidden content apart and refuses someone else's unreadable asset like a missing one", async () => {
      const mine = ownedVideo();
      const theirs = AssetFactory.create({ ownerId: newUuid(), type: AssetType.Video });
      const missing = newUuid();
      mocks.asset.getByIds.mockResolvedValue([mine, theirs]);

      const { refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: mine.id }, { assetId: theirs.id }, { assetId: missing })),
      );

      expect(refused.map(({ id, reason, detail }) => [id, reason, detail])).toEqual([
        [mine.id, StudioRefusalReason.HiddenContent, expect.any(String)],
        [theirs.id, StudioRefusalReason.NotFound, 'No such asset.'],
        [missing, StudioRefusalReason.NotFound, 'No such asset.'],
      ]);
    });

    it("never reveals that someone else's unreadable asset is trashed, offline or not media", async () => {
      const owner = newUuid();
      const trashed = AssetFactory.create({ ownerId: owner, type: AssetType.Video, deletedAt: new Date() });
      const offline = AssetFactory.create({ ownerId: owner, type: AssetType.Video, isOffline: true });
      const audioFile = AssetFactory.create({ ownerId: owner, type: AssetType.Audio });
      mocks.asset.getByIds.mockResolvedValue([trashed, offline, audioFile]);

      const { refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: trashed.id }, { assetId: offline.id }, { assetId: audioFile.id })),
      );

      expect(refused.map(({ reason, detail }) => [reason, detail])).toEqual([
        [StudioRefusalReason.NotFound, 'No such asset.'],
        [StudioRefusalReason.NotFound, 'No such asset.'],
        [StudioRefusalReason.NotFound, 'No such asset.'],
      ]);
      expect(mocks.access.asset.checkAlbumAccess).toHaveBeenCalledWith(
        auth.user.id,
        new Set([trashed.id, offline.id, audioFile.id]),
      );
    });

    it('refuses an id that is not a UUID without querying', async () => {
      const { refused } = await sut.resolveProjectResources(auth, context(sequenceWith({ assetId: 'clip-hiking' })));
      expect(refused).toEqual([expect.objectContaining({ id: 'clip-hiking', reason: StudioRefusalReason.InvalidId })]);
      expect(mocks.asset.getByIds).not.toHaveBeenCalled();
    });

    it('carries graph violations into the refusal list', async () => {
      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ kind: 'video', src: 'blob:https://app/x' })),
      );
      expect(manifest.complete).toBe(false);
      expect(refused).toEqual([
        expect.objectContaining({
          kind: null,
          reason: StudioRefusalReason.ExternalLocator,
          graphPath: '/tracks/0/clips/0',
        }),
      ]);
    });
  });

  describe('decode qualification (FL-101)', () => {
    const stream = (assetId: string, overrides: Record<string, unknown> = {}) => ({
      assetId,
      codecName: 'hevc',
      pixelFormat: 'yuv420p10le',
      colorTransfer: 16,
      dvProfile: null,
      dvBlSignalCompatibilityId: null,
      ...overrides,
    });

    it('refuses a placed video the renderer cannot decode, with the code and reason, and admits a qualified one', async () => {
      const profile7 = ownedVideo({ width: 3840, height: 2160 });
      const deep = ownedVideo({ width: 1920, height: 1080 });
      const qualified = ownedVideo({ width: 1920, height: 1080 });
      mocks.asset.getByIds.mockResolvedValue([profile7, deep, qualified]);
      allowOwned(profile7.id, deep.id, qualified.id);
      mocks.asset.getVideoStreamsForDecode.mockResolvedValue([
        stream(profile7.id, { dvProfile: 7, dvBlSignalCompatibilityId: 6 }),
        stream(deep.id, { pixelFormat: 'yuv444p16le' }),
        stream(qualified.id),
      ] as never);

      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: profile7.id }, { assetId: deep.id }, { assetId: qualified.id })),
      );

      expect(manifest.complete).toBe(false);
      expect(manifest.entries.map((entry) => entry.id)).toEqual([qualified.id]);
      expect(refused).toEqual([
        expect.objectContaining({
          kind: StudioResourceKind.LibraryAsset,
          id: profile7.id,
          reason: StudioRefusalReason.UnsupportedSource,
          decodeRefusal: 'dolbyVisionEnhancementLayer',
          detail: expect.stringContaining('Dolby Vision profile 7'),
        }),
        expect.objectContaining({
          id: deep.id,
          reason: StudioRefusalReason.UnsupportedSource,
          decodeRefusal: 'unsupportedBitDepth',
        }),
      ]);
      expect(mocks.asset.getVideoStreamsForDecode).toHaveBeenCalledWith(
        expect.arrayContaining([profile7.id, deep.id, qualified.id]),
      );
    });

    it('judges only what the library recorded: no stream row, or no recorded size, is not refused', async () => {
      const unextracted = ownedVideo({ width: 1920, height: 1080 });
      const sizeUnknown = ownedVideo({ width: null, height: null });
      const noGeometry = ownedVideo({ width: 0, height: 0 });
      mocks.asset.getByIds.mockResolvedValue([unextracted, sizeUnknown, noGeometry]);
      allowOwned(unextracted.id, sizeUnknown.id, noGeometry.id);
      mocks.asset.getVideoStreamsForDecode.mockResolvedValue([stream(sizeUnknown.id), stream(noGeometry.id)] as never);

      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: unextracted.id }, { assetId: sizeUnknown.id }, { assetId: noGeometry.id })),
      );

      expect(manifest.entries.map((entry) => entry.id)).toEqual([unextracted.id, sizeUnknown.id]);
      expect(refused).toEqual([expect.objectContaining({ id: noGeometry.id, decodeRefusal: 'unusableGeometry' })]);
    });

    it('does not decode stills, audio taken from a video, or sources the person cannot read', async () => {
      const still = ownedVideo({ type: AssetType.Image });
      const soundtrack = ownedVideo();
      mocks.asset.getByIds.mockResolvedValue([still, soundtrack]);
      allowOwned(still.id, soundtrack.id);

      const { refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: still.id }, { kind: 'audio', assetId: soundtrack.id }, { assetId: newUuid() })),
      );

      expect(mocks.asset.getVideoStreamsForDecode).not.toHaveBeenCalled();
      expect(refused.map((item) => item.reason)).toEqual([StudioRefusalReason.NotFound]);
    });
  });

  describe('HDR sources (FL-97)', () => {
    const stream = (assetId: string, overrides: Record<string, unknown> = {}) => ({
      assetId,
      codecName: 'hevc',
      pixelFormat: 'yuv420p10le',
      colorTransfer: 1,
      dvProfile: null,
      dvBlSignalCompatibilityId: null,
      ...overrides,
    });

    it('names library videos whose original is PQ, HLG or Dolby Vision, sorted and once each', async () => {
      const [sdr, pq, hlg, dolby] = [newUuid(), newUuid(), newUuid(), newUuid()];
      mocks.asset.getVideoStreamsForDecode.mockResolvedValue([
        stream(sdr),
        stream(pq, { colorTransfer: ColorTransfer.Smpte2084 }),
        stream(hlg, { colorTransfer: ColorTransfer.AribStdB67 }),
        stream(dolby, { dvProfile: 8 }),
      ] as never);

      await expect(sut.hdrLibraryAssets([sdr, pq, hlg, dolby, pq, 'not-a-uuid'])).resolves.toEqual(
        [pq, hlg, dolby].toSorted(),
      );
      expect(mocks.asset.getVideoStreamsForDecode).toHaveBeenCalledWith([sdr, pq, hlg, dolby]);
    });

    it('asks nothing when no library asset is placed', async () => {
      await expect(sut.hdrLibraryAssets([])).resolves.toEqual([]);
      expect(mocks.asset.getVideoStreamsForDecode).not.toHaveBeenCalled();
    });

    const projectOwner = newUuid();
    const personal = { ownerId: projectOwner, sharedSpace: false };

    it('names the HDR sources whose current intermediate is on disk and queues only what needs making', async () => {
      const [ready, none, lost, stale, edited, ineligible, failedToday, failedLongAgo] = Array.from({ length: 8 }, () =>
        newUuid(),
      );
      const state = (assetId: string, overrides: Record<string, unknown> = {}) => ({
        assetId,
        ownerId: projectOwner,
        edited: false,
        current: true,
        status: 'ready',
        path: `/${assetId}.mp4`,
        createdAt: new Date(),
        ...overrides,
      });
      mocks.asset.getStudioHdrIntermediateStates.mockResolvedValue([
        state(ready),
        state(none, { current: false, status: null, path: null, createdAt: null }),
        state(lost),
        state(stale, { current: false }),
        state(edited, { edited: true, current: false, status: null, path: null }),
        state(ineligible, { status: 'ineligible', path: null }),
        state(failedToday, { status: 'failed', path: null }),
        state(failedLongAgo, { status: 'failed', path: null, createdAt: new Date(Date.now() - 2 * 86_400_000) }),
      ] as never);
      mocks.storage.checkFileExists.mockImplementation((path: string) => Promise.resolve(path !== `/${lost}.mp4`));

      await expect(sut.studioHdrProxies([ready, none, lost, ready, 'not-a-uuid'], personal)).resolves.toEqual([ready]);
      expect(mocks.asset.getStudioHdrIntermediateStates).toHaveBeenCalledWith([ready, none, lost]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith(
        [none, lost, stale, failedLongAgo].map((id) => ({ name: JobName.StudioHdrProxyGenerate, data: { id } })),
      );
      expect(mocks.asset.touchStudioHdrIntermediates).toHaveBeenCalledWith([ready]);
    });

    // Owner decision (FL-97, 2026-09-29)
    describe("only for the asset owner's own projects and shared-space projects", () => {
      const partner = newUuid();
      const [own, partners, partnersMissing] = [newUuid(), newUuid(), newUuid()];
      const states = () =>
        [
          { assetId: own, ownerId: projectOwner, missing: false },
          { assetId: partners, ownerId: partner, missing: false },
          { assetId: partnersMissing, ownerId: partner, missing: true },
        ].map(({ assetId, ownerId, missing }) => ({
          assetId,
          ownerId,
          edited: false,
          current: !missing,
          status: missing ? null : 'ready',
          path: missing ? null : `/${assetId}.mp4`,
          createdAt: missing ? null : new Date(),
        }));

      it("never makes, queues or offers one for someone else's clip in a personal project", async () => {
        mocks.asset.getStudioHdrIntermediateStates.mockResolvedValue(states() as never);
        mocks.storage.checkFileExists.mockResolvedValue(true);

        // An existing intermediate (made for the partner's own project) is not offered either.
        await expect(sut.studioHdrProxies([own, partners, partnersMissing], personal)).resolves.toEqual([own]);
        expect(mocks.job.queueAll).not.toHaveBeenCalled();
        expect(mocks.asset.touchStudioHdrIntermediates).toHaveBeenCalledWith([own]);
      });

      it("makes and offers them for every placed owner's clip in a shared-space project", async () => {
        mocks.asset.getStudioHdrIntermediateStates.mockResolvedValue(states() as never);
        mocks.storage.checkFileExists.mockResolvedValue(true);

        await expect(
          sut.studioHdrProxies([own, partners, partnersMissing], { ownerId: projectOwner, sharedSpace: true }),
        ).resolves.toEqual([own, partners].toSorted());
        expect(mocks.job.queueAll).toHaveBeenCalledWith([
          { name: JobName.StudioHdrProxyGenerate, data: { id: partnersMissing } },
        ]);
      });
    });

    it('queues nothing when no HDR candidates were supplied', async () => {
      await expect(sut.studioHdrProxies([], personal)).resolves.toEqual([]);
      expect(mocks.asset.getStudioHdrIntermediateStates).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });

  describe('audio', () => {
    it('resolves an audio clip of a library video as that video and refuses a still', async () => {
      const video = ownedVideo();
      const still = ownedVideo({ type: AssetType.Image });
      mocks.asset.getByIds.mockResolvedValue([video, still]);
      allowOwned(video.id, still.id);

      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ kind: 'audio', assetId: video.id }, { kind: 'audio', assetId: still.id })),
      );

      expect(manifest.entries.filter((entry) => entry.kind === StudioResourceKind.Audio)).toEqual([
        expect.objectContaining({ id: video.id, source: 'asset', path: video.originalPath, grant: 'render' }),
      ]);
      expect(refused).toEqual([
        expect.objectContaining({
          kind: StudioResourceKind.Audio,
          id: still.id,
          reason: StudioRefusalReason.UnsupportedMediaType,
        }),
      ]);
    });

    it('resolves bundled tracks only from the catalogue', async () => {
      const graph = sequenceWith({ kind: 'music', musicId: 'mountain-dreams' });

      const bare = await sut.resolveProjectResources(auth, context(graph));
      expect(bare.refused).toEqual([
        expect.objectContaining({ id: 'mountain-dreams', reason: StudioRefusalReason.NotBundled }),
      ]);

      const bundled = await sut.resolveProjectResources(
        auth,
        context(graph, {
          catalog: {
            fonts: {},
            luts: {},
            models: {},
            audio: { 'mountain-dreams': { path: '/bundle/md.flac', checksum: 'abc' } },
          },
        }),
      );
      // Bundled is not enough: a track with no approved rights row is refused by name (FL-86).
      expect(bundled.refused).toEqual([
        expect.objectContaining({ id: 'mountain-dreams', reason: StudioRefusalReason.RightsBlocked }),
      ]);
      expect(bundled.refused[0].detail).toContain('audio:mountain-dreams');

      admit('audio:mountain-dreams');
      const approved = await sut.resolveProjectResources(
        auth,
        context(graph, {
          catalog: {
            fonts: {},
            luts: {},
            models: {},
            audio: { 'mountain-dreams': { path: '/bundle/md.flac', checksum: 'abc' } },
          },
        }),
      );
      expect(approved.refused).toEqual([]);
      const bundledEntries = approved;
      expect(bundledEntries.manifest.entries).toEqual([
        expect.objectContaining({
          kind: StudioResourceKind.Audio,
          source: 'catalog',
          path: '/bundle/md.flac',
          sourceAccess: 'deployment',
        }),
      ]);
    });
  });

  describe('edited masters', () => {
    it('authorizes the owner through the asset-file access check', async () => {
      const asset = ownedVideo();
      const master = AssetFileFactory.create({
        assetId: asset.id,
        type: AssetFileType.EncodedVideo,
        isEdited: true,
        path: '/enc/x_edited.mp4',
      });
      mocks.asset.getByIds.mockResolvedValue([asset]);
      allowOwned(asset.id);
      mocks.assetFile.search.mockResolvedValue([master]);
      mocks.access.assetFile.checkOwnerAccess.mockResolvedValue(new Set([master.id]));

      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ editedMasterOf: asset.id })),
      );

      expect(refused).toEqual([]);
      expect(mocks.assetFile.search).toHaveBeenCalledWith({ assetId: asset.id, isEdited: true });
      expect(manifest.entries).toEqual([
        expect.objectContaining({
          kind: StudioResourceKind.EditedMaster,
          path: '/enc/x_edited.mp4',
          sourceAccess: 'owner',
          grant: 'render',
        }),
      ]);
    });

    it('never reaches an edited master through shared access', async () => {
      const theirs = AssetFactory.create({ ownerId: newUuid(), type: AssetType.Video });
      mocks.asset.getByIds.mockResolvedValue([theirs]);
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([theirs.id]));

      const { refused } = await sut.resolveProjectResources(auth, context(sequenceWith({ editedMasterOf: theirs.id })));

      expect(refused).toEqual([
        expect.objectContaining({ kind: StudioResourceKind.EditedMaster, reason: StudioRefusalReason.NoAccess }),
      ]);
      expect(mocks.assetFile.search).not.toHaveBeenCalled();
    });

    it('refuses when no master has been rendered', async () => {
      const asset = ownedVideo();
      mocks.asset.getByIds.mockResolvedValue([asset]);
      allowOwned(asset.id);
      mocks.assetFile.search.mockResolvedValue([
        AssetFileFactory.create({ assetId: asset.id, type: AssetFileType.Thumbnail, isEdited: true }),
      ]);

      const { refused } = await sut.resolveProjectResources(auth, context(sequenceWith({ editedMasterOf: asset.id })));

      expect(refused).toEqual([
        expect.objectContaining({ kind: StudioResourceKind.EditedMaster, reason: StudioRefusalReason.NotFound }),
      ]);
    });
  });

  describe('restored versions (FL-115)', () => {
    const restoration = (overrides: Partial<AssetRestoration> = {}) =>
      ({
        id: newUuid(),
        assetId: newUuid(),
        ownerId: auth.user.id,
        status: AssetRestorationStatus.Restored,
        resultPath: '/thumbs/restorations/result.mp4',
        resultExpiresAt: null,
        isCurrent: false,
        ...overrides,
      }) as AssetRestoration;

    const withRestoration = (overrides: Partial<AssetRestoration> = {}, assetOverrides = {}) => {
      const asset = ownedVideo(assetOverrides);
      const row = restoration({ assetId: asset.id, ...overrides });
      mocks.asset.getByIds.mockResolvedValue([asset]);
      allowOwned(asset.id);
      mocks.assetRestoration.get.mockImplementation((id) => Promise.resolve(id === row.id ? row : undefined));
      return { asset, row };
    };

    it('places the owner’s finished restoration named by its bin id, reading the restored file', async () => {
      const { asset, row } = withRestoration();

      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ kind: 'video', mediaId: studioRestoredMediaId(row.id) })),
      );

      expect(refused).toEqual([]);
      expect(manifest.complete).toBe(true);
      expect(mocks.assetRestoration.get).toHaveBeenCalledWith(row.id);
      expect(manifest.entries).toEqual([
        expect.objectContaining({
          key: `restored-version:${row.id}`,
          kind: StudioResourceKind.RestoredVersion,
          id: row.id,
          ownerId: auth.user.id,
          path: row.resultPath,
          sourceAccess: 'owner',
          grant: 'render',
          assetId: asset.id,
        }),
      ]);
    });

    it('places it by an explicit restorationId too', async () => {
      const { row } = withRestoration();
      const { manifest } = await sut.resolveProjectResources(auth, context(sequenceWith({ restorationId: row.id })));
      expect(manifest.entries).toEqual([expect.objectContaining({ kind: StudioResourceKind.RestoredVersion })]);
    });

    it('never replaces the original: both can sit in one project, each reading its own file', async () => {
      const { asset, row } = withRestoration();

      const { manifest } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ mediaId: asset.id }, { mediaId: studioRestoredMediaId(row.id) })),
      );

      expect(manifest.entries.map((entry) => [entry.kind, entry.path])).toEqual([
        [StudioResourceKind.LibraryAsset, asset.originalPath],
        [StudioResourceKind.RestoredVersion, row.resultPath],
      ]);
    });

    it('never inherits the playback choice: a clip of the original stays the original', async () => {
      withRestoration({ isCurrent: true });
      const asset = (await mocks.asset.getByIds([]))[0];

      const { manifest } = await sut.resolveProjectResources(auth, context(sequenceWith({ mediaId: asset.id })));

      expect(manifest.entries).toEqual([
        expect.objectContaining({ kind: StudioResourceKind.LibraryAsset, path: asset.originalPath }),
      ]);
      expect(mocks.assetRestoration.get).not.toHaveBeenCalled();
      expect(mocks.assetRestoration.listRestoredForPlayback).not.toHaveBeenCalled();
    });

    it.each([
      ['discarded', AssetRestorationStatus.Discarded, {}, StudioRefusalReason.RestorationDiscarded],
      ['expired', AssetRestorationStatus.Expired, {}, StudioRefusalReason.RestorationExpired],
      [
        'past-retention',
        AssetRestorationStatus.Restored,
        { resultExpiresAt: new Date('2020-01-01') },
        StudioRefusalReason.RestorationExpired,
      ],
      ['file-removed', AssetRestorationStatus.Restored, { resultPath: null }, StudioRefusalReason.RestorationExpired],
      ['preview-only', AssetRestorationStatus.PreviewReady, {}, StudioRefusalReason.RestorationNotReady],
      ['still-rendering', AssetRestorationStatus.Restoring, {}, StudioRefusalReason.RestorationNotReady],
    ])('fails visibly for a %s restoration and never falls back to the original', async (_, status, extra, reason) => {
      const { row } = withRestoration({ status, ...extra });

      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ mediaId: studioRestoredMediaId(row.id) })),
      );

      expect(refused).toEqual([
        expect.objectContaining({ kind: StudioResourceKind.RestoredVersion, id: row.id, reason }),
      ]);
      expect(manifest.complete).toBe(false);
      expect(manifest.entries).toEqual([]);
      expect(() => sut.assertAuthorizedManifest(manifest)).toThrow(BadRequestException);
    });

    it('answers someone else’s restoration exactly like a missing one, even with album access to the original', async () => {
      const theirs = AssetFactory.create({ ownerId: newUuid(), type: AssetType.Video });
      const row = restoration({ assetId: theirs.id, ownerId: theirs.ownerId });
      mocks.asset.getByIds.mockResolvedValue([theirs]);
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([theirs.id]));
      mocks.assetRestoration.get.mockResolvedValue(row);

      const { refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ mediaId: studioRestoredMediaId(row.id) })),
      );

      expect(refused).toEqual([
        expect.objectContaining({ kind: StudioResourceKind.RestoredVersion, reason: StudioRefusalReason.NotFound }),
      ]);
      expect(mocks.asset.getByIds).not.toHaveBeenCalled();
    });

    it('keeps a shared project private: a reviewer is refused the owner’s restored version', async () => {
      const { row } = withRestoration();
      const reviewer = AuthFactory.create();

      const { manifest, refused } = await sut.resolveProjectResources(reviewer, {
        ...context(sequenceWith({ mediaId: studioRestoredMediaId(row.id) })),
        ownerId: auth.user.id,
      });

      expect(manifest.complete).toBe(false);
      expect(manifest.entries).toEqual([]);
      expect(refused).toEqual([
        expect.objectContaining({ reason: StudioRefusalReason.NotFound, detail: 'No such restored version.' }),
      ]);
    });

    it('applies the original’s Locked, trashed and hidden decisions to its restored versions', async () => {
      const { row } = withRestoration({}, { visibility: AssetVisibility.Locked });
      const elevated: AuthDto = { ...auth, session: { id: 'sid', hasElevatedPermission: true } as AuthSession };
      const graph = sequenceWith({ mediaId: studioRestoredMediaId(row.id) });

      // an ordinary session does not learn that the original is Locked
      expect((await sut.resolveProjectResources(auth, context(graph))).refused).toEqual([
        expect.objectContaining({ reason: StudioRefusalReason.NotFound }),
      ]);
      expect((await sut.resolveProjectResources(elevated, context(graph))).refused).toEqual([
        expect.objectContaining({ reason: StudioRefusalReason.Locked }),
      ]);
      // a render the owner already submitted still reads it
      expect(
        (await sut.resolveProjectResources(elevated, context(graph, { backgroundRunner: true }))).manifest.complete,
      ).toBe(true);

      mocks.asset.getByIds.mockResolvedValue([ownedVideo({ id: row.assetId, deletedAt: new Date() })]);
      expect((await sut.resolveProjectResources(auth, context(graph))).refused).toEqual([
        expect.objectContaining({ reason: StudioRefusalReason.Trashed }),
      ]);

      mocks.asset.getByIds.mockResolvedValue([ownedVideo({ id: row.assetId })]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      expect((await sut.resolveProjectResources(auth, context(graph))).refused).toEqual([
        expect.objectContaining({ reason: StudioRefusalReason.HiddenContent }),
      ]);
    });

    it('refuses a malformed restored id instead of guessing', async () => {
      const { refused } = await sut.resolveProjectResources(auth, context(sequenceWith({ mediaId: 'restored-nope' })));
      expect(refused).toEqual([expect.objectContaining({ reason: StudioRefusalReason.InvalidId })]);
      expect(mocks.assetRestoration.get).not.toHaveBeenCalled();
    });

    it('refuses every reference for a shared-link session', async () => {
      const { row } = withRestoration();
      const shared = AuthFactory.from().sharedLink().build();
      const { refused } = await sut.resolveProjectResources(
        shared,
        context(sequenceWith({ mediaId: studioRestoredMediaId(row.id) })),
      );
      expect(refused).toEqual([expect.objectContaining({ reason: StudioRefusalReason.SharedLinkSession })]);
    });

    it('issues a render grant for the restored file and re-decides it on every open', async () => {
      const { asset, row } = withRestoration();
      const { manifest } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ mediaId: studioRestoredMediaId(row.id) })),
      );
      const [grant] = sut.issueReadGrants(manifest, { workerId: 'worker-1' });
      expect(grant).toEqual(
        expect.objectContaining({ kind: StudioResourceKind.RestoredVersion, id: row.id, path: row.resultPath }),
      );

      const payload = (mocks.crypto.signJwt.mock.calls.at(-1)?.[0] ?? {}) as StudioReadGrantPayload;
      mocks.crypto.verifyJwt.mockReturnValue(payload);
      await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual({
        valid: true,
        grant: payload,
        path: row.resultPath,
      });

      // discarded after the grant was issued: the next open is refused, the original is not served
      mocks.assetRestoration.get.mockResolvedValue({
        ...row,
        status: AssetRestorationStatus.Discarded,
        resultPath: null,
      });
      await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
        expect.objectContaining({ valid: false, reason: StudioRefusalReason.RestorationDiscarded }),
      );
      expect(asset.originalPath).not.toBe(row.resultPath);
    });

    describe('getRestoredVersion (the media bin entry)', () => {
      it('describes the owner’s finished restoration as its own version with its bin media id', async () => {
        const { asset, row } = withRestoration({
          outputWidth: 3840,
          outputHeight: 2160,
          sourceDurationSeconds: 12.5,
          sourceType: 'video',
          mode: 'faithful',
          upscale: 2,
        });
        mocks.asset.getById.mockResolvedValue(asset as never);

        await expect(sut.getRestoredVersion(auth, row.id)).resolves.toEqual(
          expect.objectContaining({
            restorationId: row.id,
            assetId: asset.id,
            mediaId: `restored-${row.id}`,
            available: true,
            unavailable: null,
            width: 3840,
            height: 2160,
            durationSeconds: 12.5,
            upscale: 2,
            smoothMotionFactor: null,
            originalFileName: asset.originalFileName,
          }),
        );
      });

      it('tells the owner why a discarded or expired one cannot be placed', async () => {
        const { asset, row } = withRestoration({ status: AssetRestorationStatus.Discarded, resultPath: null });
        mocks.asset.getById.mockResolvedValue(asset as never);
        await expect(sut.getRestoredVersion(auth, row.id)).resolves.toEqual(
          expect.objectContaining({ available: false, unavailable: 'discarded' }),
        );
        mocks.assetRestoration.get.mockResolvedValue({ ...row, status: AssetRestorationStatus.Expired });
        await expect(sut.getRestoredVersion(auth, row.id)).resolves.toEqual(
          expect.objectContaining({ available: false, unavailable: 'expired' }),
        );
      });

      it('is not found for anyone else, and for a Locked original outside an elevated session', async () => {
        const { row } = withRestoration({}, { visibility: AssetVisibility.Locked });
        await expect(sut.getRestoredVersion(AuthFactory.create(), row.id)).rejects.toBeInstanceOf(NotFoundException);
        await expect(sut.getRestoredVersion(auth, row.id)).rejects.toBeInstanceOf(NotFoundException);
        await expect(sut.getRestoredVersion(auth, newUuid())).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('binds the preview to the original and to the restoration, and stops it once it expires', async () => {
      const { asset, row } = withRestoration();
      const { manifest } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ mediaId: studioRestoredMediaId(row.id) })),
      );
      sut.issuePreviewGrant(manifest, { workerId: 'worker-1' });
      const preview = mocks.crypto.signJwt.mock.calls.at(-1)?.[0] as StudioReadGrantPayload;
      expect(preview).toEqual(expect.objectContaining({ assetIds: [asset.id], restorationIds: [row.id] }));

      mocks.crypto.verifyJwt.mockReturnValue(preview);
      await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
        expect.objectContaining({ valid: true }),
      );
      mocks.assetRestoration.get.mockResolvedValue({ ...row, status: AssetRestorationStatus.Expired });
      await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
        expect.objectContaining({ valid: false, reason: StudioRefusalReason.RestorationExpired }),
      );
    });
  });

  describe('project imports, captions, LUTs and graphics', () => {
    it('matches complete Lottie dependencies against authorized parent and child byte snapshots', async () => {
      const parentId = newUuid();
      const childId = newUuid();
      const animation = Buffer.from(
        JSON.stringify({ v: '5', layers: [], assets: [{ p: 'outside.png', u: 'https://uncontrolled/' }] }),
      );
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64',
      );
      const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      const bindings = [
        {
          parent: { kind: 'vector-graphic', id: parentId, checksum: hash(animation) },
          location: { format: 'lottie-json', entry: null, pointer: '/assets/0/p', role: 'image' },
          child: { kind: 'project-import', id: childId, checksum: hash(png) },
        },
      ];
      const graph = { graphicId: parentId, studioVectorDependencies: { version: 1, bindings } };
      const declarations = [
        {
          id: parentId,
          contentType: 'application/json',
          checksum: hash(animation),
          path: '/parent',
          sizeBytes: animation.length,
          externalReferences: 1,
        },
        { id: childId, contentType: 'image/png', checksum: hash(png), path: '/child', sizeBytes: png.length },
      ];
      const close = vi.fn(async () => {});
      mocks.storage.openForRandomRead.mockImplementation((path) => {
        const bytes = path === '/parent' ? animation : png;
        return Promise.resolve({ size: bytes.length, read: () => Promise.resolve(Buffer.from(bytes)), close });
      });
      const result = await sut.resolveProjectResources(auth, context(graph, { imports: declarations }));
      expect(result.manifest.complete).toBe(true);
      expect(result.refused).toEqual([]);
      expect(result.manifest.entries.map((entry) => entry.key)).toEqual([
        `vector-graphic:${parentId}`,
        `project-import:${childId}`,
      ]);
      expect(close).toHaveBeenCalledTimes(2);
      expect(mocks.asset.getByIds).not.toHaveBeenCalled();
      // The library namespace is never silently redirected to the identically named import.
      const wrong = structuredClone(graph);
      wrong.studioVectorDependencies.bindings[0].child.kind = 'library-asset';
      const refused = await sut.resolveProjectResources(auth, context(wrong, { imports: declarations }));
      expect(refused.manifest.complete).toBe(false);
      expect(refused.refused).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: StudioResourceKind.LibraryAsset })]),
      );
      // A newly read byte snapshot must still match after authorization.
      mocks.storage.openForRandomRead.mockResolvedValue({
        size: 4,
        read: () => Promise.resolve(Buffer.from('evil')),
        close,
      });
      const changed = await sut.resolveProjectResources(auth, context(graph, { imports: declarations }));
      expect(changed.manifest.complete).toBe(false);
      expect(changed.refused).toEqual(
        expect.arrayContaining([expect.objectContaining({ reason: StudioRefusalReason.RemoteSubresource })]),
      );
    });

    const imports = [
      { id: 'voice-1', contentType: 'audio/wav', checksum: 'v1', sizeBytes: 10, path: '/projects/p/voice-1.wav' },
      { id: 'unfinished', contentType: 'audio/wav', checksum: null, sizeBytes: 0, path: '/projects/p/unfinished.wav' },
      {
        id: 'clean-svg',
        contentType: 'image/svg+xml',
        checksum: 's1',
        sizeBytes: 10,
        path: '/projects/p/a.svg',
        externalReferences: 0,
      },
      {
        id: 'hot-svg',
        contentType: 'image/svg+xml',
        checksum: 's2',
        sizeBytes: 10,
        path: '/projects/p/b.svg',
        externalReferences: 2,
      },
      { id: 'unscanned-svg', contentType: 'image/svg+xml', checksum: 's3', sizeBytes: 10, path: '/projects/p/c.svg' },
      {
        id: 'not-a-graphic',
        contentType: 'image/png',
        checksum: 's4',
        sizeBytes: 10,
        path: '/projects/p/d.png',
        externalReferences: 0,
      },
      { id: 'warm', contentType: 'text/x-cube-lut', checksum: 'l1', sizeBytes: 10, path: '/projects/p/warm.cube' },
      { id: 'subs', contentType: 'text/vtt', checksum: 'c1', sizeBytes: 10, path: '/projects/p/subs.vtt' },
      { id: 'subs-srt', contentType: 'application/x-subrip', checksum: 'c2', sizeBytes: 10, path: '/projects/p/s.srt' },
      { id: 'notes', contentType: 'text/plain', checksum: 'n1', sizeBytes: 10, path: '/projects/p/notes.txt' },
    ];

    it('uses a caption file only as captions and a .cube file only as a LUT (FL-105)', async () => {
      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(
          sequenceWith(
            { kind: 'title', captionsImportId: 'subs-srt' },
            { kind: 'title', captionsImportId: 'warm' },
            { kind: 'title', captionsImportId: 'notes' },
            { grade: { lutId: 'subs', lutSource: 'import' } },
            { grade: { lutId: 'notes', lutSource: 'import' } },
          ),
          { imports },
        ),
      );
      expect(manifest.entries.map((entry) => [entry.kind, entry.id])).toEqual([
        [StudioResourceKind.Captions, 'subs-srt'],
      ]);
      expect(refused.map((item) => [item.kind, item.id, item.reason])).toEqual([
        [StudioResourceKind.Captions, 'warm', StudioRefusalReason.UnsupportedMediaType],
        [StudioResourceKind.Captions, 'notes', StudioRefusalReason.UnsupportedMediaType],
        [StudioResourceKind.Lut, 'subs', StudioRefusalReason.UnsupportedMediaType],
        [StudioResourceKind.Lut, 'notes', StudioRefusalReason.UnsupportedMediaType],
      ]);
    });

    it('authorizes declared imports as project-owned render inputs and refuses the rest', async () => {
      const owner = newUuid();
      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(
          sequenceWith(
            { kind: 'voice', uploadId: 'voice-1' },
            { kind: 'voice', uploadId: 'unfinished' },
            { kind: 'voice', uploadId: 'nowhere' },
          ),
          { ownerId: owner, imports },
        ),
      );

      const authorized = manifest.entries.map((entry) => [
        entry.kind,
        entry.id,
        entry.ownerId,
        entry.path,
        entry.checksum,
      ]);
      expect(authorized).toEqual([
        [StudioResourceKind.ProjectImport, 'voice-1', owner, '/projects/p/voice-1.wav', 'v1'],
        [StudioResourceKind.Audio, 'voice-1', owner, '/projects/p/voice-1.wav', 'v1'],
      ]);
      expect(refused.map((item) => [item.kind, item.id, item.reason])).toEqual([
        [StudioResourceKind.ProjectImport, 'unfinished', StudioRefusalReason.ChecksumMismatch],
        [StudioResourceKind.Audio, 'unfinished', StudioRefusalReason.ChecksumMismatch],
        [StudioResourceKind.ProjectImport, 'nowhere', StudioRefusalReason.UndeclaredImport],
        [StudioResourceKind.Audio, 'nowhere', StudioRefusalReason.UndeclaredImport],
      ]);
    });

    it('accepts only scanned graphics with zero external subresources', async () => {
      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(
          sequenceWith(
            { kind: 'overlay', graphicId: 'clean-svg' },
            { kind: 'overlay', graphicId: 'hot-svg' },
            { kind: 'overlay', graphicId: 'unscanned-svg' },
            { kind: 'overlay', graphicId: 'not-a-graphic' },
          ),
          { imports },
        ),
      );

      expect(manifest.entries.map((entry) => entry.id)).toEqual(['clean-svg']);
      expect(refused.map((item) => [item.id, item.reason])).toEqual([
        ['hot-svg', StudioRefusalReason.RemoteSubresource],
        ['unscanned-svg', StudioRefusalReason.RemoteSubresource],
        ['not-a-graphic', StudioRefusalReason.UnsupportedMediaType],
      ]);
    });

    it('resolves an editor media id the project declares as an import to that import (FL-103 / FL-105)', async () => {
      const owner = newUuid();
      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(
          sequenceWith(
            { kind: 'voice', mediaId: 'voice-1' },
            { kind: 'voice', mediaId: 'voice-1' },
            { kind: 'overlay', mediaId: 'hot-svg' },
            { kind: 'overlay', importId: 'hot-svg' },
            { kind: 'overlay', mediaId: 'clean-svg' },
          ),
          { ownerId: owner, imports },
        ),
      );

      // Never looked up as a library asset, and one entry per import however often it is placed.
      expect(mocks.asset.getByIds).not.toHaveBeenCalled();
      expect(manifest.entries.map((entry) => [entry.kind, entry.id, entry.path])).toEqual([
        [StudioResourceKind.ProjectImport, 'voice-1', '/projects/p/voice-1.wav'],
        [StudioResourceKind.Audio, 'voice-1', '/projects/p/voice-1.wav'],
        [StudioResourceKind.ProjectImport, 'clean-svg', '/projects/p/a.svg'],
      ]);
      // A graphic with external subresources is refused however the graph names it.
      expect(refused.map((item) => [item.kind, item.id, item.reason])).toEqual([
        [StudioResourceKind.ProjectImport, 'hot-svg', StudioRefusalReason.RemoteSubresource],
      ]);
    });

    it('refuses a graphic with external subresources and a mismatched type on every import path', async () => {
      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(
          sequenceWith(
            { kind: 'voice', uploadId: 'hot-svg' },
            { kind: 'title', captionsImportId: 'not-a-graphic' },
            { kind: 'voice', uploadId: 'not-a-graphic' },
          ),
          { imports },
        ),
      );
      expect(manifest.entries.filter((entry) => entry.kind !== StudioResourceKind.ProjectImport)).toEqual([]);
      expect(refused.map((item) => [item.kind, item.id, item.reason])).toEqual(
        expect.arrayContaining([
          [StudioResourceKind.Audio, 'hot-svg', StudioRefusalReason.RemoteSubresource],
          [StudioResourceKind.Captions, 'not-a-graphic', StudioRefusalReason.UnsupportedMediaType],
          [StudioResourceKind.Audio, 'not-a-graphic', StudioRefusalReason.UnsupportedMediaType],
        ]),
      );
    });

    it('treats inline captions as revision data and imported captions as declared files', async () => {
      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(
          {
            ...sequenceWith(
              { kind: 'title', captionsImportId: 'subs' },
              { kind: 'title', captionsImportId: 'missing' },
            ),
            captions: [{ start: 0, end: 1, text: 'hello' }],
          },
          { imports },
        ),
      );

      expect(manifest.entries.filter((entry) => entry.kind === StudioResourceKind.Captions)).toEqual([
        expect.objectContaining({ id: 'seq-main', grant: 'none', path: null, sourceAccess: 'project' }),
        expect.objectContaining({ id: 'subs', grant: 'render', path: '/projects/p/subs.vtt' }),
      ]);
      expect(refused).toEqual([
        expect.objectContaining({ id: 'missing', reason: StudioRefusalReason.UndeclaredImport }),
      ]);
    });

    it('resolves a LUT from the project imports or the bundled catalogue', async () => {
      const graph = sequenceWith(
        { grade: { look: 'none', lutId: 'warm', lutSource: 'import' } },
        { grade: { lutId: 'teal' } },
      );

      const bare = await sut.resolveProjectResources(auth, context(graph, { imports }));
      expect(bare.manifest.entries.filter((entry) => entry.kind === StudioResourceKind.Lut)).toEqual([
        expect.objectContaining({ id: 'warm', path: '/projects/p/warm.cube', sourceAccess: 'project' }),
      ]);
      expect(bare.refused).toEqual([expect.objectContaining({ id: 'teal', reason: StudioRefusalReason.NotBundled })]);

      const bundled = await sut.resolveProjectResources(
        auth,
        context(graph, {
          imports,
          catalog: { fonts: {}, audio: {}, models: {}, luts: { teal: { path: '/bundle/teal.cube', checksum: 't' } } },
        }),
      );
      expect(bundled.refused).toEqual([
        expect.objectContaining({ id: 'teal', reason: StudioRefusalReason.RightsBlocked }),
      ]);

      admit('lut:teal');
      const approved = await sut.resolveProjectResources(
        auth,
        context(graph, {
          imports,
          catalog: { fonts: {}, audio: {}, models: {}, luts: { teal: { path: '/bundle/teal.cube', checksum: 't' } } },
        }),
      );
      expect(approved.refused).toEqual([]);
    });
  });

  describe('fonts, models and presets', () => {
    it('resolves fonts and models only from the catalogue and presets only from the registry', async () => {
      const graph = sequenceWith(
        { kind: 'title', fontFamily: 'Inter', style: 'Minimal', animation: 'Wiggle' },
        { kind: 'voice', modelId: 'kokoro-v1' },
      );

      const bare = await sut.resolveProjectResources(auth, context(graph));
      expect(bare.refused.map((item) => [item.kind, item.id, item.reason])).toEqual([
        [StudioResourceKind.Font, 'Inter', StudioRefusalReason.NotBundled],
        [StudioResourceKind.Preset, 'Wiggle', StudioRefusalReason.UnknownPreset],
        [StudioResourceKind.Model, 'kokoro-v1', StudioRefusalReason.NotBundled],
      ]);
      expect(bare.manifest.entries).toEqual([
        expect.objectContaining({
          kind: StudioResourceKind.Preset,
          family: 'titleStyle',
          id: 'Minimal',
          grant: 'none',
        }),
      ]);

      const catalog = {
        fonts: { Inter: { path: '/bundle/Inter.woff2', checksum: 'f' } },
        models: { 'kokoro-v1': { path: '/models/kokoro', checksum: 'm', revision: '1.0' } },
        luts: {},
        audio: {},
      };
      // With the owner's approval (FL-146, 2026-09-25) the reviewed Inter row is allowed; kokoro-v1
      // has no reviewed row, so it stays blocked as an unknown resource.
      const approvedMirror = await sut.resolveProjectResources(auth, context(graph, { catalog }));
      expect(approvedMirror.refused.map((item) => [item.kind, item.id, item.reason])).toEqual([
        [StudioResourceKind.Preset, 'Wiggle', StudioRefusalReason.UnknownPreset],
        [StudioResourceKind.Model, 'kokoro-v1', StudioRefusalReason.RightsBlocked],
      ]);

      // A reviewed row that is not approved is refused by name.
      block('font:Inter');
      const blocked = await sut.resolveProjectResources(auth, context(graph, { catalog }));
      expect(blocked.refused.map((item) => [item.kind, item.id, item.reason])).toEqual([
        [StudioResourceKind.Font, 'Inter', StudioRefusalReason.RightsBlocked],
        [StudioResourceKind.Preset, 'Wiggle', StudioRefusalReason.UnknownPreset],
        [StudioResourceKind.Model, 'kokoro-v1', StudioRefusalReason.RightsBlocked],
      ]);
      expect(blocked.refused[0].detail).toBe('font:Inter: use on this server is blocked until the owner approves it.');
      expect(blocked.refused[2].detail).toBe('model:kokoro-v1 has no reviewed rights decision, so it is blocked.');

      admit('font:Inter');
      admit('model:kokoro-v1');
      // Local use is approved but hosted use is not, so the cloud destination still refuses both.
      const hosted = await sut.resolveProjectResources(
        auth,
        context(graph, { catalog, destination: StudioDestination.FrameleafCloud, cloudConsent: true }),
      );
      expect(hosted.refused.filter((item) => item.reason === StudioRefusalReason.RightsBlocked)).toHaveLength(2);

      const bundled = await sut.resolveProjectResources(auth, context(graph, { catalog }));
      expect(bundled.manifest.entries.map((entry) => [entry.kind, entry.grant, entry.path])).toEqual([
        [StudioResourceKind.Font, 'render', '/bundle/Inter.woff2'],
        [StudioResourceKind.Preset, 'none', null],
        [StudioResourceKind.Model, 'none', null],
      ]);
    });
  });

  describe('nested sequences', () => {
    it('authorizes acyclic nesting and refuses cycles and unknown targets', async () => {
      const graph = {
        sequences: [
          {
            id: 'main',
            tracks: [
              {
                clips: [
                  { kind: 'sequence', sequenceId: 'intro' },
                  { kind: 'sequence', sequenceId: 'ghost' },
                ],
              },
            ],
          },
          { id: 'intro', tracks: [{ clips: [{ kind: 'sequence', sequenceId: 'loop' }] }] },
          { id: 'loop', tracks: [{ clips: [{ kind: 'sequence', sequenceId: 'loop' }] }] },
        ],
      };

      const { manifest, refused } = await sut.resolveProjectResources(auth, context(graph));

      expect(manifest.entries).toEqual([
        expect.objectContaining({
          kind: StudioResourceKind.NestedSequence,
          id: 'intro',
          sourceAccess: 'graph',
          grant: 'none',
        }),
      ]);
      expect(refused.map((item) => [item.id, item.reason])).toEqual([
        ['ghost', StudioRefusalReason.UnknownSequence],
        ['loop', StudioRefusalReason.CyclicSequence],
      ]);
    });
  });

  describe('generated intermediates', () => {
    it('refuses an old generated producer binding after its source is restored', async () => {
      const source = ownedVideo();
      mocks.asset.getByIds.mockResolvedValue([source]);
      allowOwned(source.id);
      mocks.integrityReport.sourceEpochs.mockResolvedValue([{ assetId: source.id, ownerId: auth.user.id, epoch: '2' }]);
      const request = context(sequenceWith({ generatedId: 'reverse' }), {
        generated: [
          {
            id: 'reverse',
            producer: 'reverse-conform',
            checksum: 'reverse-checksum',
            path: '/cache/reverse.mp4',
            derivedFrom: [`library-asset:${source.id}`],
            sourceEpochs: [{ assetId: source.id, ownerId: auth.user.id, epoch: '0' }],
          },
        ],
      });
      const resolved = await sut.resolveProjectResources(auth, request);
      expect(resolved.manifest.complete).toBe(false);
      expect(resolved.manifest.entries.some((entry) => entry.id === 'reverse')).toBe(false);
      expect(resolved.refused).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'reverse', reason: StudioRefusalReason.DerivedInputRefused }),
        ]),
      );
    });

    it('resolves a relinked reverse conform and rechecks its transitive source access', async () => {
      const source = ownedVideo();
      mocks.asset.getByIds.mockResolvedValue([source]);
      allowOwned(source.id);
      const generated = [
        {
          id: 'reverse',
          producer: 'reverse-conform',
          checksum: 'reverse-checksum',
          path: '/cache/reverse.mp4',
          derivedFrom: ['generated-intermediate:proxy'],
        },
        {
          id: 'proxy',
          producer: 'proxy',
          checksum: 'proxy-checksum',
          path: '/cache/proxy.mp4',
          derivedFrom: [`library-asset:${source.id}`],
        },
        {
          id: 'unreferenced',
          producer: 'proxy',
          checksum: 'unused',
          path: '/cache/unused.mp4',
          derivedFrom: ['library-asset:unused'],
        },
      ];
      const request = context(sequenceWith({ generatedId: 'reverse' }), { generated });
      const resolved = await sut.resolveProjectResources(auth, request);
      expect(resolved.manifest.complete).toBe(true);
      expect(resolved.manifest.entries.map((entry) => entry.key)).toEqual([
        `library-asset:${source.id}`,
        'generated-intermediate:proxy',
        'generated-intermediate:reverse',
      ]);
      expect(mocks.asset.getByIds).toHaveBeenCalledWith([source.id]);

      allowOwned();
      const revoked = await sut.resolveProjectResources(auth, request);
      expect(revoked.manifest.complete).toBe(false);
      expect(revoked.manifest.entries).toEqual([]);
      expect(revoked.refused).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: source.id, reason: StudioRefusalReason.HiddenContent }),
          expect.objectContaining({ id: 'proxy', reason: StudioRefusalReason.DerivedInputRefused }),
          expect.objectContaining({ id: 'reverse', reason: StudioRefusalReason.DerivedInputRefused }),
        ]),
      );
    });

    it('refuses cyclic lineage and ambiguous or malformed source keys without granting files', async () => {
      const generated = [
        {
          id: 'a',
          producer: 'reverse-conform',
          checksum: 'a',
          path: '/cache/a',
          derivedFrom: ['generated-intermediate:b'],
        },
        { id: 'b', producer: 'proxy', checksum: 'b', path: '/cache/b', derivedFrom: ['generated-intermediate:a'] },
        { id: 'audio', producer: 'waveform', checksum: 'c', path: '/cache/c', derivedFrom: ['audio:unknown'] },
        {
          id: 'path',
          producer: 'proxy',
          checksum: 'd',
          path: '/cache/d',
          derivedFrom: ['library-asset:/private/file'],
        },
      ];
      const { manifest, refused } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ generatedId: 'a' }, { generatedId: 'audio' }, { generatedId: 'path' }), { generated }),
      );
      expect(manifest.complete).toBe(false);
      expect(manifest.entries).toEqual([]);
      expect(refused.map((entry) => entry.id).sort()).toEqual(['a', 'audio', 'b', 'path']);
      expect(refused.every((entry) => entry.reason === StudioRefusalReason.DerivedInputRefused)).toBe(true);
    });

    it('bounds generated lineage expansion before reading any source', async () => {
      const generated = [
        {
          id: 'reverse',
          producer: 'reverse-conform',
          checksum: 'r',
          path: '/cache/reverse',
          derivedFrom: Array.from({ length: STUDIO_MAX_REFERENCES }, (_, index) => `project-import:source-${index}`),
        },
      ];
      await expect(
        sut.resolveProjectResources(auth, context(sequenceWith({ generatedId: 'reverse' }), { generated })),
      ).rejects.toThrow('Generated lineage exceeds');
      expect(mocks.asset.getByIds).not.toHaveBeenCalled();
    });

    it('authorizes a chain whose inputs are all authorized and refuses one whose input was refused', async () => {
      const ok = ownedVideo();
      const hidden = ownedVideo();
      mocks.asset.getByIds.mockResolvedValue([ok, hidden]);
      allowOwned(ok.id);

      const graph = sequenceWith(
        { assetId: ok.id },
        { assetId: hidden.id },
        { generatedId: 'chunk-1' },
        { generatedId: 'proxy-ok' },
        { generatedId: 'proxy-hidden' },
        { generatedId: 'orphan' },
        { generatedId: 'undeclared' },
      );
      const generated = [
        {
          id: 'proxy-ok',
          producer: 'proxy',
          checksum: 'p1',
          path: '/cache/proxy-ok.mp4',
          derivedFrom: [`library-asset:${ok.id}`],
        },
        {
          id: 'proxy-hidden',
          producer: 'proxy',
          checksum: 'p2',
          path: '/cache/proxy-hidden.mp4',
          derivedFrom: [`library-asset:${hidden.id}`],
        },
        {
          id: 'chunk-1',
          producer: 'chunk',
          checksum: 'c1',
          path: '/cache/chunk-1.mp4',
          derivedFrom: ['generated-intermediate:proxy-ok'],
        },
        {
          id: 'orphan',
          producer: 'waveform',
          checksum: 'w1',
          path: '/cache/orphan.bin',
          derivedFrom: ['library-asset:not-in-graph'],
        },
      ];

      const { manifest, refused } = await sut.resolveProjectResources(auth, context(graph, { generated }));

      expect(
        manifest.entries
          .filter((entry) => entry.kind === StudioResourceKind.GeneratedIntermediate)
          .map((entry) => entry.id),
      ).toEqual(['proxy-ok', 'chunk-1']);
      expect(refused.map((item) => [item.id, item.reason])).toEqual([
        [hidden.id, StudioRefusalReason.HiddenContent],
        ['not-in-graph', StudioRefusalReason.InvalidId],
        ['proxy-hidden', StudioRefusalReason.DerivedInputRefused],
        ['orphan', StudioRefusalReason.DerivedInputRefused],
        ['undeclared', StudioRefusalReason.UndeclaredImport],
      ]);
    });

    it('refuses model output until a model of its family is approved for the use (FL-86)', async () => {
      const graph = sequenceWith({ generatedId: 'music-1' }, { generatedId: 'voice-1' }, { generatedId: 'wave-1' });
      const generated = [
        { id: 'music-1', producer: 'musicgen', checksum: 'm1', path: '/cache/music-1.wav', derivedFrom: [] },
        { id: 'voice-1', producer: 'tts', checksum: 'v1', path: '/cache/voice-1.wav', derivedFrom: [] },
        { id: 'wave-1', producer: 'waveform', checksum: 'w1', path: '/cache/wave-1.bin', derivedFrom: [] },
      ];

      // With the owner's approval every family resolves; a family with no approved model does not.
      const allApproved = await sut.resolveProjectResources(auth, context(graph, { generated }));
      expect(allApproved.refused).toEqual([]);
      for (const id of [...studioProducerModels.musicgen, ...studioProducerModels.tts]) {
        block(id);
      }

      const blocked = await sut.resolveProjectResources(auth, context(graph, { generated }));
      expect(blocked.refused.map((item) => [item.id, item.reason])).toEqual([
        ['music-1', StudioRefusalReason.RightsBlocked],
        ['voice-1', StudioRefusalReason.RightsBlocked],
      ]);
      expect(blocked.refused[0].detail).toContain('model:Xenova/musicgen-small');
      expect(blocked.manifest.entries.map((entry) => entry.id)).toEqual(['wave-1']);

      admit('model:supertonic-3');
      const approved = await sut.resolveProjectResources(auth, context(graph, { generated }));
      expect(approved.refused.map((item) => item.id)).toEqual(['music-1']);
    });
  });

  describe('manifests and grants', () => {
    let manifest: StudioAuthorizedManifest;
    let assetId: string;
    let checksum: string;

    beforeEach(async () => {
      const asset = ownedVideo();
      assetId = asset.id;
      checksum = asset.checksum.toString('base64');
      mocks.asset.getByIds.mockResolvedValue([asset]);
      allowOwned(asset.id);
      ({ manifest } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: asset.id }, { kind: 'title', style: 'Bold' })),
      ));
    });

    it('accepts its own complete, unexpired manifest for the destination it was resolved for', () => {
      expect(() => sut.assertAuthorizedManifest(manifest)).not.toThrow();
      expect(() => sut.assertAuthorizedManifest(manifest, { destination: StudioDestination.Local })).not.toThrow();
    });

    it('rejects an altered manifest', () => {
      const altered = { ...manifest, entries: [...manifest.entries, { ...manifest.entries[0], id: newUuid() }] };
      expect(() => sut.assertAuthorizedManifest(altered)).toThrow(BadRequestException);
    });

    it('rejects a manifest from another process', () => {
      const { sut: other, mocks: otherMocks } = newTestService(StudioResourceService);
      otherMocks.crypto.randomBytesAsText.mockReturnValue('a-secret-from-another-process');
      expect(() => other.assertAuthorizedManifest(manifest)).toThrow(BadRequestException);
    });

    it('rejects an expired manifest', () => {
      const now = new Date(new Date(manifest.expiresAt).getTime() + 1);
      expect(() => sut.assertAuthorizedManifest(manifest, { now })).toThrow(BadRequestException);
    });

    it('rejects a manifest for a different destination', () => {
      expect(() => sut.assertAuthorizedManifest(manifest, { destination: StudioDestination.FrameleafCloud })).toThrow(
        BadRequestException,
      );
    });

    it('rejects an incomplete manifest, so a render never runs with a refused source', async () => {
      const { manifest: incomplete } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId: newUuid() })),
      );
      expect(incomplete.complete).toBe(false);
      expect(() => sut.assertAuthorizedManifest(incomplete)).toThrow(BadRequestException);
      expect(() => sut.issueReadGrants(incomplete, { workerId: 'worker-1' })).toThrow(BadRequestException);
    });

    it('issues render grants for file-backed entries only, bound to worker, user, revision and checksum', () => {
      const now = new Date('2026-09-22T12:00:00.000Z');
      const grants = sut.issueReadGrants(manifest, { workerId: 'worker-1', now });

      expect(grants).toEqual([
        {
          key: `library-asset:${assetId}`,
          kind: StudioResourceKind.LibraryAsset,
          id: assetId,
          path: manifest.entries[0].path,
          token: 'mock-jwt-token',
          expiresAt: new Date(now.getTime() + STUDIO_GRANT_TTL_SECONDS * 1000).toISOString(),
        },
      ]);
      expect(mocks.crypto.signJwt).toHaveBeenCalledWith(
        {
          v: 2,
          sourceEpochs: [{ assetId, ownerId: auth.user.id, epoch: '0' }],
          scope: 'render',
          kind: StudioResourceKind.LibraryAsset,
          id: assetId,
          key: `library-asset:${assetId}`,
          checksum,
          ownerId: auth.user.id,
          projectId: manifest.projectId,
          revision: manifest.revision,
          userId: auth.user.id,
          workerId: 'worker-1',
          manifest: manifest.digest,
        },
        expect.any(String),
        { expiresIn: STUDIO_GRANT_TTL_SECONDS },
      );
    });

    it('issues a preview grant bound to the manifest digest', () => {
      sut.issuePreviewGrant(manifest, { workerId: 'worker-1' });
      expect(mocks.crypto.signJwt).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'preview',
          kind: StudioResourceKind.RemotePreviewFrame,
          manifest: manifest.digest,
          // STU-203: the previewed revision's library sources, re-checked on every frame read.
          assetIds: [assetId],
        }),
        expect.any(String),
        { expiresIn: STUDIO_GRANT_TTL_SECONDS },
      );
    });

    it('changes the cache key with revision and digest', async () => {
      const key = sut.cacheKey(manifest);
      expect(key).toContain(`:${manifest.revision}:`);
      expect(key).toContain(manifest.digest);
      const { manifest: later } = await sut.resolveProjectResources(
        auth,
        context(sequenceWith({ assetId }), { projectId: manifest.projectId, revision: manifest.revision + 1 }),
      );
      expect(sut.cacheKey(later)).not.toBe(key);
    });

    describe('verifyReadGrant', () => {
      const payload = (overrides: Partial<StudioReadGrantPayload> = {}): StudioReadGrantPayload => ({
        v: 1,
        scope: 'render',
        kind: StudioResourceKind.LibraryAsset,
        id: assetId,
        key: `library-asset:${assetId}`,
        checksum,
        ownerId: auth.user.id,
        projectId: manifest.projectId,
        revision: manifest.revision,
        userId: auth.user.id,
        workerId: 'worker-1',
        manifest: manifest.digest,
        ...overrides,
      });

      it('re-checks live access and returns the current path', async () => {
        mocks.crypto.verifyJwt.mockReturnValue(payload());
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual({
          valid: true,
          grant: payload(),
          path: manifest.entries[0].path,
        });
        expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledTimes(2);
      });

      it('re-checks live access to every previewed source on a preview frame read (STU-203)', async () => {
        const preview = payload({
          scope: 'preview',
          kind: StudioResourceKind.RemotePreviewFrame,
          id: manifest.digest,
          assetIds: [assetId],
        });
        mocks.crypto.verifyJwt.mockReturnValue(preview);
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual({
          valid: true,
          grant: preview,
          path: '',
        });

        // The asset left the album, the album was deleted or unlinked, the partner share ended or the
        // member left the space: the account no longer reaches it, and the cached frame stops.
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
        mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set());
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
          expect.objectContaining({ valid: false }),
        );
      });

      it('lets a background runner reopen a Locked source that the interactive path refuses', async () => {
        mocks.crypto.verifyJwt.mockReturnValue(payload());
        mocks.asset.getByIds.mockResolvedValue([
          ownedVideo({ id: assetId, checksum: Buffer.from(checksum, 'base64'), visibility: AssetVisibility.Locked }),
        ]);
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
        const elevated: AuthDto = { ...auth, session: { id: 'sid', hasElevatedPermission: true } as AuthSession };

        // an ordinary session does not even learn that the source is Locked
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
          expect.objectContaining({ valid: false, reason: StudioRefusalReason.NotFound }),
        );
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth: elevated })).resolves.toEqual(
          expect.objectContaining({ valid: false, reason: StudioRefusalReason.Locked }),
        );
        await expect(
          sut.verifyReadGrant('token', { workerId: 'worker-1', auth: elevated, backgroundRunner: true }),
        ).resolves.toEqual(expect.objectContaining({ valid: true }));
      });

      it('rejects a bad or expired token', async () => {
        mocks.crypto.verifyJwt.mockImplementation(() => {
          throw new Error('jwt expired');
        });
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
          expect.objectContaining({ valid: false, reason: 'expired' }),
        );
        mocks.crypto.verifyJwt.mockImplementation(() => {
          throw new Error('invalid signature');
        });
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
          expect.objectContaining({ valid: false, reason: 'invalid-token' }),
        );
      });

      it('rejects another worker or another user', async () => {
        mocks.crypto.verifyJwt.mockReturnValue(payload());
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-2', auth })).resolves.toEqual(
          expect.objectContaining({ valid: false, reason: 'worker-mismatch' }),
        );
        await expect(
          sut.verifyReadGrant('token', { workerId: 'worker-1', auth: AuthFactory.create() }),
        ).resolves.toEqual(expect.objectContaining({ valid: false, reason: 'user-mismatch' }));
        expect(mocks.asset.getByIds).toHaveBeenCalledTimes(1);
      });

      it('stops when the source was trashed, unshared or replaced after the grant was issued', async () => {
        mocks.crypto.verifyJwt.mockReturnValue(payload());

        mocks.asset.getByIds.mockResolvedValue([ownedVideo({ id: assetId, deletedAt: new Date() })]);
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
          expect.objectContaining({ valid: false, reason: StudioRefusalReason.Trashed }),
        );

        mocks.asset.getByIds.mockResolvedValue([ownedVideo({ id: assetId })]);
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
          expect.objectContaining({ valid: false, reason: StudioRefusalReason.HiddenContent }),
        );

        mocks.asset.getByIds.mockResolvedValue([ownedVideo({ id: assetId, checksum: Buffer.from('replaced') })]);
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
          expect.objectContaining({ valid: false, reason: StudioRefusalReason.ChecksumMismatch }),
        );

        mocks.asset.getByIds.mockResolvedValue([]);
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
          expect.objectContaining({ valid: false, reason: StudioRefusalReason.NotFound }),
        );
      });

      it('never redeems a grant for a shared-link session', async () => {
        mocks.crypto.verifyJwt.mockReturnValue(payload());
        const sharedLinkAuth = AuthFactory.from({ id: auth.user.id }).sharedLink().build();
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth: sharedLinkAuth })).resolves.toEqual(
          expect.objectContaining({ valid: false, reason: StudioRefusalReason.SharedLinkSession }),
        );
      });

      it('accepts a preview grant without a file lookup', async () => {
        mocks.crypto.verifyJwt.mockReturnValue(
          payload({
            scope: 'preview',
            kind: StudioResourceKind.RemotePreviewFrame,
            id: manifest.digest,
            checksum: null,
            ownerId: null,
          }),
        );
        await expect(sut.verifyReadGrant('token', { workerId: 'worker-1', auth })).resolves.toEqual(
          expect.objectContaining({ valid: true, path: '' }),
        );
        expect(mocks.asset.getByIds).toHaveBeenCalledTimes(1);
      });
    });
  });
});
