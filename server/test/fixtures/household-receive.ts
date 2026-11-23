import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { vi } from 'vitest';
import type {
  HouseholdInboundShare,
  HouseholdLocalFace,
  HouseholdOrigin,
  HouseholdOriginKey,
} from 'src/repositories/household-receive.repository.js';
import type { HouseholdFaceBox } from 'src/schema/tables/household-receive.table.js';
import type { HouseholdServer } from 'test/fixtures/household-servers.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetType } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { HouseholdReceiveService } from 'src/services/household-receive.service.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a named shape keeps exported fixture types portable
type AnyMock = (...args: any[]) => any;

type Row = Record<string, any>;
const sameKey = (origin: HouseholdOrigin, key: HouseholdOriginKey) =>
  origin.linkId === key.linkId &&
  origin.remoteId === key.remoteId &&
  origin.kind === key.kind &&
  origin.userId === key.userId;

/** `HouseholdReceiveRepository` with the same rules, in memory. The medium spec covers the real SQL. */
export class MemoryReceive {
  shares: HouseholdInboundShare[] = [];
  origins: HouseholdOrigin[] = [];
  files = new Map<string, { path: string; size: number }>();
  pending = new Map<
    string,
    { linkId: string; userId: string; remoteId: string; name: string; faces: HouseholdFaceBox[] }
  >();
  activeUsers = new Set<string>();
  faces: HouseholdLocalFace[] = [];
  recognized = new Set<string>();
  library?: ReceiverLibrary;

  getShare = (id: string) => Promise.resolve(this.shares.find((share) => share.id === id));
  getSharesOfLink = (linkId: string) => Promise.resolve(this.shares.filter((share) => share.linkId === linkId));
  getSharesOfUser = (userId: string) => Promise.resolve(this.shares.filter((share) => share.userId === userId));
  getActiveUserIds = (ids: string[]) => Promise.resolve(new Set(ids.filter((id) => this.activeUsers.has(id))));
  createInvited = (share: Row) => {
    if (
      this.shares.some(
        (s) => s.linkId === share.linkId && s.remoteShareId === share.remoteShareId && s.userId === share.userId,
      )
    ) {
      return Promise.resolve(undefined);
    }
    const row = {
      id: randomUUID(),
      albumId: null,
      state: 'invited',
      cursor: 0,
      lastPulledAt: null,
      lastError: null,
      failures: 0,
      nextPullAt: null,
      pullingUntil: null,
      leaveUnsent: false,
      partialPath: null,
      reconcileStartedAt: null,
      lastReconciledAt: null,
      createdAt: new Date(),
      ...share,
    } as unknown as HouseholdInboundShare;
    this.shares.push(row);
    return Promise.resolve(row);
  };
  updateShare = (id: string, change: Row) => {
    const row = this.shares.find((share) => share.id === id);
    return Promise.resolve(row && Object.assign(row, change));
  };
  getDue = (linkId: string) =>
    Promise.resolve(
      this.shares
        .filter(
          (s) =>
            s.linkId === linkId &&
            s.state === 'accepted' &&
            (!s.nextPullAt || new Date(s.nextPullAt as never).getTime() <= Date.now()),
        )
        .map((s) => ({ ...s })),
    );
  pullNow = (linkId: string) => {
    for (const share of this.shares) {
      if (
        share.linkId === linkId &&
        share.state === 'accepted' &&
        share.lastError !== 'over-quota' &&
        !share.failures
      ) {
        share.nextPullAt = null;
      }
    }
    return Promise.resolve();
  };
  claimPull = (id: string) => Promise.resolve(this.shares.find((share) => share.id === id)?.state === 'accepted');
  renewPull = () => Promise.resolve();

