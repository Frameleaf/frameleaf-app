import {
  AlbumKind,
  AlbumUserRole,
  SharedSpaceEventType,
  type AlbumResponseDto,
  type PersonResponseDto,
  type SharedSpaceActivityResponseDto,
  type SharedSpaceAlbumResponseDto,
  type SharedSpaceCommentResponseDto,
  type SharedSpaceEventResponseDto,
  type SharedSpaceMemberResponseDto,
  type SharedSpaceNewResponseDto,
  type SharedSpacePreviewResponseDto,
  type UserResponseDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { createLibrarySession, type LibraryViewState } from '$lib/frameleaf/library-session';

/**
 * Shared space rules on the client (FL-55).
 *
 * These mirror what the server enforces; they exist so the UI can offer the
 * right controls, never to decide access. Every action still goes to an
 * endpoint that checks the same rule again, and its answer wins.
 *
 * A shared space is an album with `kind: "space"`, so its roles are the album
 * roles. The space-only rules are:
 *
 * - its owner manages membership (an editor adds photos, not people);
 * - somebody joins only by accepting an invitation they can preview first;
 * - `owner` is never offered as a role.
 */

export const SPACE_ROLE_OPTIONS: readonly AlbumUserRole[] = [AlbumUserRole.Editor, AlbumUserRole.Viewer];

export const isSpace = (album: Pick<AlbumResponseDto, 'kind'>): boolean => album.kind === AlbumKind.Space;

export const spaceOwner = (space: Pick<AlbumResponseDto, 'albumUsers'>) =>
  space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user;

export const spaceRole = (space: Pick<AlbumResponseDto, 'albumUsers'>, userId?: string): AlbumUserRole | null =>
  (userId && space.albumUsers.find(({ user }) => user.id === userId)?.role) || null;

export const isSpaceOwner = (space: Pick<AlbumResponseDto, 'albumUsers'>, userId?: string): boolean =>
  !!userId && spaceOwner(space)?.id === userId;

/** An editor or the owner may add photos to the space. A viewer may not. */
export const canContribute = (space: Pick<AlbumResponseDto, 'albumUsers'>, userId?: string): boolean => {
  const role = spaceRole(space, userId);
  return role === AlbumUserRole.Owner || role === AlbumUserRole.Editor;
};

/** Only the owner may invite, change a role, or remove somebody else. */
export const canManageMembers = isSpaceOwner;

/**
 * Whether the signed-in person may take this member out of the space. Anybody
 * may take themselves out (leave); only the owner may remove anyone else; and
 * the owner is never removable, because a space always has exactly one.
 */
export const canRemoveMember = (
  space: Pick<AlbumResponseDto, 'albumUsers'>,
  actorId: string | undefined,
  member: Pick<SharedSpaceMemberResponseDto, 'user' | 'role'>,
): boolean => {
  if (member.role === AlbumUserRole.Owner) {
    return false;
  }
  return member.user.id === actorId || isSpaceOwner(space, actorId);
};

/** Owner first, then the people who have joined, then the invitations nobody has answered. */
export const sortMembers = (members: SharedSpaceMemberResponseDto[]): SharedSpaceMemberResponseDto[] =>
  [...members].sort((left, right) => {
    const rank = (member: SharedSpaceMemberResponseDto) =>
      member.pending ? 2 : member.role === AlbumUserRole.Owner ? 0 : 1;
    return rank(left) - rank(right) || (left.user.name || '').localeCompare(right.user.name || '');
  });

/**
 * The people already accounted for on a space, so the invite picker never
 * offers somebody who is already in it or already holds an invitation.
 */
export const alreadyInvolvedIds = (members: SharedSpaceMemberResponseDto[]): Set<string> =>
  new Set(members.map(({ user }) => user.id));

/** A recipient preview is worth showing only while it is still an offer. */
export const pendingInvitations = (invitations: SharedSpacePreviewResponseDto[]): SharedSpacePreviewResponseDto[] =>
  invitations.filter(({ accepted }) => !accepted);

/* -------------------------------------------------------------------------- */
/* Bulk "add everything matching" into a space (FL-32's snapshot path)         */
/* -------------------------------------------------------------------------- */

/** What a bulk add draws from: the whole library, or one album the user picked. */
export type SpaceAddSource = { kind: 'library' } | { kind: 'album'; id: string };

/**
 * The view state an "add everything matching" operation is frozen against.
 *
 * This is a plain library view, never the space itself: FL-32 refuses a space
 * scope because a shared space is not expressible as a search, and the whole
 * point of the snapshot is that the operation touches exactly the set the
 * server can enumerate for the signed-in user. The destination space is the
 * action's payload, not the scope.
 */
export const spaceAddScope = (source: SpaceAddSource): LibraryViewState => {
  const state = createLibrarySession().state;
  return {
    ...state,
    scope: source.kind === 'album' ? { kind: 'album', id: source.id } : { kind: 'library' },
    query: { ...state.query },
  };
};

/** The albums offered as a source: plain albums only, and never the space itself. */
export const addSourceOptions = (albums: AlbumResponseDto[], spaceId: string): AlbumResponseDto[] =>
  albums.filter((album) => album.id !== spaceId && album.kind === AlbumKind.Album);

/* -------------------------------------------------------------------------- */
/* The space page's panels (FL-55)                                            */
/* -------------------------------------------------------------------------- */

/**
 * The panels a shared space page offers, in the order they appear.
 *
 * `timeline` first, because a space is somewhere you look at photos before it
 * is anything else; `people`, `places` and `activity` are ways back into the
 * same set; `albums` and `members` are how the space is put together.
 */
export const SPACE_PANELS = ['timeline', 'albums', 'people', 'places', 'activity', 'members'] as const;

export type SpacePanel = (typeof SPACE_PANELS)[number];

export const isSpacePanel = (value: string | null | undefined): value is SpacePanel =>
  !!value && (SPACE_PANELS as readonly string[]).includes(value);

/**
 * The albums this member could link into the space.
 *
 * One level, and one level only: a space links albums, never another space and
 * never a collection, because a collection is itself a container and linking
 * one would make the space two deep. The space itself and anything already
 * linked are gone too, so the picker never offers a no-op. The server enforces
 * all of this again — this is only about not offering a control that will be
 * refused.
 */
export const linkableAlbums = (
  albums: AlbumResponseDto[],
  spaceId: string,
  linkedIds: Iterable<string> = [],
): AlbumResponseDto[] => {
  const linked = new Set(linkedIds);
  return albums.filter((album) => album.id !== spaceId && album.kind === AlbumKind.Album && !linked.has(album.id));
};

/**
 * Whether a linked album has anything to show yet.
 *
 * A link is a reference: it says "this album belongs to this space", not "copy
 * these photos here". So a freshly linked album can honestly be empty in the
 * space until somebody adds its items, and the panel says so rather than
 * implying a broken link.
 */
export const linkedAlbumIsEmpty = (album: Pick<SharedSpaceAlbumResponseDto, 'assetCount'>): boolean =>
  album.assetCount === 0;

/** Whether the "new since your last visit" banner has anything to say. */
export const hasNewSinceVisit = (info: Pick<SharedSpaceNewResponseDto, 'assetCount'> | null | undefined): boolean =>
  !!info && info.assetCount > 0;

/**
 * The ids the timeline is narrowed to when a member asks to see only what is
 * new, or `undefined` to show the whole space.
 *
 * The server caps the list, so a very large catch-up shows the most it can name
 * rather than a number nothing backs up; when the count is bigger than the
 * list, the banner says how many there are and the filter shows the ones it
 * has. An empty filter would mean "show nothing", which is never what is meant,
 * so it collapses to `undefined`.
 */
export const newSinceFilter = (
  info: SharedSpaceNewResponseDto | null | undefined,
  showing: boolean,
): Set<string> | undefined => {
  if (!showing || !info || info.assetIds.length === 0) {
    return undefined;
  }
  return new Set(info.assetIds);
};

/** True when the banner is showing fewer ids than it counted. */
export const newSinceIsPartial = (info: Pick<SharedSpaceNewResponseDto, 'assetCount' | 'assetIds'>): boolean =>
  info.assetIds.length < info.assetCount;

/**
 * The name a person link is offered under before the member edits it.
 *
 * It defaults to the member's own name for them purely as a convenience; the
 * space stores its own copy, so changing it here never renames the person in
 * the member's library, and renaming them there never changes what the space
 * calls them.
 */
export const defaultSpacePersonName = (person: Pick<PersonResponseDto, 'name'>): string => person.name ?? '';

/** People worth offering: the caller's own, seen in the space, that have a name or a face count. */
export const spacePersonCandidates = (people: PersonResponseDto[]): PersonResponseDto[] =>
  people.filter((person) => !person.isHidden);

/** The panel a URL asks for, or the timeline when it names none or one that does not exist. */
export const panelFromSearch = (search: URLSearchParams): SpacePanel => {
  const value = search.get('panel');
  return isSpacePanel(value) ? value : 'timeline';
};

/** How many items the timeline asks for at a time. Matches the collection view's page. */
export const SPACE_TIMELINE_PAGE = 250;

/** The loaded items the timeline shows: all of them, or only the new ones when a filter is on. */
export const filterToNew = <T extends { id: string }>(assets: T[], filter: Set<string> | undefined): T[] =>
  filter ? assets.filter(({ id }) => filter.has(id)) : assets;

/**
 * Whether the timeline should fetch another page on its own while "only what is new" is on.
 *
 * The timeline pages the space by date taken, while "new" means added since the last visit, so a
 * new item can sit on any page. Scrolling cannot be relied on to reach it — a filtered list may be
 * too short to scroll at all — so the timeline keeps paging until it has found every id the banner
 * named, or the space runs out.
 */
export const shouldPageForNew = ({
  filter,
  found,
  exhausted,
  loading,
}: {
  filter: Set<string> | undefined;
  found: number;
  exhausted: boolean;
  loading: boolean;
}): boolean => !!filter && found < filter.size && !exhausted && !loading;

/**
 * Which sentence the "new since your last visit" banner uses. Somebody who has never marked the
 * space seen has no "last visit", so for them it is simply what other members added.
 */
export const newSinceMessageKey = (
  info: Pick<SharedSpaceNewResponseDto, 'lastVisitedAt'>,
): 'frameleaf_spaces_new_since' | 'frameleaf_spaces_new_first' =>
  info.lastVisitedAt ? 'frameleaf_spaces_new_since' : 'frameleaf_spaces_new_first';

/* -------------------------------------------------------------------------- */
/* Comments, mentions and the activity feed (FL-55)                            */
/* -------------------------------------------------------------------------- */

/**
 * A mention as the server stores it: `@{<user id>}`.
 *
 * Ids, never names: a typed name is only text, and a renamed account keeps its
 * mentions. The composer writes this token when a member is picked from the
 * list, and the server checks every token against the space's current members
 * before it stores the comment — so nothing the client does can mention
 * somebody who is not in the space.
 */
export const MENTION_TOKEN = /@\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}/gi;

