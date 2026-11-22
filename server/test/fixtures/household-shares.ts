import { randomUUID } from 'node:crypto';

export type WorldItem = {
  id: string;
  ownerId: string;
  albums: Set<string>;
  type: 'IMAGE' | 'VIDEO';
  visibility: 'timeline' | 'archive' | 'hidden';
  deleted?: boolean;
  locked?: boolean;
  ruleHidden?: boolean;
  sensitive?: boolean;
  livePhotoVideoId?: string | null;
  stackId?: string | null;
  checksum: Buffer;
  originalPath: string;
  originalFileName: string;
  description: string;
};
type Member = {
  shareId: string;
  remoteUserId: string;
  displayName: string;
  role: string;
  invitedAt: Date;
  acceptedAt: Date | null;
  leftAt: Date | null;
};
type Change = { shareId: string; kind: string; entityId: string; seq: number; assetId?: string | null };
type PersonLink = { id: string; albumId: string; name: string; personOwnerId: string; personGroupId: string };
type Face = { assetId: string; personGroupId: string };

export type MemoryActivity = {
  id: string;
  albumId: string;
  assetId: string | null;
  userId: string | null;
  remoteAuthorId: string | null;
  isLiked: boolean;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type MemoryLink = {
  inboundShareId: string;
  remoteId: string;
  activityId: string | null;
  own: boolean;
  pending: string | null;
  revision: number;
  attempts: number;
  nextAttemptAt: Date | null;
};
type InboundStore = {
  shares: Array<{
    id: string;
    albumId: string | null;
    state: string;
    linkId: string;
    userId: string;
    remoteShareId: string;
  }>;
  origins: Array<{
    linkId: string;
    userId: string;
    kind: string;
    remoteId: string;
    localId: string;
    shareIds: string[];
  }>;
  library?: { albums: Map<string, { items: Set<string> }> };
};

/** `HouseholdCommentRepository`, in memory: one server's `activity` rows. The medium spec covers the real SQL. */
export class MemoryComments {
  activities = new Map<string, MemoryActivity>();
  authors: Array<{ id: string; linkId: string; remoteUserId: string; displayName: string }> = [];
  links: MemoryLink[] = [];
  events: Array<{ albumId: string; activityId: string; isLiked: boolean }> = [];
  mentions = new Map<string, string[]>();
  localUsers = new Map<string, string>();
  albumMembers = new Map<string, Set<string>>();
  inbound?: InboundStore;

  /** A comment written by a local account, as the activity endpoints store it. */
  addLocal(row: Partial<MemoryActivity> & { albumId: string; userId: string }) {
    const activity: MemoryActivity = {
      id: randomUUID(),
      assetId: null,
      remoteAuthorId: null,
      isLiked: false,
      comment: 'hello',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
      ...row,
    };
    this.activities.set(activity.id, activity);
    return activity;
  }
  remove(id: string) {
    this.activities.delete(id);
    for (const link of this.links) {
      if (link.activityId === id) link.activityId = null;
    }
    return [id];
  }
  private link = (shareId: string, remoteId: string) =>
    this.links.find((row) => row.inboundShareId === shareId && row.remoteId === remoteId);

  upsertAuthor = (linkId: string, remoteUserId: string, displayName: string) => {
    let row = this.authors.find((author) => author.linkId === linkId && author.remoteUserId === remoteUserId);
    if (row) {
      row.displayName = displayName;
    } else {
      row = { id: randomUUID(), linkId, remoteUserId, displayName };
      this.authors.push(row);
    }
    return Promise.resolve(row.id);
  };
  getActivity = (id: string) => {
    const row = this.activities.get(id);
    const author = this.authors.find((candidate) => candidate.id === row?.remoteAuthorId);
    return Promise.resolve(
      row && { ...row, authorLinkId: author?.linkId ?? null, authorRemoteUserId: author?.remoteUserId ?? null },
    );
  };
  createRemote = (comment: Partial<MemoryActivity> & { albumId: string; remoteAuthorId: string }) => {
    const id = comment.id ?? randomUUID();
    const liked = this.activities
      .values()
      .some(
        (row) =>
          comment.isLiked &&
          row.isLiked &&
          row.albumId === comment.albumId &&
          row.assetId === (comment.assetId ?? null) &&
          row.remoteAuthorId === comment.remoteAuthorId,
      );
    if (this.activities.has(id) || liked) {
      return Promise.resolve(undefined);
    }
    const now = new Date();
    this.activities.set(id, {
      assetId: null,
      isLiked: false,
      comment: null,
      createdAt: now,
      ...comment,
      id,
      userId: null,
      updatedAt: now,
    });
    return Promise.resolve({ id });
  };
  updateText = (id: string, comment: string) => {
    Object.assign(this.activities.get(id)!, { comment, updatedAt: new Date() });
    return Promise.resolve();
  };
  deleteActivity = (id: string) => {
    this.remove(id);
    return Promise.resolve();
  };
  addEvent = (albumId: string, activityId: string, isLiked: boolean) => {
    this.events.push({ albumId, activityId, isLiked });
    return Promise.resolve();
  };
  setMentions = (activityId: string, albumId: string, text: string) => {
    const named = text
      .matchAll(/@\{([\da-f-]{36})\}/g)
      .map((match) => match[1])
      .toArray();
    const members = named.filter((id) => this.albumMembers.get(albumId)?.has(id));
    const previous = this.mentions.get(activityId) ?? [];
    this.mentions.set(activityId, members);
    return Promise.resolve(members.filter((id) => !previous.includes(id)));
  };
  isLocalUser = (id: string) => Promise.resolve(this.localUsers.has(id));
  getComments = (albumId: string, ids: string[]) =>
    Promise.resolve(
      ids.flatMap((id) => {
        const row = this.activities.get(id);
        if (row?.albumId !== albumId) return [];
        const author = this.authors.find((candidate) => candidate.id === row.remoteAuthorId);
        return [
          {
            ...row,
            localId: row.userId,
            localName: row.userId ? (this.localUsers.get(row.userId) ?? 'Local') : null,
            remoteUserId: author?.remoteUserId ?? null,
            remoteName: author?.displayName ?? null,
          },
        ];
      }),
    );
  removeRemoteLikes = (albumId: string, assetId: string | null, remoteAuthorId: string) => {
    const ids = this.activities
      .values()
      .filter(
        (row) =>
          row.isLiked && row.albumId === albumId && row.assetId === assetId && row.remoteAuthorId === remoteAuthorId,
      )
      .map(({ id }) => id)
      .toArray();
    for (const id of ids) this.remove(id);
    return Promise.resolve(ids);
  };

  getLink = (shareId: string, remoteId: string) => {
    const row = this.link(shareId, remoteId);
    return Promise.resolve(row && { ...row });
  };
  deleteLink = (shareId: string, remoteId: string) => {
    this.links = this.links.filter((row) => row.inboundShareId !== shareId || row.remoteId !== remoteId);
    return Promise.resolve();
  };
  countLinks = (shareId: string) => Promise.resolve(this.links.filter((row) => row.inboundShareId === shareId).length);
  createCopy = async (
    inboundShareId: string,
    remoteId: string,
    comment: Partial<MemoryActivity> & { albumId: string; remoteAuthorId: string },
  ) => {
    const row = await this.createRemote(comment);
    if (row) {
      this.links.push({
        inboundShareId,
        remoteId,
        activityId: row.id,
        own: false,
        pending: null,
        revision: 0,
        attempts: 0,
        nextAttemptAt: null,
      });
    }
    return row;
  };
  getAcceptedShareOfAlbum = (albumId: string) =>
    Promise.resolve(this.inbound?.shares.find((share) => share.albumId === albumId && share.state === 'accepted'));
  getLocalAsset = (linkId: string, userId: string, remoteId: string, albumId: string) => {
    const origin = this.inbound?.origins.find(
      (row) => row.linkId === linkId && row.userId === userId && row.kind === 'asset' && row.remoteId === remoteId,
    );
    return Promise.resolve(
      origin && this.inbound?.library?.albums.get(albumId)?.items.has(origin.localId) ? origin.localId : undefined,
    );
  };
  getRemoteAsset = (linkId: string, userId: string, shareId: string, localId: string) =>
    Promise.resolve(
      this.inbound?.origins.find(
        (row) =>
          row.linkId === linkId &&
          row.userId === userId &&
          row.kind === 'asset' &&
          row.localId === localId &&
          row.shareIds.includes(shareId),
      )?.remoteId,
    );
  queue = (inboundShareId: string, remoteId: string, pending: string, activityId?: string) => {
    const row = this.link(inboundShareId, remoteId);
    if (row) {
      Object.assign(row, { pending, revision: row.revision + 1, attempts: 0, nextAttemptAt: null });
    } else {
      this.links.push({
        inboundShareId,
        remoteId,
        activityId: activityId ?? null,
        own: true,
        pending,
        revision: 0,
        attempts: 0,
        nextAttemptAt: null,
      });
    }
    return Promise.resolve();
  };
  getDue = (linkId: string, limit: number) =>
    Promise.resolve(
      this.links
        .filter((row) => row.pending && (!row.nextAttemptAt || row.nextAttemptAt.getTime() <= Date.now()))
        .flatMap((row) => {
          const share = this.inbound?.shares.find(({ id }) => id === row.inboundShareId);
          return share?.linkId === linkId && share.state === 'accepted'
            ? [{ ...row, remoteShareId: share.remoteShareId, userId: share.userId, linkId: share.linkId }]
            : [];
        })
        .slice(0, limit),
    );
  markSent = (shareId: string, remoteId: string, revision: number) => {
    const row = this.link(shareId, remoteId);
    if (row?.revision === revision) Object.assign(row, { pending: null, attempts: 0, nextAttemptAt: null });
    return Promise.resolve();
  };
  retryLater = (shareId: string, remoteId: string, attempts: number, nextAttemptAt: Date) => {
    Object.assign(this.link(shareId, remoteId)!, { attempts, nextAttemptAt });
    return Promise.resolve();
  };
}

/**
 * `HouseholdShareRepository` and the repositories around it, in memory. `isMemberVisible` stands in for the SQL of
 * `filterVisibleSpaceAssetIds`, so a spec on this world proves the logic around that query, never the query:
 * `test/medium/specs/services/household-share.service.spec.ts` compares the real one.
 */
export class ShareWorld {
  private seq = 0;
  shares: Array<{ id: string; albumId: string; linkId: string }> = [];
  members: Member[] = [];
  changes: Change[] = [];
  spaces = new Map<string, { id: string; name: string; description: string; ownerId: string; ownerName: string }>();
  items = new Map<string, WorldItem>();
  stacks = new Map<string, string>();
  people: PersonLink[] = [];
  faces: Face[] = [];
  accounts: Array<{ id: string; name: string; email: string; profileImagePath: string; active: boolean }> = [];
  personRules = new Map<string, string[]>();
  fileSizes = new Map<string, number>();

  isMemberVisible(item: WorldItem | undefined, albumId: string) {
    return (
      !!item &&
      item.albums.has(albumId) &&
      !item.deleted &&
      !item.locked &&
      !item.ruleHidden &&
      !item.sensitive &&
      item.visibility !== 'hidden'
    );
  }

  albumUsers = {
    filterVisibleSpaceAssetIds: (albumId: string, ids: string[]) =>
      Promise.resolve(new Set(ids.filter((id) => this.isMemberVisible(this.items.get(id), albumId)))),
    deleteCommentWithReplies: (id: string) => Promise.resolve(this.comments.remove(id)),
  };
  comments: MemoryComments = new MemoryComments();
  albums = {
    getById: (id: string) => {
      const space = this.spaces.get(id);
      return Promise.resolve(
        space && {
          id,
          kind: 'space',
          isActivityEnabled: true,
          albumUsers: [{ role: 'owner', user: { id: space.ownerId } }],
        },
      );
    },
  };
  access = {
    album: {
      checkOwnerAccess: (userId: string, ids: Set<string>) =>
        Promise.resolve(new Set([...ids].filter((id) => this.spaces.get(id)?.ownerId === userId))),
      checkSharedAlbumAccess: () => Promise.resolve(new Set<string>()),
      checkSharedLinkAccess: () => Promise.resolve(new Set<string>()),
    },
  };
  users = {
    getMetadata: (userId: string) =>
      Promise.resolve([
        { key: 'preferences', value: { privacy: { suppression: { personIds: this.personRules.get(userId) ?? [] } } } },
      ]),
  };
  storage = { stat: (path: string) => Promise.resolve({ size: this.fileSizes.get(path) ?? 1000 }) };

  private move(shareId: string, kind: string, entityId: string) {
    const row = this.changes.find((c) => c.shareId === shareId && c.kind === kind && c.entityId === entityId);
    if (row) {
      row.seq = ++this.seq;
    } else {
      this.changes.push({ shareId, kind, entityId, seq: ++this.seq });
    }
  }
  private addMissing(albumId: string) {
    for (const share of this.shares) {
      if (share.albumId !== albumId) {
        continue;
      }
      const named = (kind: string, id: string) =>
        this.changes.some((c) => c.shareId === share.id && c.kind === kind && c.entityId === id);
      for (const item of this.items.values()) {
        if (item.albums.has(albumId)) {
          for (const id of [item.id, item.livePhotoVideoId]) {
            if (id && !named('asset', id)) {
              this.move(share.id, 'asset', id);
            }
          }
        }
      }
      for (const person of this.people) {
        if (person.albumId === albumId && !named('person', person.id)) {
          this.move(share.id, 'person', person.id);
        }
      }
      for (const row of this.comments.activities.values()) {
        if (row.albumId === albumId && !named('comment', row.id)) {
          this.move(share.id, 'comment', row.id);
          this.changes.at(-1)!.assetId = row.assetId;
        }
      }
    }
  }

  hasShares = () => Promise.resolve(this.shares.length > 0);
  getShare = (linkId: string, shareId: string) =>
    Promise.resolve(this.shares.find((share) => share.id === shareId && share.linkId === linkId));
  getSharesOfAlbum = (albumId: string) => Promise.resolve(this.shares.filter((share) => share.albumId === albumId));
  getOffered = (linkId: string) =>
    Promise.resolve(
      this.shares
        .filter((share) => share.linkId === linkId)
        .map((share) => {
          const space = this.spaces.get(share.albumId)!;
          return { id: share.id, albumName: space.name, description: space.description, ownerName: space.ownerName };
        }),
    );
  getMembers = (shareIds: string[]) =>
    Promise.resolve(this.members.filter((member) => shareIds.includes(member.shareId)));
  hasAcceptedMember = (shareId: string) =>
    Promise.resolve(this.members.some((m) => m.shareId === shareId && m.acceptedAt && !m.leftAt));
  invite = (member: { albumId: string; linkId: string; remoteUserId: string; displayName: string; role: string }) => {
    let share = this.shares.find((share) => share.albumId === member.albumId && share.linkId === member.linkId);
    if (!share) {
      if (this.shares.filter(({ linkId }) => linkId === member.linkId).length >= 200) {
        return Promise.resolve('share-limit' as const);
      }
      share = { id: randomUUID(), albumId: member.albumId, linkId: member.linkId };
      this.shares.push(share);
      this.addMissing(member.albumId);
    }
    const shareId = share.id;
    const others = this.members.filter(
      (m) => m.shareId === shareId && !m.leftAt && m.remoteUserId !== member.remoteUserId,
    );
    if (others.length >= 50) {
      return Promise.resolve('member-limit' as const);
    }
    const existing = this.members.find((m) => m.shareId === shareId && m.remoteUserId === member.remoteUserId);
    if (existing) {
      Object.assign(existing, {
        displayName: member.displayName,
        role: member.role,
        acceptedAt: existing.leftAt ? null : existing.acceptedAt,
        leftAt: null,
      });
    } else {
      this.members.push({
        shareId,
        remoteUserId: member.remoteUserId,
        displayName: member.displayName,
        role: member.role,
        invitedAt: new Date(),
        acceptedAt: null,
        leftAt: null,
      });
    }
    return Promise.resolve(shareId);
  };
  setRole = (albumId: string, shareId: string, remoteUserId: string, role: string) => {
    const owned = this.shares.some((share) => share.id === shareId && share.albumId === albumId);
    const member = this.members.find((m) => m.shareId === shareId && m.remoteUserId === remoteUserId);
    if (owned && member) {
      member.role = role;
    }
    return Promise.resolve(owned && !!member);
  };
  removeMember = (albumId: string, shareId: string, remoteUserId: string) => {
    const owned = this.shares.some((share) => share.id === shareId && share.albumId === albumId);
    const index = this.members.findIndex((m) => m.shareId === shareId && m.remoteUserId === remoteUserId);
    if (!owned || index === -1) {
      return Promise.resolve(false);
    }
    this.members.splice(index, 1);
    if (this.members.every((m) => m.shareId !== shareId)) {
      this.shares = this.shares.filter((share) => share.id !== shareId);
      this.changes = this.changes.filter((change) => change.shareId !== shareId);
    }
    return Promise.resolve(true);
  };
  accept = (shareId: string, remoteUserId: string) => {
    const member = this.members.find((m) => m.shareId === shareId && m.remoteUserId === remoteUserId && !m.leftAt);
    if (member) {
      member.acceptedAt ??= new Date();
    }
    return Promise.resolve(!!member);
  };
  leave = (shareId: string, remoteUserId: string) => {
    const member = this.members.find((m) => m.shareId === shareId && m.remoteUserId === remoteUserId);
    if (member) {
      member.leftAt ??= new Date();
    }
    return Promise.resolve(!!member);
  };
  seedAlbum = (albumId: string) => Promise.resolve(this.addMissing(albumId));
  touchAssets = (ids: string[]) => {
    const targets = new Set(ids.flatMap((id) => [id, this.items.get(id)?.livePhotoVideoId ?? id]));
    for (const share of this.shares) {
      for (const id of targets) {
        const inAlbum = this.items.get(id)?.albums.has(share.albumId);
        const ofStill = this.items
          .values()
          .some((item) => item.livePhotoVideoId === id && item.albums.has(share.albumId));
        const named = this.changes.some((c) => c.shareId === share.id && c.kind === 'asset' && c.entityId === id);
        if (inAlbum || ofStill || named) {
          this.move(share.id, 'asset', id);
        }
      }
      for (const person of this.people) {
        if (
          person.albumId === share.albumId &&
          this.faces.some((f) => f.personGroupId === person.personGroupId && ids.includes(f.assetId))
        ) {
          this.move(share.id, 'person', person.id);
        }
      }
      const onTheseItems = this.changes.filter(
        (c) => c.shareId === share.id && c.kind === 'comment' && c.assetId && ids.includes(c.assetId),
      );
      for (const row of onTheseItems) {
        row.seq = ++this.seq;
      }
    }
    return Promise.resolve();
  };
  touchComments = (albumId: string, ids: string[]) => {
    const inAlbum = this.shares.filter((s) => s.albumId === albumId);
    for (const share of inAlbum) {
      for (const id of ids) {
        const assetId = this.comments.activities.get(id)?.assetId;
        this.move(share.id, 'comment', id);
        const row = this.changes.find((c) => c.shareId === share.id && c.kind === 'comment' && c.entityId === id)!;
        row.assetId ??= assetId ?? null;
      }
    }
    return Promise.resolve();
  };
  getMember = (shareId: string, remoteUserId: string) =>
    Promise.resolve(this.members.find((m) => m.shareId === shareId && m.remoteUserId === remoteUserId));
  touchPerson = (albumId: string, personLinkId: string) => {
    for (const share of this.shares) {
      if (share.albumId === albumId) {
        this.move(share.id, 'person', personLinkId);
      }
    }
    return Promise.resolve();
  };
  touchOwner = (ownerId: string) => {
    const rows = this.changes.filter((c) => c.kind === 'asset' && this.items.get(c.entityId)?.ownerId === ownerId);
    const shareIds = new Set(rows.map((row) => row.shareId));
    for (const row of [...rows, ...this.changes.filter((c) => c.kind === 'person' && shareIds.has(c.shareId))]) {
      row.seq = ++this.seq;
    }
    return Promise.resolve();
  };
  getChanges = (shareId: string, cursor: number, take: number) =>
    Promise.resolve(
      this.changes
        .filter((change) => change.shareId === shareId && change.seq > cursor)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, take),
    );
  getLastSeq = (shareId: string) =>
    Promise.resolve(Math.max(0, ...this.changes.filter((c) => c.shareId === shareId).map(({ seq }) => seq)));
  getAssets = (ids: string[]) =>
    Promise.resolve(
      ids.flatMap((id) => {
        const item = this.items.get(id);
        return item
          ? [
              {
                id: item.id,
                type: item.type,
                originalFileName: item.originalFileName,
                checksum: item.checksum,
                fileCreatedAt: new Date('2026-01-01T00:00:00Z'),
                localDateTime: new Date('2026-01-01T00:00:00Z'),
                width: 100,
                height: 100,
                duration: null,
                livePhotoVideoId: item.livePhotoVideoId ?? null,
                stackId: item.stackId ?? null,
                updatedAt: new Date('2026-01-02T00:00:00Z'),
                fileSizeInByte: 1000,
                timeZone: 'UTC',
                description: item.description,
                rating: null,
                latitude: 1,
                longitude: 2,
                city: 'Leeds',
                state: null,
                country: 'UK',
              },
            ]
          : [];
      }),
    );
  getStacks = (stackIds: string[]) =>
    Promise.resolve(
      this.items
        .values()
        .filter((item) => item.stackId && stackIds.includes(item.stackId))
        .map((item) => ({
          stackId: item.stackId!,
          primaryAssetId: this.stacks.get(item.stackId!)!,
          assetId: item.id,
        }))
        .toArray(),
    );
  getMotionParts = (ids: string[]) =>
    Promise.resolve(
      this.items
        .values()
        .flatMap((still) => {
          const motion = still.livePhotoVideoId ? this.items.get(still.livePhotoVideoId) : undefined;
          return motion &&
            ids.includes(motion.id) &&
            motion.ownerId === still.ownerId &&
            motion.visibility === 'hidden' &&
            !motion.deleted &&
            !motion.locked &&
            !motion.ruleHidden &&
            !motion.sensitive
            ? [{ id: motion.id, stillId: still.id }]
            : [];
        })
        .toArray(),
    );
  getOriginal = (id: string) => Promise.resolve(this.items.get(id));
  getPersonLinks = (albumId: string, ids: string[]) =>
    Promise.resolve(this.people.filter((person) => person.albumId === albumId && ids.includes(person.id)));
  getPersonFaces = (albumId: string, personGroupId: string) =>
    Promise.resolve(
      this.faces
        .filter((face) => face.personGroupId === personGroupId && this.items.get(face.assetId)?.albums.has(albumId))
        .map(({ assetId }) => ({
          assetId,
          boundingBoxX1: 1,
          boundingBoxY1: 2,
          boundingBoxX2: 3,
          boundingBoxY2: 4,
          imageWidth: 100,
          imageHeight: 100,
        })),
    );
  getDirectory = () =>
    Promise.resolve(
      this.accounts
        .filter(({ active }) => active)
        .map(({ id, name, profileImagePath }) => ({ id, name, profileImagePath })),
    );
  getDirectoryUser = (id: string) => Promise.resolve(this.accounts.find((user) => user.id === id && user.active));

  /* builders for the specs */
  addSpace(ownerId: string, name = 'Family') {
    const id = randomUUID();
    this.spaces.set(id, { id, name, description: 'Our summer', ownerId, ownerName: 'Anna Owner' });
    return id;
  }
  addItem(spaceId: string | null, change: Partial<WorldItem> = {}) {
    const id = change.id ?? randomUUID();
    const item: WorldItem = {
      id,
      ownerId: spaceId ? this.spaces.get(spaceId)!.ownerId : randomUUID(),
      albums: new Set(spaceId ? [spaceId] : []),
      type: 'IMAGE',
      visibility: 'timeline',
      checksum: Buffer.from(id.replaceAll('-', '').slice(0, 40).padEnd(40, 'a'), 'hex'),
      originalPath: `/data/library/${id}.jpg`,
      originalFileName: `${id}.jpg`,
      description: '',
      ...change,
    };
    this.items.set(id, item);
    return item;
  }
}