  getOrigin = (key: HouseholdOriginKey) => {
    const row = this.origins.find((origin) => sameKey(origin, key));
    return Promise.resolve(row && { ...row, overriddenFields: [...row.overriddenFields], shareIds: [...row.shareIds] });
  };
  createOrigin = (origin: Row) => {
    if (this.origins.every((row) => !sameKey(row, origin as HouseholdOriginKey))) {
      this.origins.push({
        followUntilEdited: true,
        overriddenFields: [],
        isCopy: false,
        shareIds: [],
        pairedRemoteId: null,
        remoteUpdatedAt: null,
        lastSeenAt: new Date(),
        ...origin,
      } as unknown as HouseholdOrigin);
    }
    return Promise.resolve();
  };
  publish = <T>(write: (tx: never) => Promise<T>) => write(undefined as never);
  updateOrigin = (key: HouseholdOriginKey, change: Row) => {
    const row = this.origins.find((origin) => sameKey(origin, key));
    if (row) Object.assign(row, change);
    return Promise.resolve([]);
  };
  addOriginShare = (key: HouseholdOriginKey, shareId: string) => {
    const row = this.origins.find((origin) => sameKey(origin, key));
    if (row && !row.shareIds.includes(shareId)) row.shareIds.push(shareId);
    return Promise.resolve();
  };
  markSeen = (key: HouseholdOriginKey) => {
    const row = this.origins.find((origin) => sameKey(origin, key));
    if (row) row.lastSeenAt = new Date() as never;
    return Promise.resolve();
  };
  withFollowingOrigin = async (
    key: HouseholdOriginKey,
    apply: (origin: HouseholdOrigin, tx: never) => Promise<void>,
  ) => {
    const row = this.origins.find((origin) => sameKey(origin, key));
    if (row?.followUntilEdited) await apply(row, undefined as never);
  };
  stopFollowing = (key: HouseholdOriginKey) => {
    const row = this.origins.find((origin) => sameKey(origin, key));
    if (row) row.followUntilEdited = false;
    return Promise.resolve();
  };
  getWaitingStills = (linkId: string, userId: string, motion: string) =>
    Promise.resolve(
      this.origins.filter(
        (o) => o.linkId === linkId && o.userId === userId && o.kind === 'asset' && o.pairedRemoteId === motion,
      ),
    );
  leaveOrigins = (share: { id: string; linkId: string; userId: string }) => {
    const live = this.shares
      .filter(
        (s) => s.linkId === share.linkId && s.userId === share.userId && s.state === 'accepted' && s.id !== share.id,
      )
      .map(({ id }) => id);
    for (const origin of this.origins) {
      if (
        origin.linkId === share.linkId &&
        origin.userId === share.userId &&
        (origin.shareIds.includes(share.id) || origin.kind === 'person')
      ) {
        origin.shareIds = origin.shareIds.filter((id) => id !== share.id);
        origin.followUntilEdited &&=
          live.length > 0 && (origin.kind === 'person' || origin.shareIds.some((id) => live.includes(id)));
      }
    }
    if (live.length === 0) {
      for (const [key, row] of this.pending) {
        if (row.linkId === share.linkId && row.userId === share.userId) this.pending.delete(key);
      }
    }
    return Promise.resolve();
  };
  stopUnseen = (share: { id: string; linkId: string; userId: string }, since: Date) => {
    for (const origin of this.origins) {
      if (
        origin.linkId === share.linkId &&
        origin.userId === share.userId &&
        origin.kind === 'asset' &&
        origin.shareIds.includes(share.id) &&
        new Date(origin.lastSeenAt as never).getTime() < since.getTime()
      ) {
        origin.followUntilEdited = false;
      }
    }
    return Promise.resolve();
  };

  private fileKey = (linkId: string, checksum: Buffer) => `${linkId}:${checksum.toString('hex')}`;
  getReceivedFile = (linkId: string, checksum: Buffer) =>
    Promise.resolve(this.files.get(this.fileKey(linkId, checksum)));
  saveReceivedFile = (linkId: string, checksum: Buffer, path: string, size: number) => {
    this.files.set(this.fileKey(linkId, checksum), { path, size });
    return Promise.resolve();
  };
  deleteReceivedFile = (linkId: string, checksum: Buffer) => {
    this.files.delete(this.fileKey(linkId, checksum));
    return Promise.resolve();
  };