export const mentionToken = (userId: string): string => `@{${userId}}`;

export type MentionUser = Pick<UserResponseDto, 'id' | 'name'>;

export type CommentSegment =
  { kind: 'text'; text: string } | { kind: 'mention'; userId: string; user: MentionUser | null };

/**
 * Split a comment into plain text and mentions, naming each mention from the
 * users given (the space's members plus the comment's own resolved mentions).
 * A token nobody matches — a member who has since left — is kept as a mention
 * with no user, so the text still reads as a mention rather than as an id.
 */
export const splitMentions = (comment: string, users: MentionUser[]): CommentSegment[] => {
  const segments: CommentSegment[] = [];
  let last = 0;
  for (const match of comment.matchAll(MENTION_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) {
      segments.push({ kind: 'text', text: comment.slice(last, index) });
    }
    const userId = match[1].toLowerCase();
    segments.push({ kind: 'mention', userId, user: users.find((user) => user.id === userId) ?? null });
    last = index + match[0].length;
  }
  if (last < comment.length) {
    segments.push({ kind: 'text', text: comment.slice(last) });
  }
  return segments;
};

export type MentionQuery = { start: number; query: string };

/**
 * The "@name" being typed right before the caret, if any: an @ at the start
 * of the text or after whitespace, followed by the letters typed so far.
 * Anything with whitespace after the @ is not a mention in progress, and an
 * @ inside a word (an email address) is left alone.
 */
