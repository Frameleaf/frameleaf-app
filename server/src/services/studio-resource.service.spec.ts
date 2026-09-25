import { BadRequestException } from '@nestjs/common';
import type { StudioResourceRights } from 'src/utils/studio-rights.generated.js';
import { AuthSession } from 'src/database.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetFileType, AssetType, AssetVisibility } from 'src/enum.js';
import {
  STUDIO_GRANT_TTL_SECONDS,
  StudioAuthorizedManifest,
  StudioProjectResourceContext,
  StudioReadGrantPayload,
  StudioResourceService,
} from 'src/services/studio-resource.service.js';
import {
  STUDIO_MAX_GRAPH_BYTES,
  StudioDestination,
  StudioRefusalReason,
  StudioResourceKind,
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
    const actual = await vi.importActual<typeof import('src/utils/studio-rights.generated.js')>(
      'src/utils/studio-rights.generated.js',
    );
    for (const key of Object.keys(rightsTable)) {
      delete rightsTable[key];
    }
    Object.assign(rightsTable, actual.studioResourceRights);
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

    it('labels shared album and partner sources so the output inherits their privacy', async () => {
      const shared = AssetFactory.create({ ownerId: newUuid(), type: AssetType.Image });
      const partner = AssetFactory.create({ ownerId: newUuid(), type: AssetType.Image });
      mocks.asset.getByIds.mockResolvedValue([shared, partner]);
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([shared.id]));
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([partner.id]));

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

  describe('project imports, captions, LUTs and graphics', () => {
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
      { id: 'warm', contentType: 'text/plain', checksum: 'l1', sizeBytes: 10, path: '/projects/p/warm.cube' },
      { id: 'subs', contentType: 'text/vtt', checksum: 'c1', sizeBytes: 10, path: '/projects/p/subs.vtt' },
    ];

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
        ['proxy-hidden', StudioRefusalReason.DerivedInputRefused],
        ['undeclared', StudioRefusalReason.UndeclaredImport],
        ['orphan', StudioRefusalReason.DerivedInputRefused],
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
        mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set());
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