  savePendingPerson = (linkId: string, userId: string, remoteId: string, name: string, faces: HouseholdFaceBox[]) => {
    this.pending.set(`${linkId}:${userId}:${remoteId}`, { linkId, userId, remoteId, name, faces });
    return Promise.resolve();
  };
  deletePendingPerson = (linkId: string, userId: string, remoteId: string) => {
    this.pending.delete(`${linkId}:${userId}:${remoteId}`);
    return Promise.resolve();
  };
  getPendingPeople = (linkId: string) =>
    Promise.resolve(
      this.pending
        .values()
        .filter((row) => row.linkId === linkId)
        .toArray(),
    );
  countPendingPeople = (linkId: string, userId: string) =>
    Promise.resolve(
      this.pending
        .values()
        .filter((row) => row.linkId === linkId && row.userId === userId)
        .toArray().length,
    );
  getLocalFaces = (linkId: string, userId: string, remoteIds: string[]) =>
    Promise.resolve(
      this.faces.filter(
        (face) =>
          remoteIds.includes(face.remoteAssetId) &&
          this.origins.some(
            (o) =>
              o.linkId === linkId &&
              o.userId === userId &&
              o.kind === 'asset' &&
              o.isCopy &&
              o.remoteId === face.remoteAssetId,
          ),
      ),
    );
  facesDone = (_linkId: string, _userId: string, remoteIds: string[]) =>
    Promise.resolve(remoteIds.every((id) => this.recognized.has(id)));
  createPerson = (ownerId: string, name: string) => {
    const id = randomUUID();
    this.library!.people.set(id, { ownerId, personGroupId: id, name });
    return Promise.resolve(id);
  };
  setAssetDates = (_tx: unknown, id: string, fileCreatedAt: Date, localDateTime: Date) => {
    Object.assign(this.library!.assets.get(id)!, { fileCreatedAt, localDateTime });
    return Promise.resolve();
  };
}

type LibraryAsset = {
  id: string;
  ownerId: string;
  checksum: Buffer;
  originalPath: string;
  type: AssetType;
  visibility: string;
  deletedAt: Date | null;
  livePhotoVideoId: string | null;
  exif: Row;
  fileCreatedAt?: Date;
  localDateTime?: Date;
};

/** The recipient's library: what the upload path, the asset and album repositories would hold. */
export class ReceiverLibrary {
  assets = new Map<string, LibraryAsset>();
  albums = new Map<
    string,
    { id: string; albumName: string; description: string; ownerId: string; items: Set<string> }
  >();
  people = new Map<string, { ownerId: string; personGroupId: string; name: string }>();
  users = new Map<string, Row>();
  uploads: Array<{ name: string; publication: unknown }> = [];

  addUser(id: string, quotaSizeInBytes: number | null = null) {
    this.users.set(id, {
      id,
      name: id,
      email: `${id}@x.test`,
      isAdmin: false,
      quotaSizeInBytes,
      quotaUsageInBytes: 0,
      uploadsPaused: false,
      clusterGroupId: id,
    });
  }

