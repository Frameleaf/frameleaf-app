import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ActivityRepository } from 'src/repositories/activity.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { SharedSpaceService } from 'src/services/shared-space.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

/**
 * FL-55: shared spaces against a real PostgreSQL database — who may do what (owner, editor,
 * viewer, and the owner of a linked source album), what happens when a source album or item goes
 * away underneath a space, and that taking somebody out of a space never touches their originals
 * or where their own albums sit.
 */
let database: Kysely<DB>;

const options = () => ({
  database,
  real: [
    AccessRepository,
    ActivityRepository,
    AlbumRepository,
    AlbumUserRepository,
    AssetRepository,
    ClassificationRepository,
    MapRepository,
    PartnerRepository,
    PersonRepository,
    SmartAlbumRepository,
    TagRepository,
    UserRepository,
  ],
  mock: [EventRepository, LoggingRepository, WebsocketRepository],
});

const setup = () => {
  const spaces = newMediumService(SharedSpaceService, options());
  const albums = newMediumService(AlbumService, options());
  spaces.ctx.getMock(EventRepository).emit.mockResolvedValue();
  albums.ctx.getMock(EventRepository).emit.mockResolvedValue();
  return { sut: spaces.sut, albums: albums.sut, ctx: spaces.ctx };
};

const authOf = (id: string): AuthDto => factory.auth({ user: { id } });

/** A space owned by `owner`, with `editor` and `viewer` joined through invitations they accepted. */
const newSpace = async ({ sut, albums, ctx }: ReturnType<typeof setup>) => {
  const { user: owner } = await ctx.newUser();
  const { user: editor } = await ctx.newUser();
  const { user: viewer } = await ctx.newUser();
  const space = await albums.create(authOf(owner.id), {
    albumName: 'Family',
    kind: AlbumKind.Space,
    albumUsers: [
      { userId: editor.id, role: AlbumUserRole.Editor },
      { userId: viewer.id, role: AlbumUserRole.Viewer },
    ],
  });
  await sut.accept(authOf(editor.id), space.id);
  await sut.accept(authOf(viewer.id), space.id);
  return { owner, editor, viewer, space };
};

beforeAll(async () => {
  database = await getActiveForkKyselyDB();
});