export const mentionQueryAt = (text: string, caret: number): MentionQuery | null => {
  const before = text.slice(0, Math.max(0, caret));
  const match = /(?:^|\s)@([^\s@{}]*)$/.exec(before);
  if (!match) {
    return null;
  }
  return { start: before.length - match[1].length - 1, query: match[1] };
};

/** Replace the "@name" being typed with the chosen member's token and a space. */
export const insertMention = (
  text: string,
  at: MentionQuery,
  caret: number,
  userId: string,
): { text: string; caret: number } => {
  const token = `${mentionToken(userId)} `;
  return { text: text.slice(0, at.start) + token + text.slice(caret), caret: at.start + token.length };
};

/**
 * Who the composer offers for a mention: members who have joined (an
 * invitation is not a membership, and the server would refuse the mention),
 * other than the author, matched on name or email.
 */
export const mentionCandidates = (
  members: SharedSpaceMemberResponseDto[],
  query: string,
  excludeId?: string,
  limit = 8,
): SharedSpaceMemberResponseDto[] => {
  const needle = query.trim().toLowerCase();
  return members
    .filter(
      ({ user, pending }) =>
        !pending &&
        user.id !== excludeId &&
        (!needle || user.name.toLowerCase().includes(needle) || user.email.toLowerCase().startsWith(needle)),
    )
    .slice(0, limit);
};

