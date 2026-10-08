import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { automock, getKyselyDB } from 'test/utils.js';

/**
 * FL-112 ruling (2026-09-30): an owner-only Studio route (export, import, bundle, changes) refuses a
 * reviewer, who can see the project, with `403`; anyone who cannot see it, a removed member and a
 * shared link included, gets `404` exactly as for a project that does not exist.
 */
let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => database?.destroy());

describe('StudioProjectService.requireOwnedProject (FL-112)', () => {
  it('lets the owner through, refuses a reviewer with 403 and everyone else with 404', async () => {
    const { sut: resources, ctx } = newMediumService(StudioResourceService, {
      database,
      real: [AccessRepository, AssetRepository, CryptoRepository, IntegrityRepository],
      mock: [LoggingRepository],
    });
    const { user: owner } = await ctx.newUser();
    const { user: reviewer } = await ctx.newUser();
    const { user: removed } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();
    const { album: space } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Space });
    await ctx.newAlbumUser({ albumId: space.id, userId: reviewer.id, role: AlbumUserRole.Viewer });
    await ctx.newAlbumUser({ albumId: space.id, userId: removed.id, role: AlbumUserRole.Editor });

    const projects = new StudioProjectRepository(database);
    const graph = { id: 'sequence', tracks: [] };
    const { project } = await projects.createWithRevision({
      ownerId: owner.id,
      spaceId: space.id,
      name: 'Owner only',
      revision: {
        authorId: owner.id,
        envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'test', graph },
        digest: 'revision-1',
        graphBytes: JSON.stringify(graph).length,
        summary: {},
        requestKey: null,
      },
    });
    const sut = new StudioProjectService(
      ctx.getMock(LoggingRepository),
      projects,
      ctx.get(AccessRepository),
      resources,
      automock(WebsocketRepository, { args: [undefined, ctx.getMock(LoggingRepository)], strict: false }),
    );
    const message = 'Only the owner can export a Studio project';
    const attempt = (user: { id: string }, sharedLink = false) =>
      sut.requireOwnedProject(
        sharedLink ? factory.auth({ user, sharedLink: {} as never }) : factory.auth({ user }),
        project.id,
        message,
      );

    await expect(attempt(owner)).resolves.toMatchObject({ id: project.id });

    const refused = await attempt(reviewer).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ForbiddenException);
    expect((refused as ForbiddenException).message).toBe(message);

    // a member removed from the space can no longer see it, so it is as if it did not exist
    await expect(attempt(removed)).rejects.toBeInstanceOf(ForbiddenException);
    await new AlbumUserRepository(database).delete({ albumId: space.id, userId: removed.id });
    await expect(attempt(removed)).rejects.toBeInstanceOf(NotFoundException);

    await expect(attempt(stranger)).rejects.toBeInstanceOf(NotFoundException);
    await expect(attempt(owner, true)).rejects.toBeInstanceOf(NotFoundException);

    // FL-91: an archived project is off the shelf for everybody but its owner, so a reviewer of it
    // cannot see it any more (404) while the owner still gets through
    await projects.update(project.id, { archivedAt: new Date() });
    await expect(attempt(reviewer)).rejects.toBeInstanceOf(NotFoundException);
    await expect(attempt(owner)).resolves.toMatchObject({ id: project.id });
  });
});
