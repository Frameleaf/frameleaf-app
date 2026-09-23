import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { SharedSpaceService } from 'src/services/shared-space.service.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { getForAlbum } from 'test/mappers.js';
import { newDate, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const metadata = (albumId: string, assetCount = 4) => ({
  albumId,
  assetCount,
  startDate: null,
  endDate: null,
  lastModifiedAssetTimestamp: null,
});

describe(SharedSpaceService.name, () => {
  let sut: SharedSpaceService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SharedSpaceService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getPreview', () => {
    it('shows an invited recipient what the space exposes, without any asset', async () => {
      const recipient = UserFactory.create();
      const space = AlbumFactory.from({ kind: AlbumKind.Space, albumName: 'Family', icon: 'mdiHomeHeart' }).build();
      const owner = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;
      const invitedAt = newDate();

      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: recipient.id,
        role: AlbumUserRole.Viewer,
        invitedById: owner.id,
        createdAt: invitedAt,
      });
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.album.getMetadataForIds.mockResolvedValue([metadata(space.id, 12)]);
      mocks.user.get.mockResolvedValue(owner);

      const preview = await sut.getPreview(AuthFactory.create(recipient), space.id);

      expect(preview).toEqual(
        expect.objectContaining({
          id: space.id,
          albumName: 'Family',
          icon: 'mdiHomeHeart',
          role: AlbumUserRole.Viewer,
          accepted: false,
          assetCount: 12,
          memberCount: 1,
        }),
      );
      // The preview is a summary, never media: nothing asset-shaped may appear on it.
      expect(preview).not.toHaveProperty('assets');
      expect(preview).not.toHaveProperty('albumThumbnailAssetId');
      expect(preview).not.toHaveProperty('assetIds');
    });

    it('counts with sensitive and Locked media excluded', async () => {
      const recipient = UserFactory.create();
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();

      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: recipient.id,
        role: AlbumUserRole.Editor,
        invitedById: null,
        createdAt: newDate(),
      });
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.album.getMetadataForIds.mockResolvedValue([metadata(space.id, 3)]);

      await sut.getPreview(AuthFactory.create(recipient), space.id);

      expect(mocks.album.getMetadataForIds).toHaveBeenCalledWith([space.id], { excludeNsfw: true });
    });

    it('tells a stranger nothing, not even that the space exists', async () => {
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      mocks.albumUser.getInvite.mockResolvedValue(void 0);
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await expect(sut.getPreview(AuthFactory.create(), space.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.album.getMetadataForIds).not.toHaveBeenCalled();
    });

    it('refuses an album that is not a shared space', async () => {
      const album = AlbumFactory.from({ kind: AlbumKind.Album }).build();
      mocks.albumUser.getInvite.mockResolvedValue(void 0);
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.getPreview(AuthFactory.create(), album.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks the preview accepted for someone already in the space', async () => {
      const memberId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space })
        .albumUser({ userId: memberId, role: AlbumUserRole.Editor })
        .build();
      const member = space.albumUsers.find(({ user }) => user.id === memberId)!.user;

      mocks.albumUser.getInvite.mockResolvedValue(void 0);
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.album.getMetadataForIds.mockResolvedValue([metadata(space.id)]);

      const preview = await sut.getPreview(AuthFactory.create(member), space.id);

      expect(preview.accepted).toBe(true);
      expect(preview.memberCount).toBe(2);
    });
  });

  describe('accept', () => {
    it('joins with the role the owner offered, not one from the request', async () => {
      const recipient = UserFactory.create();
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();

      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: recipient.id,
        role: AlbumUserRole.Viewer,
        invitedById: null,
        createdAt: newDate(),
      });
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await sut.accept(AuthFactory.create(recipient), space.id);

      expect(mocks.albumUser.create).toHaveBeenCalledWith({
        albumId: space.id,
        userId: recipient.id,
        role: AlbumUserRole.Viewer,
      });
      expect(mocks.albumUser.deleteInvite).toHaveBeenCalledWith({ albumId: space.id, userId: recipient.id });
    });

    it('refuses without an invitation, so membership is never self-granted', async () => {
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      mocks.albumUser.getInvite.mockResolvedValue(void 0);

      await expect(sut.accept(AuthFactory.create(), space.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.albumUser.create).not.toHaveBeenCalled();
    });
  });

  describe('decline', () => {
    it('removes the invitation and nothing else', async () => {
      const recipient = UserFactory.create();
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: recipient.id,
        role: AlbumUserRole.Editor,
        invitedById: null,
        createdAt: newDate(),
      });

      await sut.decline(AuthFactory.create(recipient), space.id);

      expect(mocks.albumUser.deleteInvite).toHaveBeenCalledWith({ albumId: space.id, userId: recipient.id });
      expect(mocks.albumUser.delete).not.toHaveBeenCalled();
      expect(mocks.album.delete).not.toHaveBeenCalled();
    });

    it('refuses when there is nothing to decline', async () => {
      mocks.albumUser.getInvite.mockResolvedValue(void 0);
      await expect(sut.decline(AuthFactory.create(), newUuid())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMembers', () => {
    it('lists members and pending invitations', async () => {
      const editorId = newUuid();
      const invitedUser = UserFactory.create();
      const space = AlbumFactory.from({ kind: AlbumKind.Space })
        .albumUser({ userId: editorId, role: AlbumUserRole.Editor })
        .build();
      const owner = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.albumUser.getInvitesForAlbum.mockResolvedValue([
        {
          albumId: space.id,
          userId: invitedUser.id,
          role: AlbumUserRole.Viewer,
          invitedById: owner.id,
          createdAt: newDate(),
        },
      ]);
      mocks.user.get.mockResolvedValue(invitedUser);

      const { members } = await sut.getMembers(AuthFactory.create(owner), space.id);

      expect(members).toHaveLength(3);
      expect(members.filter(({ pending }) => pending)).toEqual([
        expect.objectContaining({ role: AlbumUserRole.Viewer, pending: true }),
      ]);
    });
  });

  describe('removeInvitation', () => {
    it('lets the owner withdraw a pending invitation', async () => {
      const invitedId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      const owner = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: invitedId,
        role: AlbumUserRole.Viewer,
        invitedById: owner.id,
        createdAt: newDate(),
      });

      await sut.removeInvitation(AuthFactory.create(owner), space.id, invitedId);

      expect(mocks.albumUser.deleteInvite).toHaveBeenCalledWith({ albumId: space.id, userId: invitedId });
    });

    it('refuses an editor of the space', async () => {
      const editorId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space })
        .albumUser({ userId: editorId, role: AlbumUserRole.Editor })
        .build();
      const editor = space.albumUsers.find(({ user }) => user.id === editorId)!.user;

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await expect(sut.removeInvitation(AuthFactory.create(editor), space.id, newUuid())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.albumUser.deleteInvite).not.toHaveBeenCalled();
    });
  });

  describe('getInvitations', () => {
    it('skips an invitation whose space has been deleted', async () => {
      const recipient = UserFactory.create();
      mocks.albumUser.getInvitesForUser.mockResolvedValue([
        {
          albumId: newUuid(),
          userId: recipient.id,
          role: AlbumUserRole.Viewer,
          invitedById: null,
          createdAt: newDate(),
        },
      ]);
      mocks.album.getById.mockResolvedValue(void 0);

      await expect(sut.getInvitations(AuthFactory.create(recipient))).resolves.toEqual([]);
    });
  });

  /* ---------------------------------------------------------------- */
  /* The space page's panels (FL-55, third slice)                      */
  /* ---------------------------------------------------------------- */

  /** A space with an owner and one editor, both already members. */
  const spaceWithEditor = () => {
    const editorId = newUuid();
    const space = AlbumFactory.from({ kind: AlbumKind.Space })
      .albumUser({ userId: editorId, role: AlbumUserRole.Editor })
      .build();
    const owner = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;
    const editor = space.albumUsers.find(({ user }) => user.id === editorId)!.user;
    return { space, owner, editor };
  };

  const asOwner = (space: ReturnType<typeof spaceWithEditor>['space']) => {
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
    mocks.album.getById.mockResolvedValue(getForAlbum(space));
  };

  const asEditor = (space: ReturnType<typeof spaceWithEditor>['space']) => {
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
    mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([space.id]));
    mocks.album.getById.mockResolvedValue(getForAlbum(space));
  };

  describe('getLinkedAlbums', () => {
    it('counts only what is in both the album and the space, with sensitive and Locked media excluded', async () => {
      const { space, owner } = spaceWithEditor();
      const linkedAlbumId = newUuid();
      asOwner(space);
      mocks.albumUser.getLinkedAlbums.mockResolvedValue([
        {
          albumId: space.id,
          linkedAlbumId,
          linkedAlbumName: 'Summer',
          linkedAlbumIcon: 'mdiBeach',
          linkedById: owner.id,
          createdAt: newDate(),
        },
      ]);
      mocks.albumUser.getLinkedAlbumCounts.mockResolvedValue([
        { albumId: linkedAlbumId, assetCount: 7, thumbnailAssetId: null },
      ]);
      mocks.user.get.mockResolvedValue(owner);

      const { albums } = await sut.getLinkedAlbums(AuthFactory.create(owner), space.id);

      expect(albums).toEqual([
        expect.objectContaining({ id: linkedAlbumId, albumName: 'Summer', assetCount: 7, canUnlink: true }),
      ]);
      // The intersection is taken against the space, and sensitive/Locked media are dropped first.
      expect(mocks.albumUser.getLinkedAlbumCounts).toHaveBeenCalledWith(space.id, [linkedAlbumId], {
        excludeNsfw: true,
      });
    });

    it('refuses somebody who is not a member, even with an invitation', async () => {
      const { space } = spaceWithEditor();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await expect(sut.getLinkedAlbums(AuthFactory.create(), space.id)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('linkAlbum', () => {
    it('links an album the member can already read, without moving or sharing it', async () => {
      const { space, editor } = spaceWithEditor();
      const album = AlbumFactory.from({ kind: AlbumKind.Album }).build();
      asEditor(space);
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([space.id, album.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(space)).mockResolvedValueOnce(getForAlbum(album));
      mocks.albumUser.getLinkedAlbums.mockResolvedValue([]);
      mocks.albumUser.getLinkedAlbumCounts.mockResolvedValue([]);

      await sut.linkAlbum(AuthFactory.create(editor), space.id, album.id);

      expect(mocks.albumUser.createLinkedAlbum).toHaveBeenCalledWith({
        albumId: space.id,
        linkedAlbumId: album.id,
        linkedById: editor.id,
      });
      // A link is a reference: nothing about the album or its assets is touched.
      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.albumUser.create).not.toHaveBeenCalled();
    });

    it('refuses another shared space: spaces stay top level', async () => {
      const { space, editor } = spaceWithEditor();
      const other = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      asEditor(space);
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([space.id, other.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(space)).mockResolvedValueOnce(getForAlbum(other));

      await expect(sut.linkAlbum(AuthFactory.create(editor), space.id, other.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.albumUser.createLinkedAlbum).not.toHaveBeenCalled();
    });

    it('refuses a collection: a space lists albums, one level', async () => {
      const { space, editor } = spaceWithEditor();
      const collection = AlbumFactory.from({ kind: AlbumKind.Collection }).build();
      asEditor(space);
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([space.id, collection.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(space)).mockResolvedValueOnce(getForAlbum(collection));

      await expect(sut.linkAlbum(AuthFactory.create(editor), space.id, collection.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.albumUser.createLinkedAlbum).not.toHaveBeenCalled();
    });
  });

  describe('unlinkAlbum', () => {
    it('lets the space owner remove somebody else’s link, and removes only the link', async () => {
      const { space, owner, editor } = spaceWithEditor();
      const linkedAlbumId = newUuid();
      asOwner(space);
      mocks.albumUser.getLinkedAlbum.mockResolvedValue({
        albumId: space.id,
        linkedAlbumId,
        linkedAlbumName: 'Summer',
        linkedAlbumIcon: null,
        linkedById: editor.id,
        createdAt: newDate(),
      });

      await sut.unlinkAlbum(AuthFactory.create(owner), space.id, linkedAlbumId);

      expect(mocks.albumUser.deleteLinkedAlbum).toHaveBeenCalledWith(space.id, linkedAlbumId);
      expect(mocks.album.delete).not.toHaveBeenCalled();
      expect(mocks.albumUser.delete).not.toHaveBeenCalled();
    });

    it('refuses a member who neither made the link nor owns the space', async () => {
      const { space, editor } = spaceWithEditor();
      const linkedAlbumId = newUuid();
      asEditor(space);
      mocks.albumUser.getLinkedAlbum.mockResolvedValue({
        albumId: space.id,
        linkedAlbumId,
        linkedAlbumName: 'Summer',
        linkedAlbumIcon: null,
        linkedById: newUuid(),
        createdAt: newDate(),
      });

      await expect(sut.unlinkAlbum(AuthFactory.create(editor), space.id, linkedAlbumId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.albumUser.deleteLinkedAlbum).not.toHaveBeenCalled();
    });
  });

  describe('getPeople', () => {
    it('shows the space’s own identity for a linked person and never the owner’s person record', async () => {
      const { space, owner, editor } = spaceWithEditor();
      const personGroupId = newUuid();
      const linkId = newUuid();
      const coverAssetId = newUuid();
      asOwner(space);
      mocks.albumUser.getLinkedPeople.mockResolvedValue([
        {
          id: linkId,
          albumId: space.id,
          personOwnerId: editor.id,
          personGroupId,
          name: 'Gran',
          coverAssetId,
          createdAt: newDate(),
        },
      ]);
      mocks.albumUser.getLinkedPersonCounts.mockResolvedValue([{ personGroupId, assetCount: 9 }]);
      mocks.albumUser.getSpacePersonCandidates.mockResolvedValue([]);
      mocks.user.get.mockResolvedValue(editor);

      const { linked } = await sut.getPeople(AuthFactory.create(owner), space.id);

      expect(linked).toEqual([
        expect.objectContaining({ id: linkId, name: 'Gran', coverAssetId, assetCount: 9, canUnlink: true }),
      ]);
      // The person's own identity never crosses the space.
      expect(JSON.stringify(linked)).not.toContain(personGroupId);
    });

    it('offers only the caller’s own people as candidates, and not ones they already linked', async () => {
      const { space, editor } = spaceWithEditor();
      const alreadyLinked = newUuid();
      const fresh = newUuid();
      asEditor(space);
      mocks.albumUser.getLinkedPeople.mockResolvedValue([
        {
          id: newUuid(),
          albumId: space.id,
          personOwnerId: editor.id,
          personGroupId: alreadyLinked,
          name: 'Gran',
          coverAssetId: null,
          createdAt: newDate(),
        },
      ]);
      mocks.albumUser.getLinkedPersonCounts.mockResolvedValue([]);
      mocks.user.get.mockResolvedValue(editor);
      mocks.albumUser.getSpacePersonCandidates.mockResolvedValue([
        {
          personGroupId: alreadyLinked,
          name: 'Gran',
          thumbnailPath: '/thumb-a',
          isHidden: false,
          isFavorite: false,
          color: null,
          birthDate: null,
          updatedAt: newDate(),
          assetCount: 4,
        },
        {
          personGroupId: fresh,
          name: 'Sam',
          thumbnailPath: '/thumb-b',
          isHidden: false,
          isFavorite: false,
          color: null,
          birthDate: null,
          updatedAt: newDate(),
          assetCount: 2,
        },
      ]);

      const { candidates } = await sut.getPeople(AuthFactory.create(editor), space.id);

      expect(candidates).toEqual([expect.objectContaining({ id: fresh, name: 'Sam' })]);
      // Candidates are scoped to the caller's own people, inside the space, without sensitive/Locked media.
      expect(mocks.albumUser.getSpacePersonCandidates).toHaveBeenCalledWith(space.id, editor.id, {
        excludeNsfw: true,
      });
    });
  });

  describe('linkPerson', () => {
    it('refuses a person the caller does not own', async () => {
      const { space, editor } = spaceWithEditor();
      asEditor(space);
      mocks.person.getByGroupId.mockResolvedValue(void 0);

      await expect(
        sut.linkPerson(AuthFactory.create(editor), space.id, { personId: newUuid() }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.albumUser.createLinkedPerson).not.toHaveBeenCalled();
    });
  });

  describe('unlinkPerson', () => {
    it('removes only the link', async () => {
      const { space, editor } = spaceWithEditor();
      const linkId = newUuid();
      asEditor(space);
      mocks.albumUser.getLinkedPerson.mockResolvedValue({
        id: linkId,
        albumId: space.id,
        personOwnerId: editor.id,
        personGroupId: newUuid(),
        name: 'Gran',
        coverAssetId: null,
        createdAt: newDate(),
      });

      await sut.unlinkPerson(AuthFactory.create(editor), space.id, linkId);

      expect(mocks.albumUser.deleteLinkedPerson).toHaveBeenCalledWith(linkId);
      expect(mocks.person.delete).not.toHaveBeenCalled();
      expect(mocks.person.update).not.toHaveBeenCalled();
    });

    it('refuses a link belonging to another space', async () => {
      const { space, owner } = spaceWithEditor();
      const linkId = newUuid();
      asOwner(space);
      mocks.albumUser.getLinkedPerson.mockResolvedValue({
        id: linkId,
        albumId: newUuid(),
        personOwnerId: owner.id,
        personGroupId: newUuid(),
        name: 'Gran',
        coverAssetId: null,
        createdAt: newDate(),
      });

      await expect(sut.unlinkPerson(AuthFactory.create(owner), space.id, linkId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.albumUser.deleteLinkedPerson).not.toHaveBeenCalled();
    });
  });

  describe('getNew', () => {
    it('treats the whole space as new when the member has never marked it seen', async () => {
      const { space, editor } = spaceWithEditor();
      asEditor(space);
      mocks.albumUser.getSpaceVisit.mockResolvedValue(void 0);
      mocks.albumUser.getSpaceNewAssetCount.mockResolvedValue(12);
      mocks.albumUser.getSpaceNewAssetIds.mockResolvedValue([]);

      const result = await sut.getNew(AuthFactory.create(editor), space.id);

      expect(result).toEqual({ lastVisitedAt: null, assetCount: 12, assetIds: [] });
      // No marker means no `since`; the caller's own additions are still excluded.
      expect(mocks.albumUser.getSpaceNewAssetCount).toHaveBeenCalledWith(
        space.id,
        { since: undefined, viewerId: editor.id },
        { excludeNsfw: true },
      );
    });

    it('counts from the member’s own marker', async () => {
      const { space, editor } = spaceWithEditor();
      const lastSeenAt = newDate();
      asEditor(space);
      mocks.albumUser.getSpaceVisit.mockResolvedValue({ albumId: space.id, userId: editor.id, lastSeenAt });
      mocks.albumUser.getSpaceNewAssetCount.mockResolvedValue(3);
      mocks.albumUser.getSpaceNewAssetIds.mockResolvedValue([]);

      await sut.getNew(AuthFactory.create(editor), space.id);

      expect(mocks.albumUser.getSpaceNewAssetCount).toHaveBeenCalledWith(
        space.id,
        { since: lastSeenAt, viewerId: editor.id },
        { excludeNsfw: true },
      );
    });
  });

  describe('markVisited', () => {
    it('moves only this member’s marker', async () => {
      const { space, editor } = spaceWithEditor();
      asEditor(space);
      mocks.albumUser.getSpaceVisit.mockResolvedValue(void 0);
      mocks.albumUser.getSpaceNewAssetCount.mockResolvedValue(0);
      mocks.albumUser.getSpaceNewAssetIds.mockResolvedValue([]);

      await sut.markVisited(AuthFactory.create(editor), space.id);

      expect(mocks.albumUser.setSpaceVisit).toHaveBeenCalledWith(
        { albumId: space.id, userId: editor.id },
        expect.any(Date),
      );
    });
  });
});