/** Whether a feed event is news to this member: somebody else did it, after this member's marker. */
export const isNewSpaceEvent = (
  event: Pick<SharedSpaceEventResponseDto, 'actor' | 'createdAt'>,
  viewerId: string | undefined,
  lastVisitedAt: string | null,
): boolean =>
  event.actor?.id !== viewerId &&
  (!lastVisitedAt || new Date(event.createdAt).getTime() > new Date(lastVisitedAt).getTime());

/** The sentence an event is told with. A comment or like on an item reads differently from one on the space. */
export const spaceEventMessageKey = (
  event: Pick<SharedSpaceEventResponseDto, 'type' | 'assetCount'> &
    Partial<Pick<SharedSpaceEventResponseDto, 'actor' | 'targetUser'>>,
): Translations => {
  switch (event.type) {
    case SharedSpaceEventType.AssetsAdded: {
      return 'frameleaf_spaces_activity_assets_added';
    }
    case SharedSpaceEventType.AssetsRemoved: {
      return 'frameleaf_spaces_activity_assets_removed';
    }
    case SharedSpaceEventType.AlbumLinked: {
      return 'frameleaf_spaces_activity_album_linked';
    }
    case SharedSpaceEventType.AlbumUnlinked: {
      return 'frameleaf_spaces_activity_album_unlinked';
    }
    case SharedSpaceEventType.PersonLinked: {
      return 'frameleaf_spaces_activity_person_linked';
    }
    case SharedSpaceEventType.PersonUnlinked: {
      return 'frameleaf_spaces_activity_person_unlinked';
    }
    case SharedSpaceEventType.MemberJoined: {
      return 'frameleaf_spaces_activity_member_joined';
    }
    case SharedSpaceEventType.MemberLeft: {
      return 'frameleaf_spaces_activity_member_left';
    }
    case SharedSpaceEventType.MemberRemoved: {
      return 'frameleaf_spaces_activity_member_removed';
    }
    case SharedSpaceEventType.MemberRoleChanged: {
      return 'frameleaf_spaces_activity_member_role';
    }
    case SharedSpaceEventType.Comment: {
      return event.assetCount > 0
        ? 'frameleaf_spaces_activity_comment_item'
        : 'frameleaf_spaces_activity_comment_space';
    }
    case SharedSpaceEventType.Reply: {
      // Answering in one's own thread reads as that, not as "Bo replied to Bo's comment".
      if (event.actor && event.actor.id === event.targetUser?.id) {
        return event.assetCount > 0
          ? 'frameleaf_spaces_activity_reply_own_item'
          : 'frameleaf_spaces_activity_reply_own_space';
      }
      return event.assetCount > 0 ? 'frameleaf_spaces_activity_reply_item' : 'frameleaf_spaces_activity_reply_space';
    }
    case SharedSpaceEventType.Like: {
      return event.assetCount > 0 ? 'frameleaf_spaces_activity_like_item' : 'frameleaf_spaces_activity_like_space';
    }
    default: {
      return 'frameleaf_spaces_activity_unknown';
    }
  }
};

/** How many thumbnails an event shows before folding the rest into "+N more". */
export const EVENT_THUMBNAILS = 4;

/** The count shown beside the Activity panel's name, or nothing when there is nothing new. */
export const activityUnreadHint = (
  feed: Pick<SharedSpaceActivityResponseDto, 'unreadCount'> | null | undefined,
): string | undefined => (feed && feed.unreadCount > 0 ? String(feed.unreadCount) : undefined);

/* -------------------------------------------------------------------------- */
/* Threaded replies (FL-55)                                                    */
/* -------------------------------------------------------------------------- */

/** A top-level comment and its replies, oldest reply first. */
export type CommentThread = {
  comment: SharedSpaceCommentResponseDto;
  replies: SharedSpaceCommentResponseDto[];
  /** The newest moment anything was said in the thread: the comment or its latest reply. */
  lastActivityAt: string;
};

const time = (iso: string) => new Date(iso).getTime();
const latest = (a: string, b: string) => (time(b) > time(a) ? b : a);

/**
 * Arrange the server's flat, oldest-first list into one-level threads.
 *
 * Replies sit under the top-level comment they name, oldest first, as a
 * conversation reads. Threads are ordered by their latest activity with the
 * most recent last, so whatever was said most recently — a new comment or a
 * new reply in an older thread — is next to the composer where the list is
 * scrolled to. A reply whose comment is not in the list is shown as a thread
 * of its own rather than dropped.
 */
