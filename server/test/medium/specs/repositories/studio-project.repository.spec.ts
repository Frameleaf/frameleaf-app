import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AlbumKind,
  AlbumUserRole,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationCreate, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioProjectRepository, StudioRevisionAppend } from 'src/repositories/studio-project.repository.js';
import {
  STUDIO_BUNDLE_MAX_EXPORTS,
  STUDIO_BUNDLE_MAX_UPLOADS,
  STUDIO_REVISION_MAX_BYTES,
  STUDIO_REVISION_MAX_COUNT,
} from 'src/repositories/studio-storage-admission.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { StudioRevocationService } from 'src/services/studio-revocation.service.js';
import { STUDIO_IMPORT_MAX_PER_PROJECT } from 'src/utils/studio-imports.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(StudioProjectRepository) };
};

const LEASE_MS = 60_000;

const append = (
  projectId: string,
  authorId: string,
  overrides: Partial<StudioRevisionAppend> = {},
): StudioRevisionAppend => ({
  projectId,
  expectedRevision: 0,
  authorId,
  leaseClientId: 'tab-a',
  leaseMs: LEASE_MS,
  envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'r', graph: { tracks: [] } },
  digest: 'digest-1',
  graphBytes: 12,
  summary: { counts: {}, total: 0 },
  requestKey: 'req-1',
  restoredFromRevision: null,
  ...overrides,
});

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

afterEach(async () => {
  await sql`DELETE FROM public.studio_generated_resource`.execute(defaultDatabase);
  await sql`DELETE FROM public.studio_project_import`.execute(defaultDatabase);
  await defaultDatabase.deleteFrom('studio_project').execute();
});

