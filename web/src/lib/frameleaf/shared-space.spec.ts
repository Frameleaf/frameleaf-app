import {
  AlbumKind,
  AlbumUserRole,
  SharedSpaceEventType,
  type SharedSpaceCommentResponseDto,
  type SharedSpaceMemberResponseDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  activityUnreadHint,
  addSourceOptions,
  alreadyInvolvedIds,
  canContribute,
  canManageMembers,
  canRemoveMember,
  defaultSpacePersonName,
  filterToNew,
  hasNewSinceVisit,
  insertMention,
  isNewSpaceEvent,
  isSpace,
  isSpaceOwner,
  isSpacePanel,
  linkableAlbums,
  linkedAlbumIsEmpty,
  mentionCandidates,
  mentionQueryAt,
  mentionToken,
  newSinceFilter,
  newSinceIsPartial,
  newSinceMessageKey,
  panelFromSearch,
  pendingInvitations,
  shouldPageForNew,
  sortMembers,
  spaceAddScope,
  spaceEventMessageKey,
  spaceOwner,
  spacePersonCandidates,
  spaceRole,
  splitMentions,
  SPACE_PANELS,
  SPACE_ROLE_OPTIONS,
  groupCommentThreads,
  replyPrefill,
  threadRootId,
  withoutComment,
  withReply,
} from '$lib/frameleaf/shared-space';
import { albumFactory } from '@test-data/factories/album-factory';
import { personFactory } from '@test-data/factories/person-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

const owner = userAdminFactory.build({ id: 'owner', name: 'Ada' });
const editor = userAdminFactory.build({ id: 'editor', name: 'Bo' });
const viewer = userAdminFactory.build({ id: 'viewer', name: 'Cy' });

const space = albumFactory.build({
  id: 'space-1',
  kind: AlbumKind.Space,
  albumUsers: [
    { user: owner, role: AlbumUserRole.Owner },
    { user: editor, role: AlbumUserRole.Editor },
    { user: viewer, role: AlbumUserRole.Viewer },
  ],
});

const member = (user: typeof owner, role: AlbumUserRole, pending = false): SharedSpaceMemberResponseDto => ({
  user,
  role,
  pending,
});

