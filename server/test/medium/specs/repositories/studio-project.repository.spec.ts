import { Kysely } from 'kysely';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioProjectRepository, StudioRevisionAppend } from 'src/repositories/studio-project.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
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
});
