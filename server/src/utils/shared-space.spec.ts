import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AlbumKind, AlbumUserRole, SharedSpaceEventType } from 'src/enum.js';
import {
  INVITABLE_SPACE_ROLES,
  canDeleteSpaceComment,
  canEditSpaceComment,
  isCommentEventType,
  isNewSpaceEvent,
  isSharedSpace,
  isSpaceMember,
  mentionToken,
  narrowSpaceEvent,
  parseMentions,
  replyRecipient,
  requireInvitableRole,
  requireMentionableMembers,
  requireReplyOnSameItem,
  requireSharedSpace,
  requireSpaceOwner,
  spaceOwnerId,
  spaceRoleOf,
  threadComments,
} from 'src/utils/shared-space.js';

const member = (id: string, role: AlbumUserRole) => ({ role, user: { id } });

const space = (users = [member('owner-1', AlbumUserRole.Owner)]) => ({
  kind: AlbumKind.Space,
  albumUsers: users,
});

describe('shared space rules', () => {
  describe('isSharedSpace', () => {
    it('is true only for the space kind', () => {
      expect(isSharedSpace({ kind: AlbumKind.Space })).toBe(true);
      expect(isSharedSpace({ kind: AlbumKind.Album })).toBe(false);
      expect(isSharedSpace({ kind: AlbumKind.Collection })).toBe(false);
    });

    it('treats a row written before the kind column as a plain album', () => {
      expect(isSharedSpace({ kind: '' })).toBe(false);
      expect(isSharedSpace({ kind: 'something-else' })).toBe(false);
    });
  });

  describe('requireSharedSpace', () => {
    it('refuses an album and a collection', () => {
      expect(() => requireSharedSpace({ kind: AlbumKind.Album })).toThrow(BadRequestException);
      expect(() => requireSharedSpace({ kind: AlbumKind.Collection })).toThrow(BadRequestException);
      expect(() => requireSharedSpace({ kind: AlbumKind.Space })).not.toThrow();
    });
  });

  describe('roles', () => {
    it('finds the owner and each member role', () => {
      const album = space([
        member('owner-1', AlbumUserRole.Owner),
        member('editor-1', AlbumUserRole.Editor),
        member('viewer-1', AlbumUserRole.Viewer),
      ]);

      expect(spaceOwnerId(album)).toBe('owner-1');
      expect(spaceRoleOf(album, 'editor-1')).toBe(AlbumUserRole.Editor);
      expect(spaceRoleOf(album, 'viewer-1')).toBe(AlbumUserRole.Viewer);
      expect(spaceRoleOf(album, 'stranger')).toBeNull();
      expect(isSpaceMember(album, 'viewer-1')).toBe(true);
      expect(isSpaceMember(album, 'stranger')).toBe(false);
    });
  });

  describe('requireSpaceOwner', () => {
    it('lets the owner through', () => {
      expect(() => requireSpaceOwner(space(), 'owner-1')).not.toThrow();
    });

    it('refuses an editor, a viewer and a stranger', () => {
      const album = space([
        member('owner-1', AlbumUserRole.Owner),
        member('editor-1', AlbumUserRole.Editor),
        member('viewer-1', AlbumUserRole.Viewer),
      ]);

      expect(() => requireSpaceOwner(album, 'editor-1')).toThrow(ForbiddenException);
      expect(() => requireSpaceOwner(album, 'viewer-1')).toThrow(ForbiddenException);
      expect(() => requireSpaceOwner(album, 'stranger')).toThrow(ForbiddenException);
    });
  });

  describe('requireInvitableRole', () => {
    it('offers editor and viewer only', () => {
      expect(INVITABLE_SPACE_ROLES).toEqual([AlbumUserRole.Editor, AlbumUserRole.Viewer]);
      expect(() => requireInvitableRole(AlbumUserRole.Editor)).not.toThrow();
      expect(() => requireInvitableRole(AlbumUserRole.Viewer)).not.toThrow();
      expect(() => requireInvitableRole(AlbumUserRole.Owner)).toThrow(BadRequestException);
    });
  });

  describe('mentions', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';

    it('parses distinct ids from @{id} tokens, in order of first appearance, whatever the case', () => {
      const comment = `hi ${mentionToken(a)} and ${mentionToken(b.toUpperCase())}, again ${mentionToken(a)}`;
      expect(parseMentions(comment)).toEqual([a, b]);
    });

    it('never turns a typed name or a malformed token into a mention', () => {
      expect(parseMentions('@Taylor look at @{not-an-id} and @{}')).toEqual([]);
    });

    it('refuses a mention of anyone who is not a current member', () => {
      const album = space([member('owner-1', AlbumUserRole.Owner), member('editor-1', AlbumUserRole.Editor)]);

      expect(() => requireMentionableMembers(album, ['editor-1', 'owner-1'])).not.toThrow();
      expect(() => requireMentionableMembers(album, ['editor-1', 'stranger'])).toThrow(BadRequestException);
    });
  });

  describe('comment moderation', () => {
    const album = space([
      member('owner-1', AlbumUserRole.Owner),
      member('editor-1', AlbumUserRole.Editor),
      member('viewer-1', AlbumUserRole.Viewer),
    ]);
    const viewersComment = { userId: 'viewer-1' };
    const ownersComment = { userId: 'owner-1' };

    it('lets only the author edit', () => {
      expect(canEditSpaceComment(viewersComment, 'viewer-1')).toBe(true);
      expect(canEditSpaceComment(viewersComment, 'owner-1')).toBe(false);
      expect(canEditSpaceComment(viewersComment, 'editor-1')).toBe(false);
    });

    it('lets the author, an editor and the owner remove; a viewer removes only their own', () => {
      expect(canDeleteSpaceComment(album, viewersComment, 'viewer-1')).toBe(true);
      expect(canDeleteSpaceComment(album, viewersComment, 'editor-1')).toBe(true);
      expect(canDeleteSpaceComment(album, viewersComment, 'owner-1')).toBe(true);
      expect(canDeleteSpaceComment(album, ownersComment, 'viewer-1')).toBe(false);
      expect(canDeleteSpaceComment(album, ownersComment, 'stranger')).toBe(false);
    });
  });

  describe('narrowSpaceEvent', () => {
    const visible = new Set(['seen-1', 'seen-2']);

    it('keeps only the ids the viewer may see of an addition, and drops it when none are left', () => {
      const added = { type: SharedSpaceEventType.AssetsAdded, assetIds: ['seen-1', 'locked-1'], activityAssetId: null };
      expect(narrowSpaceEvent(added, visible)).toEqual({ ...added, assetIds: ['seen-1'], assetCount: 1 });

      const hidden = { type: SharedSpaceEventType.AssetsAdded, assetIds: ['locked-1'], activityAssetId: null };
      expect(narrowSpaceEvent(hidden, visible)).toBeNull();
    });

    it('reports a removal as a count and never as ids', () => {
      const removed = {
        type: SharedSpaceEventType.AssetsRemoved,
        assetIds: ['seen-1', 'seen-2', 'locked-1'],
        activityAssetId: null,
      };
      expect(narrowSpaceEvent(removed, visible)).toEqual({ ...removed, assetIds: [], assetCount: 2 });
    });

    it('drops a comment on an item the viewer cannot see, and keeps one on an item they can', () => {
      const onLocked = { type: SharedSpaceEventType.Comment, assetIds: [], activityAssetId: 'locked-1' };
      expect(narrowSpaceEvent(onLocked, visible)).toBeNull();

      const onSeen = { type: SharedSpaceEventType.Like, assetIds: [], activityAssetId: 'seen-2' };
      expect(narrowSpaceEvent(onSeen, visible)).toEqual({ ...onSeen, assetIds: ['seen-2'], assetCount: 1 });
    });

    it('passes a member event and a space-level comment through, carrying no items', () => {
      const joined = { type: SharedSpaceEventType.MemberJoined, assetIds: [], activityAssetId: null };
      expect(narrowSpaceEvent(joined, new Set())).toEqual({ ...joined, assetIds: [], assetCount: 0 });

      const onSpace = { type: SharedSpaceEventType.Comment, assetIds: [], activityAssetId: null };
      expect(narrowSpaceEvent(onSpace, new Set())).toEqual({ ...onSpace, assetIds: [], assetCount: 0 });
    });
  });

  describe('isNewSpaceEvent', () => {
    const marker = new Date('2026-09-20T12:00:00Z');
    const later = new Date('2026-09-21T12:00:00Z');
    const earlier = new Date('2026-09-19T12:00:00Z');

    it('is news when somebody else did it after the marker', () => {
      expect(isNewSpaceEvent({ actorId: 'other', createdAt: later }, 'me', marker)).toBe(true);
      expect(isNewSpaceEvent({ actorId: null, createdAt: later }, 'me', marker)).toBe(true);
    });

    it('is not news when it is older than the marker or the member did it themselves', () => {
      expect(isNewSpaceEvent({ actorId: 'other', createdAt: earlier }, 'me', marker)).toBe(false);
      expect(isNewSpaceEvent({ actorId: 'me', createdAt: later }, 'me', marker)).toBe(false);
    });

    it('treats everything by others as news for a member with no marker', () => {
      expect(isNewSpaceEvent({ actorId: 'other', createdAt: earlier }, 'me')).toBe(true);
      expect(isNewSpaceEvent({ actorId: 'other', createdAt: earlier }, 'me', null)).toBe(true);
    });
  });

  describe('threaded replies', () => {
    it('treats a reply like a comment in the feed', () => {
      expect(isCommentEventType(SharedSpaceEventType.Comment)).toBe(true);
      expect(isCommentEventType(SharedSpaceEventType.Reply)).toBe(true);
      expect(isCommentEventType(SharedSpaceEventType.Like)).toBe(false);
    });

    it('narrows a reply on an item the viewer cannot see away entirely', () => {
      const reply = { type: SharedSpaceEventType.Reply, assetIds: [], activityAssetId: 'locked' };
      expect(narrowSpaceEvent(reply, new Set())).toBeNull();
    });

    it('threads replies under their top-level comment and counts them there', () => {
      const info = threadComments(
        ['a', 'b', 'c', 'd'],
        [
          { activityId: 'b', parentActivityId: 'a' },
          { activityId: 'c', parentActivityId: 'a' },
        ],
      );
      expect(info.get('a')).toEqual({ parentId: null, replyCount: 2 });
      expect(info.get('b')).toEqual({ parentId: 'a', replyCount: 0 });
      expect(info.get('c')).toEqual({ parentId: 'a', replyCount: 0 });
      expect(info.get('d')).toEqual({ parentId: null, replyCount: 0 });
    });

    it('keeps threads one level deep, whatever is stored', () => {
      const info = threadComments(
        ['a', 'b', 'c'],
        [
          { activityId: 'b', parentActivityId: 'a' },
          { activityId: 'c', parentActivityId: 'b' },
        ],
      );
      expect(info.get('c')).toEqual({ parentId: 'a', replyCount: 0 });
      expect(info.get('a')).toEqual({ parentId: null, replyCount: 2 });
    });

    it('never counts or points at a comment the caller is not shown', () => {
      const info = threadComments(['b'], [{ activityId: 'b', parentActivityId: 'hidden' }]);
      expect(info.get('b')).toEqual({ parentId: null, replyCount: 0 });

      const parentOnly = threadComments(['a'], [{ activityId: 'hidden', parentActivityId: 'a' }]);
      expect(parentOnly.get('a')).toEqual({ parentId: null, replyCount: 0 });
    });

    it('survives a cycle by showing both comments on their own', () => {
      const info = threadComments(
        ['a', 'b'],
        [
          { activityId: 'a', parentActivityId: 'b' },
          { activityId: 'b', parentActivityId: 'a' },
        ],
      );
      expect(info.get('a')).toEqual({ parentId: null, replyCount: 0 });
      expect(info.get('b')).toEqual({ parentId: null, replyCount: 0 });
    });

    it('keeps a reply on the same item as the comment it answers', () => {
      expect(() => requireReplyOnSameItem({ assetId: 'item' }, undefined)).not.toThrow();
      expect(() => requireReplyOnSameItem({ assetId: 'item' }, 'item')).not.toThrow();
      expect(() => requireReplyOnSameItem({ assetId: null }, undefined)).not.toThrow();
      expect(() => requireReplyOnSameItem({ assetId: 'item' }, 'other')).toThrow(BadRequestException);
    });

    it('tells the author of the answered comment, unless it is the replier, they left, or they are mentioned', () => {
      const album = space([member('owner-1', AlbumUserRole.Owner), member('editor-1', AlbumUserRole.Editor)]);

      expect(replyRecipient(album, { userId: 'owner-1' }, 'editor-1', [])).toBe('owner-1');
      expect(replyRecipient(album, { userId: 'editor-1' }, 'editor-1', [])).toBeNull();
      expect(replyRecipient(album, { userId: 'gone-1' }, 'editor-1', [])).toBeNull();
      expect(replyRecipient(album, { userId: 'owner-1' }, 'editor-1', ['owner-1'])).toBeNull();
    });
  });
});