describe(SharedSpaceService.name, () => {
  describe('roles', () => {
    it('lets the owner and an editor contribute, and a viewer only look', async () => {
      const context = setup();
      const { albums, ctx } = context;
      const { owner, editor, viewer, space } = await newSpace(context);
      const { asset: editorAsset } = await ctx.newAsset({ ownerId: editor.id });
      const { asset: viewerAsset } = await ctx.newAsset({ ownerId: viewer.id });
      const { asset: ownerAsset } = await ctx.newAsset({ ownerId: owner.id });

      await expect(albums.addAssets(authOf(owner.id), space.id, { ids: [ownerAsset.id] })).resolves.toEqual([
        expect.objectContaining({ id: ownerAsset.id, success: true }),
      ]);
      await expect(albums.addAssets(authOf(editor.id), space.id, { ids: [editorAsset.id] })).resolves.toEqual([
        expect.objectContaining({ id: editorAsset.id, success: true }),
      ]);
      await expect(albums.addAssets(authOf(viewer.id), space.id, { ids: [viewerAsset.id] })).rejects.toThrow(
        'Not found or no albumAsset.create access',
      );

      // Membership is the owner's alone: an editor cannot take anybody out.
      await expect(albums.removeUser(authOf(editor.id), space.id, viewer.id)).rejects.toThrow();
      await expect(
        albums.updateUser(authOf(editor.id), space.id, viewer.id, { role: AlbumUserRole.Editor }),
      ).rejects.toThrow();
    });

    it('lets an editor link their own album; a viewer links nothing', async () => {
      const context = setup();
      const { sut, ctx } = context;
      const { editor, viewer, space } = await newSpace(context);
      const { album: editorAlbum } = await ctx.newAlbum({ ownerId: editor.id, albumName: 'Hike' });
      const { album: viewerAlbum } = await ctx.newAlbum({ ownerId: viewer.id, albumName: 'Mine' });

      const { albums: linked } = await sut.linkAlbum(authOf(editor.id), space.id, editorAlbum.id);
      expect(linked.map(({ id }) => id)).toEqual([editorAlbum.id]);
      await expect(sut.linkAlbum(authOf(viewer.id), space.id, viewerAlbum.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('lets only the source album’s linker or the space owner unlink it', async () => {
      const context = setup();
      const { sut, ctx } = context;
      const { owner, editor, viewer, space } = await newSpace(context);
      const { album: source } = await ctx.newAlbum({ ownerId: editor.id, albumName: 'Hike' });
      await sut.linkAlbum(authOf(editor.id), space.id, source.id);

      const asViewer = await sut.getLinkedAlbums(authOf(viewer.id), space.id);
      expect(asViewer.albums).toEqual([expect.objectContaining({ id: source.id, canUnlink: false })]);
      await expect(sut.unlinkAlbum(authOf(viewer.id), space.id, source.id)).rejects.toBeInstanceOf(ForbiddenException);

      // The source owner (who linked it) may undo it; so may the space owner.
      await sut.unlinkAlbum(authOf(editor.id), space.id, source.id);
      await sut.linkAlbum(authOf(editor.id), space.id, source.id);
      await sut.unlinkAlbum(authOf(owner.id), space.id, source.id);
      await expect(sut.getLinkedAlbums(authOf(owner.id), space.id)).resolves.toEqual({ albums: [] });

      // Unlinking removed the reference only: the album is still the editor's, where it was.
      const kept = await ctx.get(AlbumRepository).getById(source.id, { withAssets: false });
      expect(kept).toEqual(expect.objectContaining({ id: source.id, parentId: null }));
    });

    it('never lets a member link somebody else’s album into the space', async () => {
      const context = setup();
      const { sut, ctx } = context;
      const { owner, editor, space } = await newSpace(context);
      const { album: ownersPrivate } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'Private' });

      await expect(sut.linkAlbum(authOf(editor.id), space.id, ownersPrivate.id)).rejects.toThrow(
        'Not found or no album.read access',
      );
    });
  });

  describe('stale sources', () => {
    it('drops a linked album that its owner deleted, without failing the space', async () => {
      const context = setup();
      const { sut, albums, ctx } = context;
      const { owner, editor, space } = await newSpace(context);
      const { album: source } = await ctx.newAlbum({ ownerId: editor.id, albumName: 'Gone soon' });
      await sut.linkAlbum(authOf(editor.id), space.id, source.id);

      await albums.delete(authOf(editor.id), source.id);

      await expect(sut.getLinkedAlbums(authOf(owner.id), space.id)).resolves.toEqual({ albums: [] });
      await expect(sut.linkAlbum(authOf(editor.id), space.id, source.id)).rejects.toThrow();
      await expect(sut.unlinkAlbum(authOf(owner.id), space.id, source.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('leaves a trashed item out of what is new in the space', async () => {
      const context = setup();
      const { sut, albums, ctx } = context;
      const { owner, editor, space } = await newSpace(context);
      const { asset: kept } = await ctx.newAsset({ ownerId: editor.id });
      const { asset: trashed } = await ctx.newAsset({ ownerId: editor.id });
      await albums.addAssets(authOf(editor.id), space.id, { ids: [kept.id, trashed.id] });

      await ctx.softDeleteAsset(trashed.id);

      const fresh = await sut.getNew(authOf(owner.id), space.id);
      expect(fresh.assetIds).toContain(kept.id);
      expect(fresh.assetIds).not.toContain(trashed.id);
    });
  });

  describe('revocation', () => {
    it('keeps a removed contributor’s originals and album placement, and closes the space to them', async () => {
      const context = setup();
      const { sut, albums, ctx } = context;
      const { owner, editor, space } = await newSpace(context);
      const { album: collection } = await ctx.newAlbum({ ownerId: editor.id, kind: AlbumKind.Collection });
      const { album: personal } = await ctx.newAlbum({ ownerId: editor.id, parentId: collection.id });
      const { asset } = await ctx.newAsset({ ownerId: editor.id });
      await albums.addAssets(authOf(editor.id), space.id, { ids: [asset.id] });
      await sut.linkAlbum(authOf(editor.id), space.id, personal.id);

      await albums.removeUser(authOf(owner.id), space.id, editor.id);

      // The original is still theirs, untouched and not in the trash.
      const original = await ctx.database
        .selectFrom('asset')
        .select(['id', 'ownerId', 'deletedAt'])
        .where('id', '=', asset.id)
        .executeTakeFirstOrThrow();
      expect(original).toEqual({ id: asset.id, ownerId: editor.id, deletedAt: null });
      // Their own album stays in their own collection.
      const placement = await ctx.get(AlbumRepository).getById(personal.id, { withAssets: false });
      expect(placement?.parentId).toBe(collection.id);
      // And the space is closed to them.
      await expect(sut.getLinkedAlbums(authOf(editor.id), space.id)).rejects.toThrow();
      await expect(sut.getNew(authOf(editor.id), space.id)).rejects.toThrow();
    });

    it('removing one member deletes nothing and changes nothing for the others', async () => {
      const context = setup();
      const { sut, albums, ctx } = context;
      const { owner, editor, viewer, space } = await newSpace(context);
      const { asset } = await ctx.newAsset({ ownerId: editor.id });
      await albums.addAssets(authOf(editor.id), space.id, { ids: [asset.id] });

      await albums.removeUser(authOf(owner.id), space.id, viewer.id);

      // Removing the viewer changes nothing for anyone else.
      const fresh = await sut.getNew(authOf(owner.id), space.id);
      expect(fresh.assetIds).toContain(asset.id);
      await expect(
        ctx.database.selectFrom('asset').select('id').where('id', '=', asset.id).executeTakeFirst(),
      ).resolves.toEqual({ id: asset.id });
    });
  });
});