describe('shared space rules', () => {
  it('recognises a space, and not an album or a collection', () => {
    expect(isSpace(space)).toBe(true);
    expect(isSpace(albumFactory.build({ kind: AlbumKind.Album }))).toBe(false);
    expect(isSpace(albumFactory.build({ kind: AlbumKind.Collection }))).toBe(false);
  });

  it('reads the owner and each role', () => {
    expect(spaceOwner(space)?.id).toBe('owner');
    expect(spaceRole(space, 'editor')).toBe(AlbumUserRole.Editor);
    expect(spaceRole(space, 'viewer')).toBe(AlbumUserRole.Viewer);
    expect(spaceRole(space, 'stranger')).toBeNull();
    expect(spaceRole(space, undefined)).toBeNull();
  });

  it('lets the owner and an editor contribute, but not a viewer', () => {
    expect(canContribute(space, 'owner')).toBe(true);
    expect(canContribute(space, 'editor')).toBe(true);
    expect(canContribute(space, 'viewer')).toBe(false);
    expect(canContribute(space, 'stranger')).toBe(false);
  });

  it('gives membership management to the owner alone', () => {
    expect(isSpaceOwner(space, 'owner')).toBe(true);
    expect(canManageMembers(space, 'editor')).toBe(false);
    expect(canManageMembers(space, 'viewer')).toBe(false);
    expect(canManageMembers(space, undefined)).toBe(false);
  });

  it('never offers the owner role', () => {
    expect(SPACE_ROLE_OPTIONS).toEqual([AlbumUserRole.Editor, AlbumUserRole.Viewer]);
  });

  describe('canRemoveMember', () => {
    it('lets anyone leave and lets the owner remove anyone else', () => {
      expect(canRemoveMember(space, 'editor', member(editor, AlbumUserRole.Editor))).toBe(true);
      expect(canRemoveMember(space, 'owner', member(viewer, AlbumUserRole.Viewer))).toBe(true);
    });

    it('refuses an editor removing somebody else, and refuses removing the owner', () => {
      expect(canRemoveMember(space, 'editor', member(viewer, AlbumUserRole.Viewer))).toBe(false);
      expect(canRemoveMember(space, 'owner', member(owner, AlbumUserRole.Owner))).toBe(false);
    });
  });

  it('orders the roster owner, members, then unanswered invitations', () => {
    const sorted = sortMembers([
      member(viewer, AlbumUserRole.Viewer, true),
      member(editor, AlbumUserRole.Editor),
      member(owner, AlbumUserRole.Owner),
    ]);

    expect(sorted.map(({ user }) => user.id)).toEqual(['owner', 'editor', 'viewer']);
  });

  it('counts everyone already involved so nobody is invited twice', () => {
    const ids = alreadyInvolvedIds([member(owner, AlbumUserRole.Owner), member(viewer, AlbumUserRole.Viewer, true)]);
    expect([...ids].sort()).toEqual(['owner', 'viewer']);
  });

  it('keeps only invitations that are still an offer', () => {
    const preview = (id: string, accepted: boolean) =>
      ({ id, accepted }) as unknown as Parameters<typeof pendingInvitations>[0][number];
    expect(pendingInvitations([preview('a', false), preview('b', true)]).map(({ id }) => id)).toEqual(['a']);
  });

  describe('spaceAddScope', () => {
    it('freezes a library scope, never the space itself', () => {
      const scope = spaceAddScope({ kind: 'library' });
      expect(scope.scope).toEqual({ kind: 'library' });
      expect(scope.version).toBe(1);
    });

    it('freezes the chosen album as the source', () => {
      expect(spaceAddScope({ kind: 'album', id: 'album-9' }).scope).toEqual({ kind: 'album', id: 'album-9' });
    });

    it('returns a fresh state each time, so a later edit cannot reach a running operation', () => {
      const first = spaceAddScope({ kind: 'library' });
      const second = spaceAddScope({ kind: 'library' });
      expect(first).not.toBe(second);
      expect(first.query).not.toBe(second.query);
    });
  });

  it('offers plain albums as a source, never the space or a collection', () => {
    const album = albumFactory.build({ id: 'album-1', kind: AlbumKind.Album });
    const collection = albumFactory.build({ id: 'collection-1', kind: AlbumKind.Collection });
    expect(addSourceOptions([album, collection, space], space.id).map(({ id }) => id)).toEqual(['album-1']);
  });
});

describe('shared space panels', () => {
  it('opens on the timeline and knows every panel it offers', () => {
    expect(SPACE_PANELS[0]).toBe('timeline');
    expect(isSpacePanel('people')).toBe(true);
    expect(isSpacePanel('settings')).toBe(false);
    expect(isSpacePanel(null)).toBe(false);
  });

  it('reads the panel from the URL and falls back to the timeline', () => {
    expect(panelFromSearch(new URLSearchParams('panel=places'))).toBe('places');
    expect(panelFromSearch(new URLSearchParams('panel=nope'))).toBe('timeline');
    expect(panelFromSearch(new URLSearchParams(''))).toBe('timeline');
  });
});

describe('linked albums', () => {
  it('offers plain albums only, never the space, a collection or one already linked', () => {
    const album = albumFactory.build({ id: 'album-1', kind: AlbumKind.Album });
    const linked = albumFactory.build({ id: 'album-2', kind: AlbumKind.Album });
    const collection = albumFactory.build({ id: 'collection-1', kind: AlbumKind.Collection });
    const otherSpace = albumFactory.build({ id: 'space-2', kind: AlbumKind.Space });
    expect(
      linkableAlbums([album, linked, collection, otherSpace, space], space.id, ['album-2']).map(({ id }) => id),
    ).toEqual(['album-1']);
  });

  it('calls a link with nothing in the space empty rather than broken', () => {
    expect(linkedAlbumIsEmpty({ assetCount: 0 })).toBe(true);
    expect(linkedAlbumIsEmpty({ assetCount: 3 })).toBe(false);
  });
});