export const groupCommentThreads = (comments: SharedSpaceCommentResponseDto[]): CommentThread[] => {
  const ids = new Set(comments.map(({ id }) => id));
  const threads = new Map<string, CommentThread>();
  const replies: SharedSpaceCommentResponseDto[] = [];

  for (const comment of comments) {
    if (comment.parentId && ids.has(comment.parentId)) {
      replies.push(comment);
    } else {
      threads.set(comment.id, { comment, replies: [], lastActivityAt: comment.createdAt });
    }
  }

  for (const reply of replies) {
    const thread = threads.get(reply.parentId!);
    if (thread) {
      thread.replies.push(reply);
      thread.lastActivityAt = latest(thread.lastActivityAt, reply.createdAt);
    } else {
      // The named comment is itself a reply; keep it visible on its own.
      threads.set(reply.id, { comment: reply, replies: [], lastActivityAt: reply.createdAt });
    }
  }

  const byTime = (a: { createdAt: string }, b: { createdAt: string }) => time(a.createdAt) - time(b.createdAt);

  return [...threads.values()]
    .map((thread) => ({ ...thread, replies: [...thread.replies].sort(byTime) }))
    .sort((a, b) => time(a.lastActivityAt) - time(b.lastActivityAt) || byTime(a.comment, b.comment));
};

/** The comment a reply is posted to: the thread's top-level comment, whichever comment was answered. */
export const threadRootId = (comment: Pick<SharedSpaceCommentResponseDto, 'id' | 'parentId'>): string =>
  comment.parentId ?? comment.id;

/**
 * What a reply box starts with.
 *
 * Answering a reply mentions the person who wrote it, so they hear about it
 * even though the reply is stored under the thread's top-level comment.
 * Answering a top-level comment starts empty — its author is told anyway —
 * and so does answering oneself. The mention is only offered for somebody
 * who is still a member, because the server refuses a mention of anyone else.
 */
const prefillFor = (
  authorId: string | undefined,
  answersAReply: boolean,
  currentUserId: string | undefined,
  members: Pick<SharedSpaceMemberResponseDto, 'user' | 'pending'>[],
): string => {
  if (!authorId || !answersAReply || authorId === currentUserId) {
    return '';
  }
  const stillMember = members.some(({ user, pending }) => !pending && user.id === authorId);
  return stillMember ? `${mentionToken(authorId)} ` : '';
};

export const replyPrefill = (
  comment: Pick<SharedSpaceCommentResponseDto, 'parentId' | 'user'>,
  currentUserId: string | undefined,
  members: Pick<SharedSpaceMemberResponseDto, 'user' | 'pending'>[],
): string => prefillFor(comment.user.id, !!comment.parentId, currentUserId, members);

/** The same rule for answering from the activity feed, where a reply is a Reply event by its actor. */
export const eventReplyPrefill = (
  event: Pick<SharedSpaceEventResponseDto, 'type' | 'actor'>,
  currentUserId: string | undefined,
  members: Pick<SharedSpaceMemberResponseDto, 'user' | 'pending'>[],
): string => prefillFor(event.actor?.id, event.type === SharedSpaceEventType.Reply, currentUserId, members);

/** Whether a feed event is a comment or reply that can be answered from the feed. */
export const canReplyToEvent = (event: Pick<SharedSpaceEventResponseDto, 'type' | 'activityId'>): boolean =>
  !!event.activityId && (event.type === SharedSpaceEventType.Comment || event.type === SharedSpaceEventType.Reply);

/** A comment list after one comment is removed: a top-level comment takes its replies with it. */
export const withoutComment = (
  comments: SharedSpaceCommentResponseDto[],
  removed: Pick<SharedSpaceCommentResponseDto, 'id' | 'parentId'>,
): SharedSpaceCommentResponseDto[] => {
  if (removed.parentId) {
    return comments
      .filter(({ id }) => id !== removed.id)
      .map((comment) =>
        comment.id === removed.parentId ? { ...comment, replyCount: Math.max(0, comment.replyCount - 1) } : comment,
      );
  }
  return comments.filter(({ id, parentId }) => id !== removed.id && parentId !== removed.id);
};

/** A comment list after a reply is added: the reply joins, and its thread's count goes up. */
export const withReply = (
  comments: SharedSpaceCommentResponseDto[],
  reply: SharedSpaceCommentResponseDto,
): SharedSpaceCommentResponseDto[] => [
  ...comments.map((comment) =>
    comment.id === reply.parentId ? { ...comment, replyCount: comment.replyCount + 1 } : comment,
  ),
  reply,
];