describe(StudioProjectRepository.name, () => {
  const leasedProject = async (sut: StudioProjectRepository, ownerId: string, clientId = 'tab-a') => {
    const project = await sut.create({ ownerId, name: 'Lake trip' });
    const leased = await sut.acquireLease(project.id, {
      userId: ownerId,
      clientId,
      leaseMs: LEASE_MS,
      takeover: false,
    });
    expect(leased).toBeDefined();
    return leased!;
  };

  const lapseLease = (projectId: string) =>
    defaultDatabase
      .updateTable('studio_project')
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where('id', '=', projectId)
      .execute();

  describe('Studio storage admission', () => {
    const upload = (ownerId: string, sizeBytes = 1) => ({
      ownerId,
      path: `/private/${randomUUID()}.zip`,
      sizeBytes,
      digest: '',
      originalFileName: '',
      manifest: {},
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    it('serializes concurrent upload count and quota admission', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const attempts = await Promise.allSettled(
        Array.from({ length: STUDIO_BUNDLE_MAX_UPLOADS + 2 }, () => sut.createUpload(upload(user.id))),
      );
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(STUDIO_BUNDLE_MAX_UPLOADS);
      const { user: limited } = await ctx.newUser();
      await ctx.database
        .updateTable('user')
        .set({ quotaSizeInBytes: 100, quotaUsageInBytes: 0 })
        .where('id', '=', limited.id)
        .execute();
      const quota = await Promise.allSettled([
        sut.createUpload(upload(limited.id, 60)),
        sut.createUpload(upload(limited.id, 60)),
      ]);
      expect(quota.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    it('counts bundle reservations against import quota under the same owner lock', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await sut.create({ ownerId: user.id, name: 'Quota' });
      await ctx.database
        .updateTable('user')
        .set({ quotaSizeInBytes: 100, quotaUsageInBytes: 0 })
        .where('id', '=', user.id)
        .execute();
      await sut.createUpload(upload(user.id, 80));
      await expect(
        sut.registerImport({
          ownerId: user.id,
          projectId: project.id,
          id: randomUUID(),
          checksum: 'a'.repeat(64),
          contentType: 'audio/wav',
          sizeBytes: 30,
          path: '/private/voice.wav',
          fileName: 'voice.wav',
          externalReferences: null,
        }),
      ).rejects.toThrow('storage quota');
    });

    it('transfers an extraction reservation into an import without double charging quota', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await sut.create({ ownerId: user.id, name: 'Quota transfer' });
      await ctx.database
        .updateTable('user')
        .set({ quotaSizeInBytes: 100, quotaUsageInBytes: 0 })
        .where('id', '=', user.id)
        .execute();
      await sut.createUpload(upload(user.id, 20));
      const temporary = await sut.createUpload(upload(user.id, 50));
      await sut.registerImport({
        ownerId: user.id,
        projectId: project.id,
        id: randomUUID(),
        checksum: 'b'.repeat(64),
        contentType: 'audio/wav',
        sizeBytes: 50,
        path: '/private/voice-transfer.wav',
        fileName: 'voice.wav',
        externalReferences: null,
        reservationId: temporary.id,
      });
      expect(await sut.getUpload(temporary.id, user.id)).toBeUndefined();
      expect(await sut.getImportBytes(user.id)).toBe(50);
    });

    it('reuses identical running exports atomically and bounds distinct selections', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await sut.create({ ownerId: user.id, name: 'Export' });
      const operations = ctx.get(MediaOperationRepository);
      const operation: MediaOperationCreate = {
        ownerId: user.id,
        kind: MediaOperationKind.StudioBundleExport,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: 'Export',
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: project.id,
        revisionId: null,
        snapshot: { projectId: project.id, revision: 1, includeMedia: false, sequenceIds: null, requestKey: null },
        settings: { storageReservationBytes: 32 * 1024 ** 2 },
        estimate: null,
        totalUnits: null,
        maxAttempts: 2,
      };
      const [first, duplicate] = await Promise.all([operations.create(operation), operations.create(operation)]);
      expect(first.id).toBe(duplicate.id);
      for (let index = 1; index < STUDIO_BUNDLE_MAX_EXPORTS; index++)
        await operations.create({
          ...operation,
          snapshot: { ...operation.snapshot, sequenceIds: [`sequence-${index}`] },
        });
      await expect(
        operations.create({ ...operation, snapshot: { ...operation.snapshot, includeMedia: true } }),
      ).rejects.toThrow('storage limit');
      await expect(operations.create(operation)).resolves.toMatchObject({ id: first.id });
      await expect(operations.createRetry({ ...operation, retryOfId: first.id })).rejects.toThrow('storage limit');
    });

    it('refuses a revision at the history budget without moving the head or deleting history', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id);
      await expect(
        sut.appendRevision(append(project.id, user.id, { graphBytes: STUDIO_REVISION_MAX_BYTES + 1 })),
      ).rejects.toThrow('revision history limit');
      await ctx.database
        .insertInto('studio_project_revision')
        .values(
          Array.from({ length: STUDIO_REVISION_MAX_COUNT }, (_, i) => ({
            projectId: project.id,
            revision: i + 1,
            authorId: user.id,
            envelope: {},
            digest: `digest-${i}`,
            graphBytes: 1,
            summary: {},
            requestKey: null,
          })),
        )
        .execute();
      await expect(sut.appendRevision(append(project.id, user.id))).rejects.toThrow('revision history limit');
      expect((await sut.getById(project.id))!.currentRevision).toBe(0);
      expect((await sut.listRevisions(project.id, { take: 1, skip: 0 })).total).toBe(STUDIO_REVISION_MAX_COUNT);
    });
  });

  describe('appendRevision', () => {
    it('lets exactly one of two concurrent saves against the same head win', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id);

      const [first, second] = await Promise.all([
        sut.appendRevision(append(project.id, user.id, { requestKey: 'req-a', digest: 'a' })),
        sut.appendRevision(append(project.id, user.id, { requestKey: 'req-b', digest: 'b' })),
      ]);

      const statuses = [first.status, second.status].toSorted((a, b) => a.localeCompare(b));
      expect(statuses).toEqual(['appended', 'rejected']);
      const after = await sut.getById(project.id);
      expect(after?.currentRevision).toBe(1);
      expect((await sut.listRevisions(project.id, { take: 10, skip: 0 })).total).toBe(1);
    });

    it('refuses a save whose head has moved, without writing a revision', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id);
      await sut.appendRevision(append(project.id, user.id));

      const stale = await sut.appendRevision(append(project.id, user.id, { requestKey: 'req-2', digest: 'd2' }));

      expect(stale.status).toBe('rejected');
      expect((await sut.getById(project.id))?.currentRevision).toBe(1);
      expect(await sut.getRevision(project.id, 2)).toBeUndefined();
    });

    it('refuses a save from a client that does not hold a live lease', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id, 'tab-a');

      const otherTab = await sut.appendRevision(append(project.id, user.id, { leaseClientId: 'tab-b' }));
      expect(otherTab.status).toBe('rejected');

      await lapseLease(project.id);
      const lapsed = await sut.appendRevision(append(project.id, user.id));
      expect(lapsed.status).toBe('rejected');
      expect((await sut.getById(project.id))?.currentRevision).toBe(0);
    });

    it('renews the lease on a successful save', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id);
      const before = project.leaseExpiresAt!.getTime();

      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await sut.appendRevision(append(project.id, user.id));

      expect(result.status).toBe('appended');
      expect((await sut.getById(project.id))!.leaseExpiresAt!.getTime()).toBeGreaterThan(before);
    });

    it('turns a duplicate request key into duplicate-key and leaves the head where it was', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id);
      await sut.appendRevision(append(project.id, user.id, { requestKey: 'same' }));

      const duplicate = await sut.appendRevision(
        append(project.id, user.id, { requestKey: 'same', expectedRevision: 1, digest: 'd2' }),
      );

      expect(duplicate.status).toBe('duplicate-key');
      expect((await sut.getById(project.id))?.currentRevision).toBe(1);
      expect((await sut.getRevisionByRequestKey(project.id, 'same'))?.digest).toBe('digest-1');
    });

    it('numbers revisions consecutively and lists them newest first without their documents', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id);
      await sut.appendRevision(append(project.id, user.id, { requestKey: 'r1' }));
      await sut.appendRevision(append(project.id, user.id, { requestKey: 'r2', expectedRevision: 1, digest: 'd2' }));
      await sut.appendRevision(
        append(project.id, user.id, { requestKey: 'r3', expectedRevision: 2, digest: 'd1', restoredFromRevision: 1 }),
      );

      const history = await sut.listRevisions(project.id, { take: 2, skip: 0 });

      expect(history.total).toBe(3);
      expect(history.items.map((item) => item.revision)).toEqual([3, 2]);
      expect(history.items[0].restoredFromRevision).toBe(1);
      expect('envelope' in history.items[0]).toBe(false);
      expect((await sut.listRevisionSummariesBetween(project.id, 1, 3)).map((item) => item.revision)).toEqual([2, 3]);
    });
  });

  describe('acquireLease', () => {
    it('gives a free lease to exactly one of two racing clients', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await sut.create({ ownerId: user.id, name: 'Lake trip' });

      const [a, b] = await Promise.all([
        sut.acquireLease(project.id, { userId: user.id, clientId: 'tab-a', leaseMs: LEASE_MS, takeover: false }),
        sut.acquireLease(project.id, { userId: user.id, clientId: 'tab-b', leaseMs: LEASE_MS, takeover: false }),
      ]);

      expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it('lets the holder renew, another client take a lapsed lease, and takeover only when asked', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id, 'tab-a');

      await expect(
        sut.acquireLease(project.id, { userId: user.id, clientId: 'tab-b', leaseMs: LEASE_MS, takeover: false }),
      ).resolves.toBeUndefined();
      await expect(
        sut.acquireLease(project.id, { userId: user.id, clientId: 'tab-a', leaseMs: LEASE_MS, takeover: false }),
      ).resolves.toMatchObject({ leaseClientId: 'tab-a' });

      await lapseLease(project.id);
      await expect(
        sut.acquireLease(project.id, { userId: user.id, clientId: 'tab-b', leaseMs: LEASE_MS, takeover: false }),
      ).resolves.toMatchObject({ leaseClientId: 'tab-b' });

      await expect(
        sut.acquireLease(project.id, { userId: user.id, clientId: 'tab-a', leaseMs: LEASE_MS, takeover: true }),
      ).resolves.toMatchObject({ leaseClientId: 'tab-a' });
    });

    it('never gives the lease to anybody but the owner, and only the holder can release it', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const project = await leasedProject(sut, owner.id, 'tab-a');

      await expect(
        sut.acquireLease(project.id, { userId: other.id, clientId: 'tab-x', leaseMs: LEASE_MS, takeover: true }),
      ).resolves.toBeUndefined();

      expect(await sut.releaseLease(project.id, owner.id, 'tab-b')).toBe(false);
      expect(await sut.releaseLease(project.id, owner.id, 'tab-a')).toBe(true);
      expect((await sut.getById(project.id))?.leaseClientId).toBeNull();
    });
  });

  describe('deletePurgeable', () => {
    it('keeps a project restored while the retention sweep waits for its row', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const now = new Date();
      const deadline = new Date(now.getTime() - 1000);
      const restored = await sut.create({ ownerId: user.id, name: 'Restored' });
      const expired = await sut.create({ ownerId: user.id, name: 'Expired' });
      await sut.trash(restored.id, deadline);
      await sut.trash(expired.id, deadline);

      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      const { promise: locked, resolve: signalLocked } = Promise.withResolvers<number>();
      const restoring = defaultDatabase.transaction().execute(async (trx) => {
        await trx
          .selectFrom('studio_project')
          .select('id')
          .where('id', '=', restored.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
        signalLocked(rows[0].pid);
        await held;
        await trx
          .updateTable('studio_project')
          .set({ deletedAt: null, purgeAfter: null })
          .where('id', '=', restored.id)
          .execute();
      });
      const blockerPid = await locked;

      const purging = sut.deletePurgeable(now);
      let waiting = false;
      let settled: PromiseSettledResult<unknown>[];
      try {
        const timeout = Date.now() + 5000;
        while (!waiting && Date.now() < timeout) {
          const { rows } = await sql<{ waiting: boolean }>`
            select exists (
              select 1 from pg_stat_activity
              where wait_event_type = 'Lock'
                and pg_blocking_pids(pid) @> array[${blockerPid}]::integer[]
            ) as waiting
          `.execute(defaultDatabase);
          waiting = rows[0].waiting;
          if (!waiting) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        expect(waiting).toBe(true);
      } finally {
        release();
        settled = await Promise.allSettled([restoring, purging]);
      }

      expect(settled).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: [expired.id] },
      ]);
      expect(await sut.getById(restored.id)).toMatchObject({ deletedAt: null, purgeAfter: null });
    }, 20_000);
  });

  describe('isLiveSharedSpaceOf (FL-97 owner decision)', () => {
    it('counts only a live space the user still belongs to that someone else belongs to as well', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();

      const { album: shared } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Space });
      await ctx.newAlbumUser({ albumId: shared.id, userId: member.id, role: AlbumUserRole.Viewer });
      await expect(sut.isLiveSharedSpaceOf(shared.id, owner.id)).resolves.toBe(true);
      // a member (not the album owner) counts too
      await expect(sut.isLiveSharedSpaceOf(shared.id, member.id)).resolves.toBe(true);
      // someone who is not a member never does
      await expect(sut.isLiveSharedSpaceOf(shared.id, stranger.id)).resolves.toBe(false);

      // a space nobody else is in is not shared
      const { album: solo } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Space });
      await expect(sut.isLiveSharedSpaceOf(solo.id, owner.id)).resolves.toBe(false);

      // an ordinary shared album is not a space
      const { album: album } = await ctx.newAlbum({ ownerId: owner.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
      await expect(sut.isLiveSharedSpaceOf(album.id, owner.id)).resolves.toBe(false);

      // a deleted space no longer counts
      const { album: gone } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Space });
      await ctx.newAlbumUser({ albumId: gone.id, userId: member.id, role: AlbumUserRole.Viewer });
      await ctx.database.updateTable('album').set({ deletedAt: new Date() }).where('id', '=', gone.id).execute();
      await expect(sut.isLiveSharedSpaceOf(gone.id, owner.id)).resolves.toBe(false);

      // once the other member leaves, it is no longer shared
      await ctx.database
        .deleteFrom('album_user')
        .where('albumId', '=', shared.id)
        .where('userId', '=', member.id)
        .execute();
      await expect(sut.isLiveSharedSpaceOf(shared.id, owner.id)).resolves.toBe(false);
    });
  });

  describe('listVisible', () => {
    it('shows a project to its owner and to live members of its shared space, and to nobody else', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const { album: space } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Space });
      await ctx.newAlbumUser({ albumId: space.id, userId: member.id, role: AlbumUserRole.Viewer });
      const project = await sut.create({ ownerId: owner.id, name: 'Lake trip', spaceId: space.id });
      await sut.create({ ownerId: owner.id, name: 'Private' });

      expect((await sut.listVisible(owner.id, { take: 10, skip: 0 })).total).toBe(2);
      const forMember = await sut.listVisible(member.id, { take: 10, skip: 0 });
      expect(forMember.items.map((item) => item.id)).toEqual([project.id]);
      expect((await sut.listVisible(stranger.id, { take: 10, skip: 0 })).total).toBe(0);

      await defaultDatabase
        .deleteFrom('album_user')
        .where('albumId', '=', space.id)
        .where('userId', '=', member.id)
        .execute();
      expect((await sut.listVisible(member.id, { take: 10, skip: 0 })).total).toBe(0);
    });

    it('unlinks the space when it is deleted and takes the project with a deleted owner', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { album: space } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Space });
      const project = await leasedProject(sut, owner.id);
      await sut.update(project.id, { spaceId: space.id });
      await sut.appendRevision(append(project.id, owner.id));
      await sut.createComment({
        projectId: project.id,
        authorId: owner.id,
        revision: 1,
        timeNum: 1001,
        timeDen: 30_000,
        text: 'note',
        requestKey: null,
      });

      await defaultDatabase.deleteFrom('album').where('id', '=', space.id).execute();
      expect((await sut.getById(project.id))?.spaceId).toBeNull();

      await defaultDatabase.deleteFrom('user').where('id', '=', owner.id).execute();
      expect(await sut.getById(project.id)).toBeUndefined();
      expect(await sut.getRevision(project.id, 1)).toBeUndefined();
      expect((await sut.listComments(project.id, { take: 10, skip: 0 })).total).toBe(0);
    });
  });

  describe('owner leaves the shared space (FL-146 owner decision)', () => {
    it("keeps the owner's projects as private ones, ends the space sharing and releases a member's lease", async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const { user: spaceOwner } = await ctx.newUser();
      const { album: space } = await ctx.newAlbum({ ownerId: spaceOwner.id, kind: AlbumKind.Space });
      await ctx.newAlbumUser({ albumId: space.id, userId: owner.id, role: AlbumUserRole.Editor });
      await ctx.newAlbumUser({ albumId: space.id, userId: member.id, role: AlbumUserRole.Editor });
      const kept = await sut.create({ ownerId: owner.id, name: 'Lake trip', spaceId: space.id });
      const heldByMember = await sut.create({ ownerId: owner.id, name: 'Beach', spaceId: space.id });
      await defaultDatabase
        .updateTable('studio_project')
        .set({ leaseHolderId: member.id, leaseClientId: 'tab-m', leaseExpiresAt: new Date(Date.now() + LEASE_MS) })
        .where('id', '=', heldByMember.id)
        .execute();
      const others = await sut.create({ ownerId: member.id, name: "Member's", spaceId: space.id });

      await defaultDatabase
        .deleteFrom('album_user')
        .where('albumId', '=', space.id)
        .where('userId', '=', owner.id)
        .execute();
      const detached = await sut.detachOwnerFromSpace(space.id, owner.id);

      expect(detached.toSorted()).toEqual([kept.id, heldByMember.id].toSorted());
      expect(await sut.getById(kept.id)).toMatchObject({ spaceId: null, ownerId: owner.id, deletedAt: null });
      expect(await sut.getById(heldByMember.id)).toMatchObject({
        spaceId: null,
        leaseHolderId: null,
        leaseClientId: null,
      });
      // Another member's project in the space is untouched.
      expect((await sut.getById(others.id))?.spaceId).toBe(space.id);

      // The owner still sees both; the remaining member no longer does.
      expect((await sut.listVisible(owner.id, { take: 10, skip: 0 })).total).toBe(2);
      const forMember = await sut.listVisible(member.id, { take: 10, skip: 0 });
      expect(forMember.items.map((item) => item.id)).toEqual([others.id]);
    });
  });

  describe('revocation lookups (FL-90)', () => {
    it('finds the projects whose current revision names an asset, and the projects in a space', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const assetId = '0195e2a0-0000-7000-8000-00000000a001';
      const named = await leasedProject(sut, user.id);
      await sut.appendRevision(
        append(named.id, user.id, {
          envelope: {
            schemaVersion: 1,
            engine: 'freecut',
            engineRevision: 'r',
            graph: { tracks: [{ clips: [{ assetId: assetId.toUpperCase() }] }] },
          },
        }),
      );
      const other = await leasedProject(sut, user.id, 'tab-b');
      await sut.appendRevision(append(other.id, user.id, { leaseClientId: 'tab-b' }));

      expect(await sut.getIdsReferencingAssets([assetId])).toEqual([named.id]);
      // Only well-formed ids are searched, so a wildcard can never match every project.
      expect(await sut.getIdsReferencingAssets(['%', '_'])).toEqual([]);

      const { album } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Space });
      await sut.update(other.id, { spaceId: album.id });
      expect(await sut.getIdsInSpace(album.id)).toEqual([other.id]);
    });
  });

  describe('generated resources', () => {
    it('serializes duplicate reverse commands and refuses changed bindings, stale revisions and lost edit leases', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id);
      await sut.appendRevision(append(project.id, user.id));
      const operations = ctx.get(MediaOperationRepository);
      const binding = { requestKey: 'reverse-command', clientId: 'tab-a', revision: 1 };
      const operation: MediaOperationCreate = {
        ownerId: user.id,
        kind: MediaOperationKind.StudioReverseConform,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: 'Source reversal',
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: project.id,
        revisionId: null,
        snapshot: { ...binding, clipId: 'clip-a' },
        settings: {},
        estimate: null,
        totalUnits: 3,
        maxAttempts: 2,
      };
      const [first, duplicate] = await Promise.all([
        operations.createStudioReverseCommand(operation, binding),
        operations.createStudioReverseCommand(operation, binding),
      ]);
      // Leave no queued worker job behind for another repository test.
      await operations.requestCancel(first.id, user.id);
      if (duplicate.id !== first.id) {
        await operations.requestCancel(duplicate.id, user.id);
      }
      expect(duplicate.id).toBe(first.id);
      await expect(
        operations.createStudioReverseCommand(
          { ...operation, snapshot: { ...binding, clipId: 'other-clip' } },
          binding,
        ),
      ).rejects.toThrow('already used');
      const fresh = { ...binding, requestKey: 'reverse-command-2' };
      await expect(
        operations.createStudioReverseCommand({ ...operation, snapshot: fresh }, { ...fresh, revision: 2 }),
      ).rejects.toThrow('revision or edit lease');
      await lapseLease(project.id);
      await expect(operations.createStudioReverseCommand({ ...operation, snapshot: fresh }, fresh)).rejects.toThrow(
        'revision or edit lease',
      );
    });

    it('commits generated registration with job completion, and rolls both back on publication failure', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id);
      await sut.appendRevision(append(project.id, user.id));
      const operations = ctx.get(MediaOperationRepository);
      const operation = await operations.create({
        ownerId: user.id,
        kind: MediaOperationKind.StudioReverseConform,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: 'Source reversal',
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: project.id,
        revisionId: null,
        snapshot: {},
        settings: {},
        estimate: null,
        totalUnits: 3,
        maxAttempts: 2,
      });
      const claim = await operations.claimNext({
        kinds: [MediaOperationKind.StudioReverseConform],
        workerId: 'local-reverse',
        leaseMs: LEASE_MS,
      });
      expect(claim?.operation.id).toBe(operation.id);
      await operations.beginValidation(operation.id, claim!.claimToken);
      const resource = {
        projectId: project.id,
        ownerId: user.id,
        sourceRevision: 1,
        id: `reverse-${operation.id}`,
        producer: 'reverse-conform',
        checksum: 'ab'.repeat(32),
        path: '/private/studio/reversed.mkv',
        derivedFrom: [`library-asset:${randomUUID()}`],
      };
      await expect(
        operations.publishValidated(operation.id, claim!.claimToken, async (tx) => {
          expect(tx.isTransaction).toBe(true);
          await sut.registerGeneratedResource(resource, tx);
          throw new Error('publication rolled back');
        }),
      ).rejects.toThrow('publication rolled back');
      expect(await sut.listGeneratedResources(project.id)).toEqual([]);
      expect((await operations.getForOwner(operation.id, user.id))?.status).toBe(MediaOperationStatus.Validating);
      await expect(
        operations.publishValidated(operation.id, claim!.claimToken, async (tx) => {
          await sut.registerGeneratedResource(resource, tx);
          await tx
            .updateTable('media_operation')
            .set({ result: { generatedId: resource.id, requiresClipRelink: true } })
            .where('id', '=', operation.id)
            .execute();
          return true;
        }),
      ).resolves.toBe('completed');
      expect(await sut.listGeneratedResources(project.id)).toHaveLength(1);
      expect(await operations.getForOwner(operation.id, user.id)).toMatchObject({
        status: MediaOperationStatus.Completed,
        result: { generatedId: resource.id, requiresClipRelink: true },
      });
    });

    it('revokes relinked generated media through distinct restoration and original ids, including after deletion', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const sourceId = asset.id!;
      const restoration = await defaultDatabase
        .insertInto('asset_restoration')
        .values({
          assetId: sourceId,
          ownerId: user.id,
          revision: 1,
          mode: 'faithful',
          workload: 'restore-video',
          destinationKind: 'local',
          destinationName: 'Local',
          sourceType: 'video',
          sourceChecksum: Buffer.from('ab'.repeat(32), 'hex'),
          sourceWidth: 1920,
          sourceHeight: 1080,
          previewRegion: { x: 0, y: 0, w: 1, h: 1 },
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect(restoration.id).not.toBe(sourceId);
      const project = await leasedProject(sut, user.id);
      await sut.appendRevision(
        append(project.id, user.id, {
          envelope: { graph: { clips: [{ restoredVersionId: restoration.id }] } },
        }),
      );
      expect(await sut.getIdsReferencingAssets([sourceId])).toEqual([project.id]);
      const resource = {
        projectId: project.id,
        ownerId: user.id,
        sourceRevision: 1,
        id: 'reverse',
        producer: 'reverse-conform',
        checksum: 'ab'.repeat(32),
        path: '/private/studio/reverse.mp4',
        derivedFrom: [`restored-version:${restoration.id}`],
      };
      await sut.registerGeneratedResource(resource);
      await sut.registerGeneratedResource(resource);
      expect((await sut.listGeneratedResources(project.id))[0].derivedFrom).toEqual([
        `restored-version:${restoration.id}`,
        `library-asset:${sourceId}`,
      ]);
      await sut.appendRevision(
        append(project.id, user.id, {
          expectedRevision: 1,
          requestKey: 'relinked',
          digest: 'relinked',
          envelope: { graph: { clips: [{ generatedId: 'reverse' }] } },
        }),
      );
      const projects = { forgetResolutions: vi.fn() };
      const previews = { revokeForProjects: vi.fn().mockResolvedValue(1) };
      const streams = { revokeForProjects: vi.fn().mockResolvedValue(1) };
      const operations = { listUnfinishedForProjects: vi.fn().mockResolvedValue([]) };
      const revocation = new StudioRevocationService(
        ctx.get(LoggingRepository),
        sut,
        projects as never,
        previews as never,
        streams as never,
        operations as never,
      );
      await revocation.onAssetLocked({ assetIds: [sourceId] });
      await revocation.onAssetTrash({ assetId: sourceId, userId: user.id });
      // Match production's post-delete event: the restoration FK has already cascaded.
      await defaultDatabase.deleteFrom('asset').where('id', '=', sourceId).execute();
      expect(
        await defaultDatabase.selectFrom('asset_restoration').select('id').where('id', '=', restoration.id).execute(),
      ).toEqual([]);
      await revocation.onAssetDelete({ assetId: sourceId, userId: user.id });
      for (const revoke of [projects.forgetResolutions, previews.revokeForProjects, streams.revokeForProjects]) {
        expect(revoke).toHaveBeenCalledTimes(3);
        expect(revoke).toHaveBeenNthCalledWith(1, [project.id]);
        expect(revoke).toHaveBeenNthCalledWith(2, [project.id]);
        expect(revoke).toHaveBeenNthCalledWith(3, [project.id]);
      }
    });

    it('persists immutable provenance, isolates projects, and finds relinked source revocations', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id);
      const other = await leasedProject(sut, user.id);
      await sut.appendRevision(append(project.id, user.id));
      const sourceId = randomUUID();
      const resource = {
        projectId: project.id,
        ownerId: user.id,
        sourceRevision: 1,
        id: 'reverse',
        producer: 'reverse-conform',
        checksum: 'ab'.repeat(32),
        path: '/private/studio/reverse.mp4',
        derivedFrom: [`library-asset:${sourceId}`],
      };

      await Promise.all([sut.registerGeneratedResource(resource), sut.registerGeneratedResource(resource)]);
      const storedLineage = await sql<{ type: string; length: number }>`
        SELECT jsonb_typeof("derivedFrom") AS type, jsonb_array_length("derivedFrom") AS length
        FROM public.studio_generated_resource WHERE "projectId" = ${project.id}::uuid AND id = ${resource.id}
      `.execute(defaultDatabase);
      expect(storedLineage.rows).toEqual([{ type: 'array', length: 1 }]);
      const reopened = new StudioProjectRepository(defaultDatabase);
      expect(await reopened.listGeneratedResources(project.id)).toEqual([
        {
          id: resource.id,
          producer: resource.producer,
          checksum: resource.checksum,
          path: resource.path,
          derivedFrom: resource.derivedFrom,
        },
      ]);
      expect(await reopened.listGeneratedResources(other.id)).toEqual([]);
      expect(await reopened.getIdsReferencingAssets([sourceId])).toEqual([project.id]);
      for (const changed of [
        { path: '/private/other.mp4' },
        { checksum: 'cd'.repeat(32) },
        { derivedFrom: [`library-asset:${randomUUID()}`] },
      ]) {
        await expect(sut.registerGeneratedResource({ ...resource, ...changed })).rejects.toThrow('cannot be rebound');
      }
      expect((await reopened.listGeneratedResources(project.id))[0].checksum).toBe(resource.checksum);

      await sut.trash(project.id, new Date(Date.now() + 1000));
      expect(await reopened.listGeneratedResources(project.id)).toEqual([]);
      await expect(sut.registerGeneratedResource(resource)).rejects.toThrow('unavailable');
      await sut.untrash(project.id);
      expect(await reopened.listGeneratedResources(project.id)).toHaveLength(1);
      await sut.delete(project.id);
      expect(await reopened.listGeneratedResources(project.id)).toEqual([]);
    });

    it('refuses another owner, an absent revision, and unchecked output metadata', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await leasedProject(sut, user.id);
      await sut.appendRevision(append(project.id, user.id));
      const resource = {
        projectId: project.id,
        ownerId: user.id,
        sourceRevision: 1,
        id: 'reverse',
        producer: 'reverse-conform',
        checksum: 'ab'.repeat(32),
        path: '/private/studio/reverse.mp4',
        derivedFrom: [`library-asset:${randomUUID()}`],
      };
      await expect(sut.registerGeneratedResource({ ...resource, ownerId: randomUUID() })).rejects.toThrow(
        'unavailable',
      );
      await expect(sut.registerGeneratedResource({ ...resource, sourceRevision: 2 })).rejects.toThrow('unavailable');
      await expect(sut.registerGeneratedResource({ ...resource, checksum: '' })).rejects.toThrow('Invalid generated');
      await expect(sut.registerGeneratedResource({ ...resource, derivedFrom: [] })).rejects.toThrow(
        'Invalid generated',
      );
      await expect(
        sut.registerGeneratedResource({ ...resource, derivedFrom: ['restored-version:invalid'] }),
      ).rejects.toThrow('Invalid generated restoration');
      await expect(
        sut.registerGeneratedResource({ ...resource, derivedFrom: [`restored-version:${randomUUID()}`] }),
      ).rejects.toThrow('restoration source is unavailable');
      expect(await sut.listGeneratedResources(project.id)).toEqual([]);
    });
  });

  describe('comments', () => {
    it('stores exact rational time and refuses a duplicate request key', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await sut.create({ ownerId: user.id, name: 'Lake trip' });
      const input = {
        projectId: project.id,
        authorId: user.id,
        revision: 0,
        timeNum: 1001,
        timeDen: 30_000,
        text: 'Hold the lake shot',
        requestKey: 'c-1',
      };

      const created = await sut.createComment(input);
      expect(created).toMatchObject({ timeNum: 1001, timeDen: 30_000 });
      expect(await sut.createComment(input)).toBeUndefined();
      expect((await sut.getCommentByRequestKey(project.id, 'c-1'))?.id).toBe(created!.id);

      const resolved = await sut.updateComment(project.id, created!.id, { resolvedById: user.id });
      expect(resolved?.resolvedAt).not.toBeNull();
      const reopened = await sut.updateComment(project.id, created!.id, { resolvedById: null });
      expect(reopened?.resolvedAt).toBeNull();
      expect(await sut.deleteComment(project.id, created!.id)).toBe(true);
    });
  });

  describe('project imports (FL-103 / FL-105)', () => {
    const item = (projectId: string, ownerId: string, overrides: Record<string, unknown> = {}) => ({
      projectId,
      id: randomUUID(),
      ownerId,
      contentType: 'audio/wav',
      checksum: 'cd'.repeat(32),
      sizeBytes: 5 * 1024 * 1024 * 1024,
      path: '/data/exports/owner/studio-imports/project/take.wav',
      fileName: 'Voiceover 1.webm',
      externalReferences: null,
      ...overrides,
    });

    it('binds one id to one file, answers identical retries and lists only live projects', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await sut.create({ ownerId: user.id, name: 'Voiceovers' });
      const take = item(project.id, user.id);

      const stored = await sut.registerImport(take);
      // bigint sizes above 4 GiB come back as exact numbers.
      expect(stored).toMatchObject({ ...take, sizeBytes: 5 * 1024 * 1024 * 1024 });
      await expect(sut.registerImport(take)).resolves.toMatchObject({ id: take.id, checksum: take.checksum });
      await expect(sut.registerImport({ ...take, checksum: 'ef'.repeat(32) })).rejects.toThrow(
        'Project import ids cannot be rebound to another file',
      );
      const svg = item(project.id, user.id, { contentType: 'image/svg+xml', externalReferences: 2 });
      await sut.registerImport(svg);

      expect((await sut.listImports(project.id)).map(({ id }) => id).sort()).toEqual([take.id, svg.id].sort());
      expect(await sut.listImportDeclarations(project.id)).toEqual(
        expect.arrayContaining([
          {
            id: take.id,
            contentType: 'audio/wav',
            checksum: take.checksum,
            sizeBytes: take.sizeBytes,
            path: take.path,
          },
          expect.objectContaining({ id: svg.id, externalReferences: 2 }),
        ]),
      );
      await expect(sut.getImport(project.id, take.id)).resolves.toMatchObject({ id: take.id });
      await expect(sut.getImport(project.id, randomUUID())).resolves.toBeUndefined();

      await defaultDatabase
        .updateTable('studio_project')
        .set({ deletedAt: new Date() })
        .where('id', '=', project.id)
        .execute();
      expect(await sut.listImports(project.id)).toEqual([]);
      await expect(sut.getImport(project.id, take.id)).resolves.toBeUndefined();
      await expect(sut.registerImport(item(project.id, user.id))).rejects.toThrow(
        'The project is unavailable for imports',
      );
    });

    it('counts bytes per owner, refuses archived projects and releases imports of deleted projects', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const kept = await sut.create({ ownerId: user.id, name: 'Kept' });
      const gone = await sut.create({ ownerId: user.id, name: 'Gone' });
      await sut.registerImport(item(kept.id, user.id, { sizeBytes: 100 }));
      const doomed = item(gone.id, user.id, { sizeBytes: 50, path: '/data/exports/o/studio-imports/g/a.wav' });
      await sut.registerImport(doomed);
      expect(await sut.getImportBytes(user.id)).toBe(150);

      await defaultDatabase
        .updateTable('studio_project')
        .set({ archivedAt: new Date() })
        .where('id', '=', kept.id)
        .execute();
      await expect(sut.registerImport(item(kept.id, user.id))).rejects.toThrow(
        'The project is unavailable for imports',
      );

      expect(await sut.listOrphanImportProjects()).toEqual([]);
      const unlink = vi.fn().mockResolvedValue(undefined);
      await sut.deleteImports(kept.id, user.id, unlink);
      expect(unlink).not.toHaveBeenCalled();
      expect(await sut.getImportBytes(user.id)).toBe(150);
      await sut.delete(gone.id);
      expect(await sut.listOrphanImportProjects()).toEqual([{ projectId: gone.id, ownerId: user.id }]);
      await sut.deleteImports(gone.id, user.id, unlink);
      expect(unlink).toHaveBeenCalledWith(expect.objectContaining({ id: doomed.id, path: doomed.path }));
      expect(await sut.listOrphanImportProjects()).toEqual([]);
      expect(await sut.getImportBytes(user.id)).toBe(100);
    });

    it('admits every numeric import count through the exact limit and refuses only a new id at capacity', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const project = await sut.create({ ownerId: user.id, name: 'Complete dependency closure' });
      const first = item(project.id, user.id);
      await sut.registerImport(first);
      for (let count = 1; count < STUDIO_IMPORT_MAX_PER_PROJECT; count++) {
        const next = item(project.id, user.id, { sizeBytes: 1 });
        await expect(sut.registerImport(next)).resolves.toMatchObject({ id: next.id });
      }
      expect(await sut.listImports(project.id)).toHaveLength(STUDIO_IMPORT_MAX_PER_PROJECT);
      await expect(sut.registerImport(first)).resolves.toMatchObject({ id: first.id, checksum: first.checksum });
      const refused = item(project.id, user.id);
      await expect(sut.registerImport(refused)).rejects.toThrow('The project has too many imports');
      await expect(sut.getImport(project.id, refused.id)).resolves.toBeUndefined();
      expect(await sut.listImports(project.id)).toHaveLength(STUDIO_IMPORT_MAX_PER_PROJECT);
      await expect(sut.registerImport({ ...first, checksum: 'ef'.repeat(32) })).rejects.toThrow(
        'Project import ids cannot be rebound to another file',
      );
    }, 30_000);

    it("refuses imports into someone else's project and invalid declarations", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const project = await sut.create({ ownerId: user.id, name: 'Mine' });
      await expect(sut.registerImport(item(project.id, other.id))).rejects.toThrow(
        'The project is unavailable for imports',
      );
      await expect(sut.registerImport(item(project.id, user.id, { path: 'relative/take.wav' }))).rejects.toThrow(
        'Invalid project import declaration',
      );
      await expect(sut.registerImport(item(project.id, user.id, { checksum: 'nothex' }))).rejects.toThrow(
        'Invalid project import declaration',
      );
      await expect(sut.registerImport(item(project.id, user.id, { externalReferences: -1 }))).rejects.toThrow(
        'Invalid project import declaration',
      );
      expect(await sut.listImports(project.id)).toEqual([]);
    });
  });
});