describe('new since your last visit', () => {
  const info = (assetIds: string[], assetCount = assetIds.length, lastVisitedAt: string | null = null) => ({
    assetIds,
    assetCount,
    lastVisitedAt,
  });

  it('has something to say only when there is something new', () => {
    expect(hasNewSinceVisit(undefined)).toBe(false);
    expect(hasNewSinceVisit(info([]))).toBe(false);
    expect(hasNewSinceVisit(info(['a']))).toBe(true);
  });

  it('narrows the timeline only while asked to, and never to nothing', () => {
    expect(newSinceFilter(info(['a', 'b']), false)).toBeUndefined();
    expect(newSinceFilter(info([], 4), true)).toBeUndefined();
    expect(newSinceFilter(info(['a', 'b']), true)).toEqual(new Set(['a', 'b']));
  });

  it('says when the server named fewer items than it counted', () => {
    expect(newSinceIsPartial(info(['a'], 700))).toBe(true);
    expect(newSinceIsPartial(info(['a'], 1))).toBe(false);
  });

  it('speaks of a last visit only when there was one', () => {
    expect(newSinceMessageKey(info(['a']))).toBe('frameleaf_spaces_new_first');
    expect(newSinceMessageKey(info(['a'], 1, '2026-09-20T00:00:00.000Z'))).toBe('frameleaf_spaces_new_since');
  });

  it('keeps only the new items when a filter is on', () => {
    const assets = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(filterToNew(assets, undefined)).toBe(assets);
    expect(filterToNew(assets, new Set(['c', 'a'])).map(({ id }) => id)).toEqual(['a', 'c']);
  });

  it('keeps paging until every new item is found or the space runs out', () => {
    const filter = new Set(['a', 'b']);
    expect(shouldPageForNew({ filter, found: 1, exhausted: false, loading: false })).toBe(true);
    expect(shouldPageForNew({ filter, found: 2, exhausted: false, loading: false })).toBe(false);
    expect(shouldPageForNew({ filter, found: 1, exhausted: true, loading: false })).toBe(false);
    expect(shouldPageForNew({ filter, found: 1, exhausted: false, loading: true })).toBe(false);
    expect(shouldPageForNew({ filter: undefined, found: 0, exhausted: false, loading: false })).toBe(false);
  });
});

describe('people in a shared space', () => {
  it('offers the member their own name for someone, which the space then keeps its own copy of', () => {
    expect(defaultSpacePersonName(personFactory.build({ name: 'Grandma' }))).toBe('Grandma');
    expect(defaultSpacePersonName({ name: '' })).toBe('');
  });

  it('never offers a person the member has hidden', () => {
    const shown = personFactory.build({ id: 'shown', isHidden: false });
    const hidden = personFactory.build({ id: 'hidden', isHidden: true });
    expect(spacePersonCandidates([shown, hidden]).map(({ id }) => id)).toEqual(['shown']);
  });
});

