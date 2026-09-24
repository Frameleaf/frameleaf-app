import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SharedSpaceEvent } from 'src/repositories/album-user.repository.js';
import { AlbumKind, AlbumUserRole, SharedSpaceEventType } from 'src/enum.js';
import { SharedSpaceService } from 'src/services/shared-space.service.js';
import { ActivityFactory } from 'test/factories/activity.factory.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { getForActivity, getForAlbum } from 'test/mappers.js';
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

    // The album-user repository mock is strict. These are the plain writes and lookups every
    // comment path makes; a test that cares about one sets or asserts it itself.
    mocks.albumUser.createMentions.mockResolvedValue();
    mocks.albumUser.deleteMentions.mockResolvedValue();
    mocks.albumUser.getMentions.mockResolvedValue([]);
    mocks.albumUser.createSpaceEvent.mockResolvedValue();
    mocks.albumUser.createCommentThread.mockResolvedValue();
    mocks.albumUser.getCommentParents.mockResolvedValue([]);
    mocks.albumUser.getCommentReplies.mockResolvedValue([]);
    mocks.albumUser.deleteCommentWithReplies.mockResolvedValue();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('recipient groups (FL-55)', () => {
    const group = (ownerId: string, userIds: string[], name = 'Family') => ({
      id: newUuid(),
      ownerId,
      name,
      userIds,
      createdAt: newDate(),
      updatedAt: newDate(),
    });

    it('lists only the caller’s own groups, with the people who still have an account', async () => {
      const owner = UserFactory.create();
      const jamie = UserFactory.create({ name: 'Jamie' });
      const saved = group(owner.id, [jamie.id, newUuid()]);
      mocks.albumUser.getRecipientGroups.mockResolvedValue([saved]);
      mocks.user.getList.mockResolvedValue([owner, jamie] as never);

      const groups = await sut.getRecipientGroups(AuthFactory.create(owner));

      expect(mocks.albumUser.getRecipientGroups).toHaveBeenCalledWith(owner.id);
      expect(groups).toEqual([expect.objectContaining({ id: saved.id, name: 'Family' })]);
      // A deleted account drops out of the group rather than failing it.
      expect(groups[0].users.map(({ id }) => id)).toEqual([jamie.id]);
    });

    it('saves a group without inviting anybody or changing any access', async () => {
      const owner = UserFactory.create();
      const jamie = UserFactory.create();
      mocks.user.getList.mockResolvedValue([owner, jamie] as never);
      mocks.albumUser.createRecipientGroup.mockResolvedValue(group(owner.id, [jamie.id]));

      await sut.createRecipientGroup(AuthFactory.create(owner), {
        name: 'Family',
        userIds: [jamie.id, jamie.id, owner.id],
      });

      // Yourself and repeats are dropped; the strict album-user mock proves nothing else was written.
      expect(mocks.albumUser.createRecipientGroup).toHaveBeenCalledWith(owner.id, 'Family', [jamie.id]);
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('refuses an unknown person', async () => {
      const owner = UserFactory.create();
      mocks.user.getList.mockResolvedValue([owner] as never);

      await expect(
        sut.createRecipientGroup(AuthFactory.create(owner), { name: 'Family', userIds: [newUuid()] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.albumUser.createRecipientGroup).not.toHaveBeenCalled();
    });

    it('edits a group without touching invitations or memberships made from it', async () => {
      const owner = UserFactory.create();
      const jamie = UserFactory.create();
      const sam = UserFactory.create();
      const saved = group(owner.id, [sam.id], 'Hiking');
      mocks.user.getList.mockResolvedValue([owner, jamie, sam] as never);
      mocks.albumUser.updateRecipientGroup.mockResolvedValue(saved);

      await sut.updateRecipientGroup(AuthFactory.create(owner), saved.id, { name: 'Hiking', userIds: [sam.id] });

      expect(mocks.albumUser.updateRecipientGroup).toHaveBeenCalledWith(owner.id, saved.id, {
        name: 'Hiking',
        userIds: [sam.id],
      });
      // Jamie was taken out of the group, but nobody is removed from or invited to any space.
      expect(mocks.albumUser.delete).not.toHaveBeenCalled();
      expect(mocks.albumUser.deleteInvite).not.toHaveBeenCalled();
      expect(mocks.albumUser.createInvite).not.toHaveBeenCalled();
    });

    it('treats somebody else’s group as not found, for reading, editing and deleting', async () => {
      const stranger = UserFactory.create();
      mocks.user.getList.mockResolvedValue([stranger] as never);
      mocks.albumUser.updateRecipientGroup.mockResolvedValue(undefined);
      mocks.albumUser.deleteRecipientGroup.mockResolvedValue(false);
      const id = newUuid();

      await expect(
        sut.updateRecipientGroup(AuthFactory.create(stranger), id, { name: 'Mine now' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.deleteRecipientGroup(AuthFactory.create(stranger), id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // The lookups are always scoped to the caller as owner.
      expect(mocks.albumUser.updateRecipientGroup).toHaveBeenCalledWith(stranger.id, id, {
        name: 'Mine now',
        userIds: undefined,
      });
      expect(mocks.albumUser.deleteRecipientGroup).toHaveBeenCalledWith(stranger.id, id);
    });
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
      mocks.albumUser.create.mockResolvedValue({ albumId: space.id, userId: recipient.id, role: AlbumUserRole.Viewer });
      mocks.albumUser.deleteInvite.mockResolvedValue();

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

      mocks.albumUser.deleteInvite.mockResolvedValue();

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

      mocks.albumUser.deleteInvite.mockResolvedValue();

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

  /** The access check answers only for the ids it is asked about, as the real one does. */
  const readable = (...albumIds: string[]) => {
    mocks.access.album.checkSharedAlbumAccess.mockImplementation((_userId, ids) =>
      Promise.resolve(new Set([...ids].filter((id) => albumIds.includes(id)))),
    );
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
      readable(space.id, album.id);
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(space)).mockResolvedValueOnce(getForAlbum(album));
      mocks.albumUser.getLinkedAlbums.mockResolvedValue([]);
      mocks.albumUser.getLinkedAlbumCounts.mockResolvedValue([]);
      mocks.albumUser.createLinkedAlbum.mockResolvedValue();

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
      readable(space.id, other.id);
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
      readable(space.id, collection.id);
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

      mocks.albumUser.deleteLinkedAlbum.mockResolvedValue();

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

      mocks.albumUser.deleteLinkedPerson.mockResolvedValue();

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

      mocks.albumUser.setSpaceVisit.mockResolvedValue();

      await sut.markVisited(AuthFactory.create(editor), space.id);

      expect(mocks.albumUser.setSpaceVisit).toHaveBeenCalledWith(
        { albumId: space.id, userId: editor.id },
        expect.any(Date),
      );
    });
  });

  describe('getActivity', () => {
    const event = (overrides: Partial<SharedSpaceEvent>): SharedSpaceEvent => ({
      id: newUuid(),
      albumId: newUuid(),
      actorId: null,
      type: SharedSpaceEventType.AssetsAdded,
      targetUserId: null,
      activityId: null,
      assetIds: [],
      subject: null,
      createdAt: newDate(),
      activityAssetId: null,
      activityComment: null,
      ...overrides,
    });

    it('names only the items the member may see, and drops an event with none left', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asEditor(space);
      const visibleId = newUuid();
      const lockedId = newUuid();
      mocks.albumUser.getSpaceVisit.mockResolvedValue(void 0);
      mocks.albumUser.getSpaceEvents
        .mockResolvedValueOnce([
          event({ albumId: space.id, actorId: owner.id, assetIds: [visibleId, lockedId] }),
          event({ albumId: space.id, actorId: owner.id, assetIds: [lockedId] }),
          event({
            albumId: space.id,
            actorId: owner.id,
            type: SharedSpaceEventType.Comment,
            activityId: newUuid(),
            activityAssetId: lockedId,
            activityComment: 'about the locked one',
          }),
        ])
        .mockResolvedValueOnce([]);
      // Only the visible item survives the viewer's filter, whichever set is asked for.
      mocks.albumUser.filterVisibleSpaceAssetIds.mockResolvedValue(new Set([visibleId]));
      mocks.albumUser.getMentions.mockResolvedValue([]);
      mocks.user.get.mockResolvedValue(owner);

      const result = await sut.getActivity(AuthFactory.create(editor), space.id, {});

      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual(expect.objectContaining({ assetIds: [visibleId], assetCount: 1 }));
      // Nothing about the Locked item leaks: not its id, not the comment about it, not a count.
      expect(JSON.stringify(result)).not.toContain(lockedId);
      expect(JSON.stringify(result)).not.toContain('about the locked one');
      // Additions are checked against what is still in the space, with the space's own exclusions.
      expect(mocks.albumUser.filterVisibleSpaceAssetIds).toHaveBeenCalledWith(
        space.id,
        expect.arrayContaining([visibleId, lockedId]),
        { excludeNsfw: true },
        { inSpace: true },
      );
    });

    it('counts as unread only what others did after the member’s marker, among what they may see', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asEditor(space);
      const lastSeenAt = new Date('2026-09-20T00:00:00Z');
      const after = new Date('2026-09-21T00:00:00Z');
      mocks.albumUser.getSpaceVisit.mockResolvedValue({ albumId: space.id, userId: editor.id, lastSeenAt });
      mocks.albumUser.getSpaceEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([
        event({
          albumId: space.id,
          actorId: owner.id,
          type: SharedSpaceEventType.MemberJoined,
          targetUserId: owner.id,
          createdAt: after,
        }),
        // The member's own doing is not news to them.
        event({ albumId: space.id, actorId: editor.id, type: SharedSpaceEventType.AlbumLinked, createdAt: after }),
        // Somebody else added something the member cannot see: not counted either.
        event({ albumId: space.id, actorId: owner.id, assetIds: [newUuid()], createdAt: after }),
      ]);
      mocks.albumUser.filterVisibleSpaceAssetIds.mockResolvedValue(new Set());
      mocks.albumUser.getMentions.mockResolvedValue([]);

      const result = await sut.getActivity(AuthFactory.create(editor), space.id, {});

      expect(result.unreadCount).toBe(1);
      expect(result.lastVisitedAt).not.toBeNull();
      expect(mocks.albumUser.getSpaceEvents).toHaveBeenCalledWith(space.id, { since: lastSeenAt, take: 500 });
    });

    it('is for members only, even for somebody who can read the album row', async () => {
      const { space } = spaceWithEditor();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await expect(sut.getActivity(AuthFactory.create(), space.id, {})).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.albumUser.getSpaceEvents).not.toHaveBeenCalled();
    });
  });

  describe('createComment', () => {
    it('refuses a mention of somebody who is not a member, before writing anything', async () => {
      const { space, editor } = spaceWithEditor();
      asEditor(space);
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([space.id]));

      await expect(
        sut.createComment(AuthFactory.create(editor), space.id, { comment: `look @{${newUuid()}}` }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.activity.create).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('stores mentions by id, records the feed event and notifies the mentioned member, never the author', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asEditor(space);
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([space.id]));
      const activity = ActivityFactory.from({ albumId: space.id, userId: editor.id, comment: 'x' })
        .user({ id: editor.id, name: editor.name })
        .build();
      mocks.activity.create.mockResolvedValue(getForActivity(activity));
      mocks.user.get.mockResolvedValue(owner);
      const comment = `Look @{${owner.id}}, and me @{${editor.id}}`;

      const result = await sut.createComment(AuthFactory.create(editor), space.id, { comment });

      expect(mocks.activity.create).toHaveBeenCalledWith({
        userId: editor.id,
        albumId: space.id,
        assetId: null,
        isLiked: false,
        comment,
      });
      expect(mocks.albumUser.createMentions).toHaveBeenCalledWith(activity.id, [owner.id, editor.id]);
      expect(mocks.albumUser.createSpaceEvent).toHaveBeenCalledWith({
        albumId: space.id,
        actorId: editor.id,
        type: SharedSpaceEventType.Comment,
        activityId: activity.id,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('SharedSpaceMention', {
        id: space.id,
        assetId: null,
        activityId: activity.id,
        userIds: [owner.id],
        senderName: editor.name,
      });
      expect(result).toEqual(expect.objectContaining({ canEdit: true, canDelete: true }));
    });

    it('will not comment on an item the member cannot see or that is not in the space', async () => {
      const { space, editor } = spaceWithEditor();
      asEditor(space);
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([space.id]));
      mocks.albumUser.filterVisibleSpaceAssetIds.mockResolvedValue(new Set());

      await expect(
        sut.createComment(AuthFactory.create(editor), space.id, { assetId: newUuid(), comment: 'nice' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.activity.create).not.toHaveBeenCalled();
    });
  });

  describe('updateComment', () => {
    it('lets only the author change the text', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asOwner(space);
      const editorsComment = ActivityFactory.from({ albumId: space.id, userId: editor.id, comment: 'x' })
        .user({ id: editor.id, name: editor.name })
        .build();
      mocks.activity.getById.mockResolvedValue(getForActivity(editorsComment));

      await expect(
        sut.updateComment(AuthFactory.create(owner), space.id, editorsComment.id, { comment: 'y' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.activity.update).not.toHaveBeenCalled();
    });

    it('re-reads mentions and tells only the newly mentioned', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asEditor(space);
      const existing = ActivityFactory.from({ albumId: space.id, userId: editor.id, comment: `@{${owner.id}}` })
        .user({ id: editor.id, name: editor.name })
        .build();
      mocks.activity.getById.mockResolvedValue(getForActivity(existing));
      mocks.albumUser.getMentions.mockResolvedValue([{ activityId: existing.id, userId: owner.id }]);
      mocks.activity.update.mockResolvedValue(getForActivity({ ...existing, comment: `@{${owner.id}} still` }));
      mocks.user.get.mockResolvedValue(owner);

      await sut.updateComment(AuthFactory.create(editor), space.id, existing.id, { comment: `@{${owner.id}} still` });

      expect(mocks.albumUser.deleteMentions).toHaveBeenCalledWith(existing.id);
      expect(mocks.albumUser.createMentions).toHaveBeenCalledWith(existing.id, [owner.id]);
      // The owner was already mentioned, so they are not told twice.
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });
  });

  describe('deleteComment', () => {
    it('lets an editor remove somebody else’s comment, and a viewer only their own', async () => {
      const viewerId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space })
        .albumUser({ userId: viewerId, role: AlbumUserRole.Viewer })
        .build();
      const owner = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;
      const viewer = space.albumUsers.find(({ user }) => user.id === viewerId)!.user;
      asEditor(space);

      const ownersComment = ActivityFactory.from({ albumId: space.id, userId: owner.id, comment: 'mine' }).build();
      mocks.activity.getById.mockResolvedValue(getForActivity(ownersComment));
      await expect(sut.deleteComment(AuthFactory.create(viewer), space.id, ownersComment.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.albumUser.deleteCommentWithReplies).not.toHaveBeenCalled();

      const viewersComment = ActivityFactory.from({ albumId: space.id, userId: viewerId, comment: 'x' }).build();
      mocks.activity.getById.mockResolvedValue(getForActivity(viewersComment));
      await sut.deleteComment(AuthFactory.create(owner), space.id, viewersComment.id);
      // The thread goes with its top-level comment, in one statement.
      expect(mocks.albumUser.deleteCommentWithReplies).toHaveBeenCalledWith(viewersComment.id);
      expect(mocks.activity.delete).not.toHaveBeenCalled();
    });

    it('does not treat another album’s comment, or a like, as one of this space’s', async () => {
      const { space, owner } = spaceWithEditor();
      asOwner(space);

      mocks.activity.getById.mockResolvedValue(
        getForActivity(ActivityFactory.from({ albumId: newUuid(), comment: 'x' }).build()),
      );
      await expect(sut.deleteComment(AuthFactory.create(owner), space.id, newUuid())).rejects.toBeInstanceOf(
        NotFoundException,
      );

      mocks.activity.getById.mockResolvedValue(
        getForActivity(ActivityFactory.from({ albumId: space.id, isLiked: true }).build()),
      );
      await expect(sut.deleteComment(AuthFactory.create(owner), space.id, newUuid())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.albumUser.deleteCommentWithReplies).not.toHaveBeenCalled();
    });
  });

  describe('threaded replies', () => {
    const commentBy = (spaceId: string, user: { id: string; name: string }, assetId: string | null = null) =>
      ActivityFactory.from({ albumId: spaceId, userId: user.id, comment: `said by ${user.name}`, assetId })
        .user({ id: user.id, name: user.name })
        .build();

    it('lists comments flat, with each reply naming its top-level comment and the count on the parent', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asEditor(space);
      const root = commentBy(space.id, owner);
      const reply = commentBy(space.id, editor);
      const other = commentBy(space.id, editor);
      mocks.activity.search.mockResolvedValue([getForActivity(root), getForActivity(reply), getForActivity(other)]);
      mocks.albumUser.getMentions.mockResolvedValue([]);
      mocks.albumUser.getCommentParents.mockResolvedValue([{ activityId: reply.id, parentActivityId: root.id }]);

      const { comments } = await sut.getComments(AuthFactory.create(editor), space.id, {});

      expect(comments.map(({ id, parentId, replyCount }) => ({ id, parentId, replyCount }))).toEqual([
        { id: root.id, parentId: null, replyCount: 1 },
        { id: reply.id, parentId: root.id, replyCount: 0 },
        { id: other.id, parentId: null, replyCount: 0 },
      ]);
      expect(mocks.albumUser.getCommentParents).toHaveBeenCalledWith([root.id, reply.id, other.id]);
    });

    it('stores a reply under its comment, announces it as a reply and tells the comment’s author in the app', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asEditor(space);
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([space.id]));
      const root = commentBy(space.id, owner);
      const created = commentBy(space.id, editor);
      mocks.activity.getById.mockResolvedValue(getForActivity(root));
      mocks.albumUser.getCommentParents.mockResolvedValue([]);
      mocks.activity.create.mockResolvedValue(getForActivity(created));

      const result = await sut.createComment(AuthFactory.create(editor), space.id, {
        comment: 'agreed',
        parentId: root.id,
      });

      expect(mocks.activity.create).toHaveBeenCalledWith(
        expect.objectContaining({ albumId: space.id, userId: editor.id, assetId: null, comment: 'agreed' }),
      );
      expect(mocks.albumUser.createCommentThread).toHaveBeenCalledWith({
        activityId: created.id,
        parentActivityId: root.id,
        albumId: space.id,
      });
      expect(mocks.albumUser.createSpaceEvent).toHaveBeenCalledWith({
        albumId: space.id,
        actorId: editor.id,
        type: SharedSpaceEventType.Reply,
        activityId: created.id,
        targetUserId: owner.id,
      });
      expect(mocks.event.emit).toHaveBeenCalledTimes(1);
      expect(mocks.event.emit).toHaveBeenCalledWith('SharedSpaceReply', {
        id: space.id,
        assetId: null,
        activityId: created.id,
        parentActivityId: root.id,
        userId: owner.id,
        senderName: editor.name,
      });
      expect(result).toEqual(expect.objectContaining({ parentId: root.id, replyCount: 0 }));
    });

    it('keeps a reply to a reply in the same thread, under the top-level comment', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asOwner(space);
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([space.id]));
      const root = commentBy(space.id, owner);
      const firstReply = commentBy(space.id, editor);
      const created = commentBy(space.id, owner);
      const byId = new Map([
        [root.id, getForActivity(root)],
        [firstReply.id, getForActivity(firstReply)],
      ]);
      mocks.activity.getById.mockImplementation((id: string) => Promise.resolve(byId.get(id)));
      mocks.albumUser.getCommentParents.mockResolvedValue([{ activityId: firstReply.id, parentActivityId: root.id }]);
      mocks.activity.create.mockResolvedValue(getForActivity(created));
      mocks.user.get.mockResolvedValue(editor);

      await sut.createComment(AuthFactory.create(owner), space.id, {
        comment: `@{${editor.id}} yes`,
        parentId: firstReply.id,
      });

      expect(mocks.albumUser.createCommentThread).toHaveBeenCalledWith({
        activityId: created.id,
        parentActivityId: root.id,
        albumId: space.id,
      });
      // The owner wrote the top-level comment, so no reply notice; the editor is told by the mention.
      expect(mocks.event.emit).toHaveBeenCalledTimes(1);
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'SharedSpaceMention',
        expect.objectContaining({ userIds: [editor.id] }),
      );
    });

    it('says only "not found" for a comment on an item the member cannot see, and writes nothing', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asEditor(space);
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([space.id]));
      const root = commentBy(space.id, owner, newUuid());
      mocks.activity.getById.mockResolvedValue(getForActivity(root));
      mocks.albumUser.getCommentParents.mockResolvedValue([]);
      mocks.albumUser.filterVisibleSpaceAssetIds.mockResolvedValue(new Set());

      await expect(
        sut.createComment(AuthFactory.create(editor), space.id, { comment: 'hm', parentId: root.id }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.activity.create).not.toHaveBeenCalled();
      expect(mocks.albumUser.createCommentThread).not.toHaveBeenCalled();
    });

    it('refuses a reply that names a different item from the comment it answers', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asEditor(space);
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([space.id]));
      const assetId = newUuid();
      const root = commentBy(space.id, owner, assetId);
      mocks.activity.getById.mockResolvedValue(getForActivity(root));
      mocks.albumUser.getCommentParents.mockResolvedValue([]);
      mocks.albumUser.filterVisibleSpaceAssetIds.mockResolvedValue(new Set([assetId]));

      await expect(
        sut.createComment(AuthFactory.create(editor), space.id, {
          comment: 'hm',
          parentId: root.id,
          assetId: newUuid(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.activity.create).not.toHaveBeenCalled();
    });

    it('does not answer a like, or another album’s comment', async () => {
      const { space, editor } = spaceWithEditor();
      asEditor(space);
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([space.id]));

      mocks.activity.getById.mockResolvedValue(
        getForActivity(ActivityFactory.from({ albumId: space.id, isLiked: true }).build()),
      );
      await expect(
        sut.createComment(AuthFactory.create(editor), space.id, { comment: 'hm', parentId: newUuid() }),
      ).rejects.toBeInstanceOf(NotFoundException);

      mocks.activity.getById.mockResolvedValue(
        getForActivity(ActivityFactory.from({ albumId: newUuid(), comment: 'x' }).build()),
      );
      await expect(
        sut.createComment(AuthFactory.create(editor), space.id, { comment: 'hm', parentId: newUuid() }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.activity.create).not.toHaveBeenCalled();
    });

    it('takes the reply back out when its thread row cannot be written', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asEditor(space);
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([space.id]));
      const root = commentBy(space.id, owner);
      const created = commentBy(space.id, editor);
      mocks.activity.getById.mockResolvedValue(getForActivity(root));
      mocks.albumUser.getCommentParents.mockResolvedValue([]);
      mocks.activity.create.mockResolvedValue(getForActivity(created));
      mocks.albumUser.createCommentThread.mockRejectedValue(new Error('boom'));
      mocks.activity.delete.mockResolvedValue();

      await expect(
        sut.createComment(AuthFactory.create(editor), space.id, { comment: 'x', parentId: root.id }),
      ).rejects.toThrow('boom');
      expect(mocks.activity.delete).toHaveBeenCalledWith(created.id);
      expect(mocks.albumUser.createSpaceEvent).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('says "not found" when the comment being answered was removed meanwhile', async () => {
      const { space, owner, editor } = spaceWithEditor();
      asEditor(space);
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([space.id]));
      const root = commentBy(space.id, owner);
      const created = commentBy(space.id, editor);
      mocks.activity.getById.mockResolvedValueOnce(getForActivity(root)).mockResolvedValueOnce(void 0);
      mocks.activity.create.mockResolvedValue(getForActivity(created));
      mocks.albumUser.createCommentThread.mockRejectedValue(new Error('foreign key violation'));
      mocks.activity.delete.mockResolvedValue();

      await expect(
        sut.createComment(AuthFactory.create(editor), space.id, { comment: 'x', parentId: root.id }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.activity.delete).toHaveBeenCalledWith(created.id);
    });

    it('reports where an edited comment already sits in its thread', async () => {
      const { space, editor } = spaceWithEditor();
      asEditor(space);
      const existing = commentBy(space.id, editor);
      mocks.activity.getById.mockResolvedValue(getForActivity(existing));
      mocks.albumUser.getMentions.mockResolvedValue([]);
      mocks.activity.update.mockResolvedValue(getForActivity({ ...existing, comment: 'edited' }));
      mocks.albumUser.getCommentParents.mockResolvedValue([]);
      mocks.albumUser.getCommentReplies.mockResolvedValue([
        { activityId: newUuid(), parentActivityId: existing.id },
        { activityId: newUuid(), parentActivityId: existing.id },
      ]);

      const result = await sut.updateComment(AuthFactory.create(editor), space.id, existing.id, { comment: 'edited' });

      expect(result).toEqual(expect.objectContaining({ parentId: null, replyCount: 2 }));
    });
  });
});