  /** The normal upload path, as far as this side depends on it: one row per owner and content. */
  assetMedia = {
    refuseDeletedByOwner: vi.fn(() => Promise.resolve()),
    uploadAsset: vi.fn(async (auth: any, dto: any, file: any, _sidecar: unknown, publication: any) => {
      this.uploads.push({ name: dto.filename, publication });
      const bytes = await readFile(file.originalPath);
      expect(bytes.length).toBe(file.size);
      const existing = this.assets.values().find((a) => a.ownerId === auth.user.id && a.checksum.equals(file.checksum));
      if (existing) {
        await unlink(file.originalPath);
        return { id: existing.id, status: AssetMediaStatus.DUPLICATE };
      }
      const asset: LibraryAsset = {
        id: randomUUID(),
        ownerId: auth.user.id,
        checksum: file.checksum,
        originalPath: file.originalPath,
        type: /\.(mov|mp4)$/i.test(dto.filename) ? AssetType.Video : AssetType.Image,
        visibility: 'timeline',
        deletedAt: null,
        livePhotoVideoId: null,
        exif: {},
      };
      await publication(() => {
        this.assets.set(asset.id, asset);
        return Promise.resolve(asset);
      });
      return { id: asset.id, status: AssetMediaStatus.CREATED };
    }),
  };
  assetRepo: Record<string, AnyMock> = {
    getById: (id: string) => Promise.resolve(this.assets.get(id)),
    upsertExif: ({ exif }: { exif: Row }) => {
      const { assetId, lockedProperties: _locked, ...values } = exif;
      Object.assign(this.assets.get(assetId as string)!.exif, values);
      return Promise.resolve();
    },
    update: ({ id, ...change }: Row) => {
      Object.assign(this.assets.get(id as string)!, change);
      return Promise.resolve();
    },
    // no protocol path may reach these (T19)
    remove: vi.fn<AnyMock>(),
    updateAll: vi.fn<AnyMock>(),
  };
  albumRepo = {
    getById: (id: string) => Promise.resolve(this.albums.get(id)),
    create: (album: Row, _ids: string[], users: Array<{ userId: string }>) => {
      const row = {
        id: randomUUID(),
        albumName: album.albumName,
        description: album.description,
        ownerId: users[0].userId,
        items: new Set<string>(),
      };
      this.albums.set(row.id, row);
      return Promise.resolve(row);
    },
    addAssetIds: (id: string, ids: string[]) => {
      for (const assetId of ids) this.albums.get(id)?.items.add(assetId);
      return Promise.resolve();
    },
    removeAssetIds: (id: string, ids: string[]) => {
      for (const assetId of ids) this.albums.get(id)?.items.delete(assetId);
      return Promise.resolve();
    },
  };
  peopleRepo: Record<string, AnyMock> = {
    getByGroupId: ({ personGroupId }: { personGroupId: string }) => Promise.resolve(this.people.get(personGroupId)),
    update: ({ personGroupId, ...change }: Row) => {
      Object.assign(this.people.get(personGroupId as string)!, change);
      return Promise.resolve();
    },
    withMergeWrite: <T>(write: () => Promise<T>) => write(),
    reassignFaces: vi.fn(({ faceIds, newPersonGroupId }: { faceIds: string[]; newPersonGroupId: string }) => {
      for (const face of this.faceRows()) {
        if (faceIds.includes(face.id) && !face.personGroupId && !face.correctedAt)
          face.personGroupId = newPersonGroupId;
      }
      return Promise.resolve(faceIds.length);
    }),
    recordFaceCorrections: vi.fn(() => Promise.resolve([])),
    getFaceEmbedding: vi.fn((id: string) => Promise.resolve(`embedding-${id}`)),
    selectionForThumbnails: () => {
      const query = { where: () => query, execute: () => Promise.resolve([]) };
      return query;
    },
  };
  search = { searchFaces: vi.fn(() => Promise.resolve([] as Array<{ personGroupId: string }>)) };
  faceRows: () => HouseholdLocalFace[] = () => [];
}

/** The receiving service on `server`, over the in-memory stores, with the real client, keys and hashing. */
export const startReceiver = (server: HouseholdServer) => {
  const receive = new MemoryReceive();
  const library = new ReceiverLibrary();
  receive.library = library;
  library.faceRows = () => receive.faces;
  const notifications = {
    findRecentByDedupeKey: vi.fn((userId: string, key: string) =>
      Promise.resolve(sent.find((row) => row.userId === userId && (row.data as Row).dedupeKey === key) ?? null),
    ),
    create: vi.fn((row: Row) => {
      const item = { id: randomUUID(), createdAt: new Date(), readAt: null, ...row };
      sent.push(item);
      return Promise.resolve(item);
    }),
  };
  const sent: Row[] = [];
  const storage = {
    mkdirSync: (path: string) => void mkdirSync(path, { recursive: true }),
    mkdir,
    rename,
    stat,
    copyFile,
    unlink: (path: string) => unlink(path),
  };
  const jobs = {
    getQueueHolds: vi.fn(() => Promise.resolve([] as Array<{ closedUntil: Date | null }>)),
    queueAll: vi.fn<AnyMock>(),
  };
  const comments = server.world.comments;
  comments.inbound = receive as never;
  const events = { emit: vi.fn((_name: string, _payload: unknown) => Promise.resolve()) };
  const service = new HouseholdReceiveService(
    receive as never,
    server.links as never,
    server.service,
    library.assetMedia as never,
    library.assetRepo as never,
    library.albumRepo as never,
    { get: (id: string) => Promise.resolve(library.users.get(id)) } as never,
    library.peopleRepo as never,
    library.search as never,
    jobs as never,
    notifications as never,
    { clientSend: vi.fn<AnyMock>() } as never,
    events as never,
    storage as never,
    new CryptoRepository(),
    { getEnv: () => ({}) } as never,
    {} as never,
    server.logger as never,
    comments as never,
  );
  return { service, receive, library, notifications, sent, jobs, comments, events };
};