describe('comments, mentions and the activity feed', () => {
  const adaId = '11111111-1111-4111-8111-111111111111';
  const boId = '22222222-2222-4222-8222-222222222222';
  const goneId = '33333333-3333-4333-8333-333333333333';
  const ada = userAdminFactory.build({ id: adaId, name: 'Ada', email: 'ada@example.com' });
  const bo = userAdminFactory.build({ id: boId, name: 'Bo', email: 'bo@example.com' });
  const invited = userAdminFactory.build({ id: goneId, name: 'Cy', email: 'cy@example.com' });
  const roster: SharedSpaceMemberResponseDto[] = [
    { user: ada, role: AlbumUserRole.Owner, pending: false },
    { user: bo, role: AlbumUserRole.Editor, pending: false },
    { user: invited, role: AlbumUserRole.Viewer, pending: true },
  ];

  it('renders mention tokens as names, and a token nobody matches as a mention with no user', () => {
    const segments = splitMentions(`Look ${mentionToken(adaId)}! And ${mentionToken(goneId.toUpperCase())}`, [ada, bo]);

    expect(segments).toEqual([
      { kind: 'text', text: 'Look ' },
      { kind: 'mention', userId: adaId, user: ada },
      { kind: 'text', text: '! And ' },
      { kind: 'mention', userId: goneId, user: null },
    ]);
  });

  it('sees an @name being typed only at the start or after whitespace, and never inside a word', () => {
    expect(mentionQueryAt('hello @b', 8)).toEqual({ start: 6, query: 'b' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('mail me at ada@example', 22)).toBeNull();
    expect(mentionQueryAt('hello @ bo', 10)).toBeNull();
    // Only what is before the caret counts.
    expect(mentionQueryAt('hello @bo later', 9)).toEqual({ start: 6, query: 'bo' });
  });

  it('replaces the typed @name with the member’s token and puts the caret after it', () => {
    const text = 'hello @b there';
    const at = mentionQueryAt(text, 8)!;

    expect(insertMention(text, at, 8, boId)).toEqual({
      text: `hello ${mentionToken(boId)}  there`,
      caret: 6 + mentionToken(boId).length + 1,
    });
  });

  it('offers only members who have joined, other than the author, matched on name or email', () => {
    expect(mentionCandidates(roster, '', adaId).map(({ user }) => user.id)).toEqual([boId]);
    expect(mentionCandidates(roster, 'AD').map(({ user }) => user.id)).toEqual([adaId]);
    expect(mentionCandidates(roster, 'bo@').map(({ user }) => user.id)).toEqual([boId]);
    // An invitee is not a member yet, so they are not offered even by name.
    expect(mentionCandidates(roster, 'cy')).toEqual([]);
  });

  it('calls an event news when somebody else did it after the marker', () => {
    const later = { actor: bo, createdAt: '2026-09-21T00:00:00.000Z' };
    const earlier = { actor: bo, createdAt: '2026-09-19T00:00:00.000Z' };
    const marker = '2026-09-20T00:00:00.000Z';

    expect(isNewSpaceEvent(later, adaId, marker)).toBe(true);
    expect(isNewSpaceEvent(earlier, adaId, marker)).toBe(false);
    expect(isNewSpaceEvent(later, boId, marker)).toBe(false);
    expect(isNewSpaceEvent(earlier, adaId, null)).toBe(true);
    expect(isNewSpaceEvent({ actor: null, createdAt: later.createdAt }, adaId, marker)).toBe(true);
  });

  it('tells a comment or like on an item apart from one on the space', () => {
    expect(spaceEventMessageKey({ type: SharedSpaceEventType.Comment, assetCount: 1 })).toBe(
      'frameleaf_spaces_activity_comment_item',
    );
    expect(spaceEventMessageKey({ type: SharedSpaceEventType.Comment, assetCount: 0 })).toBe(
      'frameleaf_spaces_activity_comment_space',
    );
    expect(spaceEventMessageKey({ type: SharedSpaceEventType.Like, assetCount: 0 })).toBe(
      'frameleaf_spaces_activity_like_space',
    );
    expect(spaceEventMessageKey({ type: SharedSpaceEventType.MemberRoleChanged, assetCount: 0 })).toBe(
      'frameleaf_spaces_activity_member_role',
    );
  });

  it('shows a count beside Activity only when something is new', () => {
    expect(activityUnreadHint({ unreadCount: 3 })).toBe('3');
    expect(activityUnreadHint({ unreadCount: 0 })).toBeUndefined();
    expect(activityUnreadHint(null)).toBeUndefined();
  });

  it('tells a reply apart from a comment, on an item or on the space', () => {
    expect(spaceEventMessageKey({ type: SharedSpaceEventType.Reply, assetCount: 1 })).toBe(
      'frameleaf_spaces_activity_reply_item',
    );
    expect(spaceEventMessageKey({ type: SharedSpaceEventType.Reply, assetCount: 0 })).toBe(
      'frameleaf_spaces_activity_reply_space',
    );
  });

  it('does not say somebody replied to their own comment as if to someone else', () => {
    expect(spaceEventMessageKey({ type: SharedSpaceEventType.Reply, assetCount: 1, actor: bo, targetUser: bo })).toBe(
      'frameleaf_spaces_activity_reply_own_item',
    );
    expect(spaceEventMessageKey({ type: SharedSpaceEventType.Reply, assetCount: 0, actor: bo, targetUser: bo })).toBe(
      'frameleaf_spaces_activity_reply_own_space',
    );
    expect(spaceEventMessageKey({ type: SharedSpaceEventType.Reply, assetCount: 0, actor: bo, targetUser: ada })).toBe(
      'frameleaf_spaces_activity_reply_space',
    );
  });
});

describe('threaded replies', () => {
  const ada = userAdminFactory.build({ id: 'ada', name: 'Ada' });
  const bo = userAdminFactory.build({ id: 'bo', name: 'Bo' });
  const roster: SharedSpaceMemberResponseDto[] = [
    { user: ada, role: AlbumUserRole.Owner, pending: false },
    { user: bo, role: AlbumUserRole.Editor, pending: false },
  ];

  const comment = (overrides: Partial<SharedSpaceCommentResponseDto>): SharedSpaceCommentResponseDto => ({
    id: 'c',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    user: ada,
    assetId: null,
    comment: 'text',
    mentions: [],
    canEdit: false,
    canDelete: false,
    parentId: null,
    replyCount: 0,
    ...overrides,
  });

  it('puts replies under their comment, oldest first, and the most recently active thread last', () => {
    const early = comment({ id: 'early', createdAt: '2026-09-20T09:00:00.000Z', replyCount: 2 });
    const late = comment({ id: 'late', createdAt: '2026-09-20T10:00:00.000Z' });
    const firstReply = comment({ id: 'r1', parentId: 'early', createdAt: '2026-09-20T09:30:00.000Z' });
    const newestReply = comment({ id: 'r2', parentId: 'early', createdAt: '2026-09-20T11:00:00.000Z' });

    const threads = groupCommentThreads([early, firstReply, late, newestReply]);

    // The early comment has the newest reply, so its thread sits last, next to the composer.
    expect(threads.map((thread) => thread.comment.id)).toEqual(['late', 'early']);
    expect(threads[1].replies.map(({ id }) => id)).toEqual(['r1', 'r2']);
    expect(threads[1].lastActivityAt).toBe('2026-09-20T11:00:00.000Z');
  });

  it('shows a reply whose comment is missing on its own rather than losing it', () => {
    const orphan = comment({ id: 'orphan', parentId: 'gone' });

    const threads = groupCommentThreads([orphan]);

    expect(threads.map((thread) => [thread.comment.id, thread.replies.length])).toEqual([['orphan', 0]]);
  });

  it('files a reply under the thread’s top-level comment', () => {
    expect(threadRootId({ id: 'r1', parentId: 'root' })).toBe('root');
    expect(threadRootId({ id: 'root', parentId: null })).toBe('root');
  });

  it('mentions the person answered only when replying to someone else’s reply who is still a member', () => {
    expect(replyPrefill(comment({ user: bo, parentId: 'root' }), 'ada', roster)).toBe('@{bo} ');
    expect(replyPrefill(comment({ user: bo, parentId: null }), 'ada', roster)).toBe('');
    expect(replyPrefill(comment({ user: ada, parentId: 'root' }), 'ada', roster)).toBe('');

    const gone = userAdminFactory.build({ id: 'gone', name: 'Cy' });
    expect(replyPrefill(comment({ user: gone, parentId: 'root' }), 'ada', roster)).toBe('');
  });

  it('removes a comment with its replies, and a reply with its parent’s count', () => {
    const root = comment({ id: 'root', replyCount: 2 });
    const r1 = comment({ id: 'r1', parentId: 'root' });
    const r2 = comment({ id: 'r2', parentId: 'root' });
    const other = comment({ id: 'other' });

    expect(withoutComment([root, r1, r2, other], root).map(({ id }) => id)).toEqual(['other']);

    const afterReply = withoutComment([root, r1, r2, other], r1);
    expect(afterReply.map(({ id }) => id)).toEqual(['root', 'r2', 'other']);
    expect(afterReply.find(({ id }) => id === 'root')?.replyCount).toBe(1);
  });

  it('adds a reply and counts it on its thread', () => {
    const root = comment({ id: 'root', replyCount: 0 });
    const next = withReply([root], comment({ id: 'r1', parentId: 'root' }));

    expect(next.map(({ id }) => id)).toEqual(['root', 'r1']);
    expect(next[0].replyCount).toBe(1);
  });
});
