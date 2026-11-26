import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Insertable, Selectable } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { HouseholdInboundShareDto } from 'src/dtos/household-receive.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type {
  HouseholdInboundShare,
  HouseholdLocalFace,
  HouseholdOrigin,
  HouseholdOriginKey,
} from 'src/repositories/household-receive.repository.js';
import type { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import type { HouseholdLinkTable } from 'src/schema/tables/household-link.table.js';
import type { HouseholdFaceBox } from 'src/schema/tables/household-receive.table.js';
import type { HouseholdClient } from 'src/utils/household-client.js';
import type {
  HouseholdManifestAsset,
  HouseholdManifestComment,
  HouseholdManifestEntry,
} from 'src/utils/household-manifest.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import {
  AlbumKind,
  AlbumUserRole,
  AssetType,
  AssetVisibility,
  FrameleafWorker,
  JobName,
  NotificationLevel,
  NotificationType,
  StorageFolder,
} from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { HouseholdCommentRepository } from 'src/repositories/household-comment.repository.js';
import { HouseholdLinkRepository } from 'src/repositories/household-link.repository.js';
import { HouseholdReceiveRepository } from 'src/repositories/household-receive.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { AssetOriginField } from 'src/repositories/partner-origin.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { HouseholdLinkService } from 'src/services/household-link.service.js';
import { getConfig } from 'src/utils/config.js';
import { HouseholdKeyChanged, HouseholdPeerError } from 'src/utils/household-client.js';
import {
  HouseholdBadPage,
  HouseholdCommentReply,
  HouseholdHandshake,
  HouseholdOffered,
  cleanHouseholdLine,
  parseHouseholdPage,
} from 'src/utils/household-manifest.js';
import { HOUSEHOLD_MAX_ORIGINAL_BYTES } from 'src/utils/household-protocol.js';
import { mimeTypes } from 'src/utils/mime-types.js';

type Link = Selectable<HouseholdLinkTable>;
type Pull = {
  link: Link;
  share: HouseholdInboundShare;
  albumId: string;
  auth: AuthDto;
  client: HouseholdClient;
  cap: number;
  signal: AbortSignal;
  /** The last item this pull refused, reported in the share's status. */
  refusal?: string;
  /** Comment rows this share holds, read once per pull. */
  commentCount?: number;
  /** Mention notifications raised by this pull. */
  mentions: number;
};

const TICK_MS = 60_000;
const POLL_EVERY_MS = 15 * 60_000;
const PULL_EVERY_MS = 15 * 60_000;
const OVER_QUOTA_RETRY_MS = 60 * 60_000;
const MAX_BACKOFF_MS = 24 * 60 * 60_000;
const LEASE_MS = 2 * 60_000;
const RECONCILE_EVERY_MS = 7 * 24 * 60 * 60_000;
/** A peer answering 410 over and over cannot make this server read the whole feed more often than this. */
const MIN_RECONCILE_GAP_MS = 60 * 60_000;
const PAGES_PER_PULL = 50;
const TOKEN_MARGIN_MS = 60_000;
const TOKEN_REFRESHES = 3;
/** A download must keep moving: at least this much per window, and it cannot run past the deadline. */
const STALL_WINDOW_MS = 60_000;
const STALL_MIN_BYTES = 1024 * 1024;
const DOWNLOAD_DEADLINE_MS = 24 * 60 * 60_000;
const INVITE_NOTICE_MS = 24 * 60 * 60_000;
const BOX_OVERLAP = 0.5;
/** People waiting for local face detection, per account and link: a peer cannot grow this table without end. */
const MAX_PENDING_PEOPLE = 500;
/** Comments kept per inbound share: another server cannot grow this database without end. */
const MAX_COMMENTS_PER_SHARE = 50_000;
/** Mention notifications per pull: a peer cannot flood someone's notifications. */
const MAX_MENTIONS_PER_PULL = 10;
const COMMENTS_PER_TICK = 50;
const COMMENT_RETRY_MS = 60_000;
const COMMENT_RETRY_MAX_MS = 60 * 60_000;
/** A 403 can be a link paused for a moment, so it is believed only after this many tries (about an hour). */
const COMMENT_REFUSALS = 6;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const RUN_ORIGIN = { origin: 'import', label: 'Linked household' } as const;

/** This item is refused for good: the pull reports it and moves on. */
class ItemRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
class PullPaused extends Error {
  constructor(readonly code: 'over-quota' | 'uploads-paused') {
    super(code);
  }
}
class TokenExpired extends Error {}

const overlap = (a: HouseholdFaceBox | HouseholdLocalFace, b: HouseholdFaceBox | HouseholdLocalFace) => {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
    return 0;
  }
  const box = (face: typeof a) => ({
    x1: face.x1 / face.width,
    y1: face.y1 / face.height,
    x2: face.x2 / face.width,
    y2: face.y2 / face.height,
  });
  const [p, q] = [box(a), box(b)];
  const w = Math.min(p.x2, q.x2) - Math.max(p.x1, q.x1);
  const h = Math.min(p.y2, q.y2) - Math.max(p.y1, q.y1);
  if (w <= 0 || h <= 0 || p.x2 <= p.x1 || p.y2 <= p.y1 || q.x2 <= q.x1 || q.y2 <= q.y1) {
    return 0;
  }
  const shared = w * h;
  return shared / ((p.x2 - p.x1) * (p.y2 - p.y1) + (q.x2 - q.x1) * (q.y2 - q.y1) - shared);
};

/** Each listed box takes the local face it overlaps most, and each local face is taken once. */
const matchFaces = (boxes: HouseholdFaceBox[], local: HouseholdLocalFace[]) => {
  const taken = new Set<string>();
  const matched: HouseholdLocalFace[] = [];
  for (const box of boxes) {
    let best: HouseholdLocalFace | undefined;
    let score = BOX_OVERLAP;
    for (const face of local) {
      if (face.remoteAssetId === box.assetId && !taken.has(face.id)) {
        const value = overlap(box, face);
        if (value >= score) {
          best = face;
          score = value;
        }
      }
    }
    if (best) {
      taken.add(best.id);
      matched.push(best);
    }
  }
  return matched;
};

/**
 * Linked Households (FL-994), the receiving side. Accounts invited from another household get a local space with
 * their own copies, which follow the sender until they edit them and stay for good afterwards.
 *
 * Everything arriving is from a server owned by another family: replies are parsed strictly before anything is
 * written, a file is only ever made from bytes downloaded over this link and verified, and nothing in the protocol
 * deletes or trashes anything here. A timer on the microservices worker runs it (the Buddy pattern, no queue job).
 */
@Injectable()
export class HouseholdReceiveService {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  private stopping = new AbortController();
  private polledAt = new Map<string, number>();

  constructor(
    private receive: HouseholdReceiveRepository,
    private links: HouseholdLinkRepository,
    private linkService: HouseholdLinkService,
    private assetMedia: AssetMediaService,
    private assets: AssetRepository,
    private albums: AlbumRepository,
    private users: UserRepository,
    private people: PersonRepository,
    private search: SearchRepository,
    private jobs: JobRepository,
    private notifications: NotificationRepository,
    private websocket: WebsocketRepository,
    private events: EventRepository,
    private storage: StorageRepository,
    private crypto: CryptoRepository,
    private configRepo: ConfigRepository,
    private metadataRepo: SystemMetadataRepository,
    private logger: LoggingRepository,
    private comments: HouseholdCommentRepository,
  ) {
    this.logger.setContext(HouseholdReceiveService.name);
  }

  /* ------------------------------------- the timer ------------------------------------- */

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopped = true;
    this.stopping.abort();
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.active;
  }

  tick() {
    if (this.active || this.stopped) {
      return;
    }
    this.active = this.run()
      .catch((error) => this.logger.warn(`Household shares could not be checked: ${error}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  async run() {
    const quiet = (await this.jobs.getQueueHolds()).some(({ closedUntil }) => !!closedUntil);
    // Each household runs on its own, so one that trickles a download cannot hold up the others.
    // ponytail: at most 10 links run at once (Cloud's cap); a share within a link still waits its turn.
    await Promise.all((await this.links.getAll()).map((link) => this.runLink(link, quiet)));
  }

  private async runLink(link: Link, quiet: boolean) {
    if (this.stopped) {
      return;
    }
    try {
      if (link.state === 'ended') {
        await this.endLink(link);
      } else if (link.state === 'active') {
        await this.flushComments(link);
        const poked = !!link.pollRequestedAt;
        // the list is read before any pull, so someone removed from a share gets nothing more; a failed read
        // throws, and nothing is pulled for this link until the sender says who is still a member
        const due = quiet ? [] : await this.receive.getDue(link.id);
        if (poked || due.length > 0 || Date.now() - (this.polledAt.get(link.id) ?? 0) >= POLL_EVERY_MS) {
          await this.poll(link);
        }
        if (!quiet) {
          await this.pullDue(link);
        }
      }
    } catch (error) {
      // one household's failure never holds up another's
      this.logger.warn(`Household link ${link.id} could not be read: ${error}`);
    }
  }

  private async endLink(link: Link) {
    for (const share of await this.receive.getSharesOfLink(link.id)) {
      if (share.state !== 'left') {
        await this.markLeft(share);
      }
    }
  }

  private async pullDue(link: Link) {
    for (const share of await this.receive.getDue(link.id)) {
      if (this.stopped) {
        return;
      }
      await this.pull(link, share);
    }
  }

  /* --------------------------------------- poll --------------------------------------- */

  /**
   * Who on this server was invited to what. The signed list is the only thing that decides a removal: the sender
   * can only enforce it per household, so a person it no longer lists stops receiving here, person by person.
   */
  async poll(link: Link) {
    this.polledAt.set(link.id, Date.now());
    const poked = !!link.pollRequestedAt;
    if (poked) {
      await this.links.update(link.id, { pollRequestedAt: null });
    }
    const client = this.linkService.peerClient(link);
    const parsed = HouseholdOffered.safeParse(await client.get('shares'));
    if (!parsed.success) {
      throw new HouseholdBadPage(`Household link ${link.id} sent a share list that breaks the protocol`);
    }
    const offered = parsed.data;
    const rows = await this.receive.getSharesOfLink(link.id);
    const named = offered.flatMap(({ members }) => members.map(({ remoteUserId }) => remoteUserId));
    const active = await this.receive.getActiveUserIds([...new Set([...named, ...rows.map(({ userId }) => userId)])]);

    for (const row of rows) {
      const share = offered.find(({ id }) => id === row.remoteShareId);
      const member = share?.members.find(({ remoteUserId }) => remoteUserId === row.userId);
      if (row.state !== 'left' && !active.has(row.userId)) {
        // the account is going away: it leaves before its data does
        await this.markLeft(row);
        await this.tellLeft(link, row);
        continue;
      }
      if (row.leaveUnsent) {
        await this.tellLeft(link, row);
        continue;
      }
      if (row.state !== 'left' && (!member || member.state === 'left')) {
        await this.markLeft(row);
        continue;
      }
      if (share && member?.state === 'invited' && active.has(row.userId)) {
        // invited again: asked again, never carried on silently from an earlier acceptance
        if (row.state === 'accepted') {
          await this.markLeft(row);
        }
        if (row.state !== 'invited') {
          const invited = await this.receive.updateShare(row.id, {
            state: 'invited',
            spaceName: cleanHouseholdLine(share.name) || 'Shared space',
            ownerName: cleanHouseholdLine(share.ownerName, 100),
            lastError: null,
          });
          if (invited) {
            await this.notifyInvited(link, invited);
          }
        }
      }
    }

    const known = new Set(rows.map((row) => `${row.remoteShareId}:${row.userId}`));
    for (const share of offered) {
      for (const member of share.members) {
        // an id this server does not have is ignored silently: the sender learns nothing from it (T21)
        if (
          member.state === 'left' ||
          !active.has(member.remoteUserId) ||
          known.has(`${share.id}:${member.remoteUserId}`)
        ) {
          continue;
        }
        const created = await this.receive.createInvited({
          linkId: link.id,
          remoteShareId: share.id,
          userId: member.remoteUserId,
          spaceName: cleanHouseholdLine(share.name) || 'Shared space',
          ownerName: cleanHouseholdLine(share.ownerName, 100),
        });
        if (created) {
          await this.notifyInvited(link, created);
        }
      }
    }

    for (const pending of await this.receive.getPendingPeople(link.id)) {
      await this.resolvePerson(link.id, pending.userId, pending.remoteId, pending.name, pending.faces).catch((error) =>
        this.logger.warn(`A person from household link ${link.id} could not be matched yet: ${error}`),
      );
    }
    if (poked) {
      await this.receive.pullNow(link.id);
    }
  }

  private async notifyInvited(link: Link, share: HouseholdInboundShare) {
    const dedupeKey = `household-invite:${share.id}`;
    const since = new Date(Date.now() - INVITE_NOTICE_MS);
    // a peer re-inviting in a loop raises one notification a day at most
    if (await this.notifications.findRecentByDedupeKey(share.userId, dedupeKey, since)) {
      return;
    }
    const item = await this.notifications.create({
      userId: share.userId,
      type: NotificationType.Custom,
      level: NotificationLevel.Info,
      title: 'Shared space invitation',
      description: `${share.ownerName || link.householdName} in ${link.householdName} invited you to “${share.spaceName}”`,
      data: { kind: 'household-share-invite', inboundShareId: share.id, dedupeKey },
    });
    this.websocket.clientSend('on_notification', share.userId, mapNotification(item));
  }

  /** No longer receiving: nothing is deleted, and everything received stays with the recipient. */
  private async markLeft(share: HouseholdInboundShare) {
    await this.receive.updateShare(share.id, { state: 'left', nextPullAt: null, partialPath: null });
    await this.receive.leaveOrigins(share);
    if (share.partialPath) {
      await this.storage.unlink(share.partialPath).catch(() => {});
    }
  }

  private async tellLeft(link: Link, share: HouseholdInboundShare) {
    const path = `shares/${share.remoteShareId}/members/${share.userId}/leave`;
    try {
      await this.linkService.peerClient(link).post(path);
      await this.receive.updateShare(share.id, { leaveUnsent: false });
    } catch (error) {
      // a member the sender no longer has is already gone there
      const gone = error instanceof HouseholdPeerError && error.status === 403;
      await this.receive.updateShare(share.id, { leaveUnsent: !gone });
    }
  }

  /* ------------------------------------ the recipient ------------------------------------ */

  private async requireOwn(auth: AuthDto, id: string) {
    const share = await this.receive.getShare(id);
    if (share?.userId !== auth.user.id) {
      throw new NotFoundException('Household share not found');
    }
    return share;
  }

  async list(auth: AuthDto): Promise<HouseholdInboundShareDto[]> {
    const links = new Map((await this.links.getAll()).map((link) => [link.id, link]));
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    return (await this.receive.getSharesOfUser(auth.user.id)).map((share) => ({
      id: share.id,
      householdName: links.get(share.linkId)?.householdName ?? '',
      spaceName: share.spaceName,
      ownerName: share.ownerName,
      state: share.state,
      albumId: share.albumId,
      lastPulledAt: iso(share.lastPulledAt),
      lastError: share.lastError,
    }));
  }

  /** The sender is told first: if it cannot be reached, nothing changes here and the person can try again. */
  async accept(auth: AuthDto, id: string): Promise<HouseholdInboundShareDto> {
    const share = await this.requireOwn(auth, id);
    if (share.state !== 'invited') {
      throw new BadRequestException('This invitation is no longer open');
    }
    const link = await this.links.get(share.linkId);
    if (link?.state !== 'active') {
      throw new BadRequestException('That household link is not active');
    }
    await this.linkService.peerClient(link).post(`shares/${share.remoteShareId}/members/${auth.user.id}/accept`);
    const kept = share.albumId
      ? await this.albums.getById(share.albumId, { withAssets: false }, auth.user.id)
      : undefined;
    const albumId =
      kept?.id ??
      (
        await this.albums.create(
          {
            albumName: share.spaceName,
            description: `From ${link.householdName}`,
            kind: AlbumKind.Space,
          },
          [],
          [{ userId: auth.user.id, role: AlbumUserRole.Owner }],
          auth.user.id,
        )
      ).id;
    const accepted = await this.receive.updateShare(share.id, {
      state: 'accepted',
      albumId,
      nextPullAt: null,
      failures: 0,
      lastError: null,
    });
    return {
      id: share.id,
      householdName: link.householdName,
      spaceName: share.spaceName,
      ownerName: share.ownerName,
      state: accepted?.state ?? 'accepted',
      albumId,
      lastPulledAt: null,
      lastError: null,
    };
  }

  /** Declining, or leaving later. What was received stays; the next poll retries telling an unreachable sender. */
  async decline(auth: AuthDto, id: string): Promise<void> {
    const share = await this.requireOwn(auth, id);
    if (share.state === 'left') {
      return;
    }
    await this.markLeft(share);
    const link = await this.links.get(share.linkId);
    if (link?.state === 'ended' || !link) {
      return;
    }
    await this.tellLeft(link, share);
  }

  private async authFor(userId: string): Promise<AuthDto | undefined> {
    const user = await this.users.get(userId, { withDeleted: false });
    if (!user) {
      return;
    }
    return {
      user: {
        id: user.id,
        isAdmin: user.isAdmin,
        name: user.name,
        email: user.email,
        quotaUsageInBytes: user.quotaUsageInBytes,
        quotaSizeInBytes: user.quotaSizeInBytes,
        uploadsPaused: user.uploadsPaused,
      },
      // not elevated: a Locked item with the same bytes stays out of reach, and is never added to a space
      session: { id: randomUUID(), hasElevatedPermission: false },
    };
  }

  /* --------------------------------------- pull --------------------------------------- */

  async pull(link: Link, share: HouseholdInboundShare) {
    if (!(await this.receive.claimPull(share.id, LEASE_MS))) {
      return;
    }
    const heartbeat = setInterval(() => {
      void this.receive.renewPull(share.id, LEASE_MS).catch(() => {});
    }, LEASE_MS / 3);
    try {
      await this.runPull(link, share);
    } finally {
      clearInterval(heartbeat);
      await this.receive.updateShare(share.id, { pullingUntil: null });
    }
  }

  private async fail(share: HouseholdInboundShare, code: string) {
    const failures = share.failures + 1;
    const wait = Math.min(PULL_EVERY_MS * 2 ** Math.min(failures - 1, 8), MAX_BACKOFF_MS);
    await this.receive.updateShare(share.id, {
      lastError: code,
      failures,
      nextPullAt: new Date(Date.now() + wait),
    });
  }

  private async runPull(link: Link, share: HouseholdInboundShare) {
    const album = share.albumId ? await this.albums.getById(share.albumId, { withAssets: false }) : undefined;
    const auth = await this.authFor(share.userId);
    if (!album || !auth) {
      // the recipient deleted the space, or the account is going
      await this.markLeft(share);
      await this.tellLeft(link, share);
      return;
    }

    const client = this.linkService.peerClient(link);
    let cursor = share.cursor;
    let reconcileStartedAt = share.reconcileStartedAt ? new Date(share.reconcileStartedAt as unknown as string) : null;
    const reconciledAt = share.lastReconciledAt ? new Date(share.lastReconciledAt as unknown as string).getTime() : 0;
    if (!reconcileStartedAt && reconciledAt > 0 && Date.now() - reconciledAt >= RECONCILE_EVERY_MS) {
      reconcileStartedAt = new Date();
      cursor = 0;
      await this.receive.updateShare(share.id, { cursor, reconcileStartedAt });
    }

    try {
      const { maxOriginalBytes } = HouseholdHandshake.parse(await client.get('handshake'));
      const pull: Pull = {
        link,
        share,
        albumId: album.id,
        auth,
        client,
        cap: Math.min(maxOriginalBytes, HOUSEHOLD_MAX_ORIGINAL_BYTES),
        signal: this.stopping.signal,
        mentions: 0,
      };
      let complete = false;
      let refreshes = 0;
      for (let pages = 0; pages < PAGES_PER_PULL && !complete;) {
        const data = await client.get(
          `shares/${share.remoteShareId}/manifest`,
          cursor > 0 ? { cursor: String(cursor) } : undefined,
        );
        const page = parseHouseholdPage(data, share.remoteShareId, cursor);
        try {
          for (const entry of page.entries) {
            if ((await this.receive.getShare(share.id))?.state !== 'accepted' || this.stopped) {
              return;
            }
            await this.applyEntry(pull, entry);
          }
        } catch (error) {
          // the page's download tokens ran out while earlier items downloaded: read the same page again
          if (error instanceof TokenExpired && ++refreshes <= TOKEN_REFRESHES) {
            continue;
          }
          throw error;
        }
        refreshes = 0;
        pages++;
        cursor = page.nextCursor;
        complete = page.complete;
        await this.receive.updateShare(share.id, { cursor });
      }

      const now = new Date();
      if (complete && reconcileStartedAt) {
        await this.receive.stopUnseen(share, reconcileStartedAt);
      }
      await this.receive.updateShare(share.id, {
        lastPulledAt: now,
        lastError: pull.refusal ?? null,
        failures: 0,
        // a long feed carries on at the next tick
        nextPullAt: complete ? new Date(now.getTime() + PULL_EVERY_MS) : null,
        ...(complete && { reconcileStartedAt: null, lastReconciledAt: now }),
      });
    } catch (error) {
      if (error instanceof PullPaused) {
        // nothing is dropped: the cursor stays and the pull tries again later
        await this.receive.updateShare(share.id, {
          lastError: error.code,
          nextPullAt: new Date(Date.now() + OVER_QUOTA_RETRY_MS),
        });
      } else if (error instanceof HouseholdBadPage) {
        this.logger.warn(`Household share ${share.id}: refused a page: ${error.message}`);
        await this.fail(share, 'bad-page');
      } else if (error instanceof HouseholdPeerError && error.status === 410) {
        // the sender's database went back in time: read from the start, then stop following what is gone
        if (Date.now() - reconciledAt < MIN_RECONCILE_GAP_MS) {
          await this.fail(share, 'peer-restored');
        } else {
          await this.receive.updateShare(share.id, { cursor: 0, reconcileStartedAt: new Date(), nextPullAt: null });
        }
      } else {
        this.logger.warn(`Household share ${share.id} could not be pulled: ${error}`);
        await this.fail(share, 'unreachable');
      }
    }
  }

  private async applyEntry(pull: Pull, entry: HouseholdManifestEntry) {
    if (entry.kind === 'comment') {
      await this.applyComment(pull, entry);
      return;
    }
    if (entry.kind !== 'asset' && entry.kind !== 'person') {
      return;
    }
    const key: HouseholdOriginKey = {
      linkId: pull.link.id,
      remoteId: entry.id,
      kind: entry.kind,
      userId: pull.share.userId,
    };
    if ('stop' in entry) {
      // stop means stop following, and nothing else, ever
      await this.receive.stopFollowing(key);
      if (entry.kind === 'person') {
        await this.receive.deletePendingPerson(pull.link.id, pull.share.userId, entry.id);
      }
      return;
    }
    if ('person' in entry) {
      await this.applyPerson(pull, key, entry.person.name, entry.person.faces);
      return;
    }
    try {
      await this.applyAsset(pull, key, entry.asset);
    } catch (error) {
      if (!(error instanceof ItemRefused)) {
        throw error;
      }
      pull.refusal = error.code;
      this.logger.warn(`Household share ${pull.share.id}: refused item ${entry.id} (${error.code})`);
    }
  }

  private async applyAsset(pull: Pull, key: HouseholdOriginKey, asset: HouseholdManifestAsset) {
    const origin = await this.receive.getOrigin(key);
    if (!origin) {
      await this.ingest(pull, key, asset);
      return;
    }
    await this.receive.markSeen(key);
    // the origin row outlives a copy the recipient deleted: that copy is never made again
    const local = await this.assets.getById(origin.localId);
    if (!origin.shareIds.includes(pull.share.id)) {
      await this.receive.addOriginShare(key, pull.share.id);
      if (local && !local.deletedAt) {
        await this.albums.addAssetIds(pull.albumId, [local.id]);
      }
    }
    if (local && origin.isCopy && origin.followUntilEdited) {
      await this.applyFields(key, local.id, asset);
    }
    await this.pairLive(pull, key, asset);
  }

  /** Each followed field, unless the recipient made it their own. Runs holding the origin row. */
  private async applyFields(key: HouseholdOriginKey, localId: string, asset: HouseholdManifestAsset) {
    await this.receive.withFollowingOrigin(key, async (origin, tx) => {
      if (!origin.isCopy) {
        return;
      }
      const own = new Set(origin.overriddenFields);
      const exif: Insertable<AssetExifTable> = { assetId: localId };
      const locked: string[] = [];
      if (!own.has(AssetOriginField.Description)) {
        exif.description = asset.description;
        locked.push('description');
      }
      if (!own.has(AssetOriginField.Rating)) {
        exif.rating = asset.rating;
        locked.push('rating');
      }
      if (!own.has(AssetOriginField.Location)) {
        Object.assign(exif, {
          latitude: asset.latitude,
          longitude: asset.longitude,
          city: asset.city,
          state: asset.state,
          country: asset.country,
        });
        locked.push('latitude', 'longitude', 'city', 'state', 'country');
      }
      const dated = !own.has(AssetOriginField.DateTimeOriginal);
      if (dated) {
        exif.dateTimeOriginal = new Date(asset.fileCreatedAt);
        exif.timeZone = asset.timeZone;
        locked.push('dateTimeOriginal', 'timeZone');
      }
      if (locked.length > 0) {
        // locked, so the local metadata read of the file does not put the file's own values back
        exif.lockedProperties = locked as never;
        await this.assets.upsertExif({ exif, lockedPropertiesBehavior: 'append' }, tx);
      }
      if (dated) {
        await this.receive.setAssetDates(tx, localId, new Date(asset.fileCreatedAt), new Date(asset.localDateTime));
      }
    });
    await this.receive.updateOrigin(key, { remoteUpdatedAt: new Date(asset.updatedAt) });
  }

  /* ------------------------------------- new items ------------------------------------- */

  private requireRoom(pull: Pull, size: number) {
    const { quotaSizeInBytes, quotaUsageInBytes, uploadsPaused } = pull.auth.user;
    if (uploadsPaused) {
      throw new PullPaused('uploads-paused');
    }
    if (quotaSizeInBytes !== null && quotaSizeInBytes < quotaUsageInBytes + size) {
      throw new PullPaused('over-quota');
    }
  }

  /**
   * T12: the local library is never searched by a checksum a peer named. The bytes come from this link and are
   * verified; only then does the normal upload path store them, and universal storage deduplicates afterwards.
   */
  private async ingest(pull: Pull, key: HouseholdOriginKey, asset: HouseholdManifestAsset) {
    const name = asset.originalFileName;
    const type = asset.type === 'IMAGE' ? AssetType.Image : asset.type === 'VIDEO' ? AssetType.Video : undefined;
    if (!type || !mimeTypes.isAsset(name) || mimeTypes.assetType(name) !== type) {
      throw new ItemRefused('unsupported-type');
    }
    if (asset.size !== null && asset.size > pull.cap) {
      throw new ItemRefused('file-too-large');
    }
    this.requireRoom(pull, asset.size ?? 0);
    const checksum = Buffer.from(asset.checksum, 'hex');
    try {
      await this.assetMedia.refuseDeletedByOwner(pull.auth, [checksum]);
    } catch (error) {
      if (error instanceof ConflictException) {
        return; // the recipient deleted these bytes and asked not to get them back
      }
      throw error;
    }

    const part = StorageCore.getNestedPath(
      StorageFolder.Upload,
      pull.share.userId,
      `household-${pull.link.id}-${asset.checksum}.part`,
    );
    this.storage.mkdirSync(dirname(part));
    const digest =
      (await this.fromReceived(pull, asset, checksum, part)) ?? (await this.download(pull, asset, checksum, part));
    if (digest.size > pull.cap) {
      await this.removePart(pull, part);
      throw new ItemRefused('file-too-large');
    }
    try {
      this.requireRoom(pull, digest.size);
    } catch (error) {
      await this.removePart(pull, part);
      throw error;
    }

    const destination = StorageCore.getNestedPath(
      StorageFolder.Upload,
      pull.share.userId,
      `${randomUUID()}${mimeTypes.uploadExtension(name).toLowerCase()}`,
    );
    this.storage.mkdirSync(dirname(destination));
    await this.storage.rename(part, destination);
    if (pull.share.partialPath) {
      pull.share.partialPath = null;
    }
    await this.receive.updateShare(pull.share.id, { partialPath: null });

    const takenAt = new Date(asset.fileCreatedAt);
    let response;
    try {
      // the guarded path: unlike a plain upload it never brings a matching photo back from the recipient's Trash
      response = await this.assetMedia.uploadAsset(
        pull.auth,
        { filename: name, fileCreatedAt: takenAt, fileModifiedAt: takenAt },
        {
          uuid: randomUUID(),
          checksum: digest.sha256,
          legacyChecksum: digest.sha1,
          originalPath: destination,
          originalName: name,
          size: digest.size,
        },
        undefined,
        (create) =>
          this.receive.publish(async (tx) => {
            const created = await create(tx, false);
            await this.receive.createOrigin(
              {
                ...key,
                localId: created.id,
                isCopy: true,
                shareIds: [pull.share.id],
                pairedRemoteId: asset.livePhotoVideoId,
              },
              tx,
            );
            return created;
          }),
        RUN_ORIGIN,
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new ItemRefused('unsupported-type');
      }
      throw error;
    }

    if (response.status === AssetMediaStatus.CREATED) {
      pull.auth.user.quotaUsageInBytes += digest.size;
      const stored = await this.assets.getById(response.id);
      if (stored) {
        await this.receive.saveReceivedFile(pull.link.id, checksum, stored.originalPath, digest.size);
      }
      await this.applyFields(key, response.id, asset);
      await this.albums.addAssetIds(pull.albumId, [response.id]);
      await this.pairLive(pull, key, asset);
      return;
    }

    // The recipient already holds these bytes. Their item is theirs: it is placed in the space and never written to.
    if (response.id === NIL_UUID) {
      return; // Locked or hidden from this session: it stays out of the space
    }
    await this.receive.createOrigin({
      ...key,
      localId: response.id,
      isCopy: false,
      followUntilEdited: false,
      shareIds: [pull.share.id],
    });
    const existing = await this.assets.getById(response.id);
    if (existing && !existing.deletedAt) {
      await this.albums.addAssetIds(pull.albumId, [existing.id]);
    }
  }

  /** A live photo's two parts arrive as separate entries, in either order; they pair once both are copies. */
  private async pairLive(pull: Pull, key: HouseholdOriginKey, asset: HouseholdManifestAsset) {
    const self = await this.receive.getOrigin(key);
    if (!self) {
      return;
    }
    if (asset.livePhotoVideoId && self.pairedRemoteId === asset.livePhotoVideoId) {
      const motion = await this.receive.getOrigin({ ...key, remoteId: asset.livePhotoVideoId });
      if (motion) {
        await this.pair(pull, key, self, motion);
      }
    }
    for (const still of await this.receive.getWaitingStills(key.linkId, key.userId, key.remoteId)) {
      await this.pair(pull, { ...key, remoteId: still.remoteId }, still, self);
    }
  }

  private async pair(pull: Pull, stillKey: HouseholdOriginKey, still: HouseholdOrigin, motion: HouseholdOrigin) {
    // only ever between two copies this link delivered: never the recipient's own photo or video
    if (!still.isCopy || !motion.isCopy) {
      return;
    }
    const [image, video] = await Promise.all([this.assets.getById(still.localId), this.assets.getById(motion.localId)]);
    if (
      !image ||
      !video ||
      image.ownerId !== pull.share.userId ||
      video.ownerId !== pull.share.userId ||
      image.type !== AssetType.Image ||
      video.type !== AssetType.Video ||
      image.livePhotoVideoId
    ) {
      return;
    }
    await this.assets.update({ id: image.id, livePhotoVideoId: video.id });
    await this.assets.update({ id: video.id, visibility: AssetVisibility.Hidden });
    await this.albums.removeAssetIds(pull.albumId, [video.id]);
    await this.receive.updateOrigin(stillKey, { pairedRemoteId: null });
    await this.events.emit('AssetHide', { assetId: video.id, userId: pull.share.userId });
  }

  /* ------------------------------------- downloads ------------------------------------- */

  private async verify(path: string, asset: HouseholdManifestAsset, checksum: Buffer) {
    const { sha1, sha256, sizeInBytes } = await this.crypto.hashFileDigests(path);
    const matches = (checksum.length === 20 ? sha1 : sha256).equals(checksum);
    return matches && sizeInBytes > 0 && (asset.size === null || asset.size === sizeInBytes)
      ? { sha1, sha256, size: sizeInBytes }
      : undefined;
  }

  private partSize(part: string) {
    return this.storage
      .stat(part)
      .then(({ size }) => size)
      .catch(() => 0);
  }

  private async removePart(pull: Pull, part: string) {
    await this.storage.unlink(part).catch(() => {});
    if (pull.share.partialPath === part) {
      pull.share.partialPath = null;
    }
    await this.receive.updateShare(pull.share.id, { partialPath: null });
  }

  /** A file an earlier recipient downloaded from this same link, re-verified, as it may have moved or been sealed. */
  private async fromReceived(pull: Pull, asset: HouseholdManifestAsset, checksum: Buffer, part: string) {
    const known = await this.receive.getReceivedFile(pull.link.id, checksum);
    if (!known) {
      return;
    }
    try {
      await this.storage.copyFile(known.path, part, constants.COPYFILE_FICLONE);
      const digest = await this.verify(part, asset, checksum);
      if (digest) {
        return digest;
      }
    } catch {
      // gone or moved: download it again
    }
    await this.storage.unlink(part).catch(() => {});
    await this.receive.deleteReceivedFile(pull.link.id, checksum);
  }

  /**
   * Streams an original to `part`, resuming with `Range`. At most the declared size (or the cap) is ever written;
   * a share keeps one partial file at most. A refusal removes it; an interruption keeps it for the next pull.
   */
  private async download(pull: Pull, asset: HouseholdManifestAsset, checksum: Buffer, part: string) {
    const { share } = pull;
    if (new Date(asset.download.expiresAt).getTime() - Date.now() < TOKEN_MARGIN_MS) {
      throw new TokenExpired();
    }
    if (share.partialPath && share.partialPath !== part) {
      await this.storage.unlink(share.partialPath).catch(() => {});
    }
    share.partialPath = part;
    await this.receive.updateShare(share.id, { partialPath: part });

    const limit = asset.size ?? pull.cap;
    let start = await this.partSize(part);
    if (start > limit) {
      await this.storage.unlink(part).catch(() => {});
      start = 0;
    }

    if (start < limit) {
      const refuse = async (code: string): Promise<never> => {
        await this.removePart(pull, part);
        throw new ItemRefused(code);
      };
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, pull.signal, AbortSignal.timeout(DOWNLOAD_DEADLINE_MS)]);
      let received = 0;
      let checkedAt = 0;
      const stall = setInterval(() => {
        if (received - checkedAt < STALL_MIN_BYTES) {
          controller.abort(new Error('The download stalled'));
        }
        checkedAt = received;
      }, STALL_WINDOW_MS);
      try {
        let response: Response;
        try {
          response = await pull.client.original(
            `shares/${share.remoteShareId}/originals/${asset.id}`,
            { token: asset.download.token },
            start,
            signal,
          );
        } catch (error) {
          if (error instanceof HouseholdPeerError && (error.status === 403 || error.status === 404)) {
            return await refuse('not-available'); // locked or removed meanwhile; the feed says so next
          }
          if (error instanceof HouseholdPeerError && error.status === 416) {
            await this.removePart(pull, part);
          }
          throw error;
        }
        if (response.status === 200) {
          start = 0; // the peer ignored the range
        } else if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
          if (
            !range ||
            Number(range[1]) !== start ||
            (range[3] !== '*' && asset.size !== null && Number(range[3]) !== asset.size)
          ) {
            await response.body?.cancel();
            return await refuse('bad-file');
          }
        } else {
          await response.body?.cancel();
          return await refuse('bad-file');
        }
        if (!response.body) {
          return await refuse('bad-file');
        }

        const tooLong = asset.size === null ? 'file-too-large' : 'bad-file';
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > limit - start) {
          await response.body.cancel();
          return await refuse(asset.size !== null && declared + start > pull.cap ? 'file-too-large' : tooLong);
        }
        let written = start;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            written += chunk.length;
            received += chunk.length;
            done(written > limit ? new ItemRefused(tooLong) : null, written > limit ? undefined : chunk);
          },
        });
        try {
          await pipeline(
            Readable.fromWeb(response.body as never),
            counter,
            createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }),
            { signal },
          );
        } catch (error) {
          if (error instanceof ItemRefused) {
            return await refuse(error.code);
          }
          throw error; // an interruption: the partial file stays for the next pull
        }
      } finally {
        clearInterval(stall);
      }
    }

    const digest = await this.verify(part, asset, checksum);
    if (!digest) {
      const size = await this.partSize(part);
      // ended early with what it had so far: resumed next time
      if (asset.size !== null && size < asset.size) {
        throw new HouseholdPeerError(502, 'The download ended early');
      }
      await this.removePart(pull, part);
      throw new ItemRefused('checksum-mismatch');
    }
    return digest;
  }

  /* -------------------------------------- comments -------------------------------------- */

  /**
   * A comment from the sender, on the recipient's own space. The manifest can name any author, so nothing it says
   * ever acts as a local account: every author is a name on a `household_remote_author` row, even one whose id is
   * an account here. What this server wrote itself is recognised by its id and never overwritten or removed.
   */
  private async applyComment(
    pull: Pull,
    entry: { id: string } & ({ stop: true } | { comment: HouseholdManifestComment }),
  ) {
    const shareId = pull.share.id;
    const known = await this.comments.getLink(shareId, entry.id);
    if ('stop' in entry) {
      // only the copy goes: never media, a reply written here, or the recipient's own words
      if (known && !known.own) {
        if (known.activityId) {
          await this.comments.deleteActivity(known.activityId);
        }
        await this.comments.deleteLink(shareId, entry.id);
      }
      return;
    }
    if (known?.own || (known && !known.activityId)) {
      return; // written here, or removed here by the recipient: it does not come back
    }

    const body = entry.comment;
    const name = cleanHouseholdLine(body.author.name, 100);
    const senderName = !name || name.includes('@') ? 'Member' : name;
    if (known) {
      const current = await this.comments.getActivity(known.activityId!);
      // a comment cannot turn into a like, or the reverse; an unchanged one is not written again
      if (current && body.comment !== null && !current.isLiked && current.comment !== body.comment) {
        await this.comments.updateText(current.id, body.comment);
        await this.notifyCommentMentions(pull, current.assetId, current.id, body.comment, senderName);
      }
      return;
    }

    pull.commentCount ??= await this.comments.countLinks(shareId);
    if (pull.commentCount >= MAX_COMMENTS_PER_SHARE) {
      pull.refusal = 'too-many-comments';
      return;
    }
    let assetId: string | null = null;
    if (body.assetId) {
      const local = await this.comments.getLocalAsset(pull.link.id, pull.share.userId, body.assetId, pull.albumId);
      if (!local) {
        return; // the item is not in this space (refused, or removed here); a full read tries again
      }
      assetId = local;
    }
    const remoteAuthorId = await this.comments.upsertAuthor(pull.link.id, body.author.id, senderName);
    const sentAt = new Date(body.createdAt);
    const created = await this.comments.createCopy(shareId, entry.id, {
      albumId: pull.albumId,
      assetId,
      remoteAuthorId,
      isLiked: body.isLiked,
      comment: body.comment,
      // a peer's clock cannot pin a comment to the end of the conversation
      createdAt: sentAt.getTime() > Date.now() ? new Date() : sentAt,
    });
    if (!created) {
      return; // this author already likes that
    }
    pull.commentCount++;
    await this.comments.addEvent(pull.albumId, created.id, body.isLiked);
    if (body.comment !== null) {
      await this.notifyCommentMentions(pull, assetId, created.id, body.comment, senderName);
    }
  }

  /** Each server tells only its own accounts, and only members of the local space. */
  private async notifyCommentMentions(
    pull: Pull,
    assetId: string | null,
    activityId: string,
    text: string,
    senderName: string,
  ) {
    const userIds = await this.comments.setMentions(activityId, pull.albumId, text);
    if (userIds.length > 0 && pull.mentions < MAX_MENTIONS_PER_PULL) {
      pull.mentions++;
      await this.events.emit('SharedSpaceMention', { id: pull.albumId, assetId, activityId, userIds, senderName });
    }
  }

  /** A comment written on a received space goes to the sender. It runs on any worker, so it only queues. */
  @OnEvent({ name: 'HouseholdFeedComments' })
  async onLocalComments({ albumId, activityIds, deleted }: ArgOf<'HouseholdFeedComments'>) {
    try {
      const share = await this.comments.getAcceptedShareOfAlbum(albumId);
      if (!share) {
        return;
      }
      for (const id of activityIds) {
        await this.queueComment(share, id, deleted);
      }
    } catch (error) {
      this.logger.warn(`A comment could not be queued for the other household: ${error}`);
    }
  }

  private async queueComment(share: HouseholdInboundShare, id: string, deleted: boolean) {
    const known = await this.comments.getLink(share.id, id);
    if (deleted) {
      if (known?.own) {
        await this.comments.queue(share.id, id, 'delete');
      }
      return;
    }
    if (known && !known.own) {
      return;
    }
    const activity = await this.comments.getActivity(id);
    // ponytail: only the invited account speaks to the sender; another local member's comment stays on this server
    if (activity?.userId !== share.userId) {
      return;
    }
    if (
      activity.assetId &&
      !(await this.comments.getRemoteAsset(share.linkId, share.userId, share.id, activity.assetId))
    ) {
      return; // an item the recipient added here: the sender has never heard of it
    }
    await this.comments.queue(share.id, id, known?.pending === 'post' || !known ? 'post' : 'put', id);
  }

  /** Sends what is queued, oldest first. A refusal is final; anything else is tried again with a backoff. */
  async flushComments(link: Link) {
    const client = this.linkService.peerClient(link);
    for (const row of await this.comments.getDue(link.id, COMMENTS_PER_TICK)) {
      if (this.stopped) {
        return;
      }
      try {
        await this.sendComment(client, row);
        await this.comments.markSent(row.inboundShareId, row.remoteId, row.revision);
      } catch (error) {
        const refused =
          error instanceof HouseholdPeerError &&
          !(error instanceof HouseholdKeyChanged) &&
          ([400, 404, 413, 415].includes(error.status) ||
            (error.status === 403 && row.attempts + 1 >= COMMENT_REFUSALS));
        if (refused) {
          // the comment stays here; the other side will not take it (member removed, item locked)
          this.logger.warn(`Household link ${link.id} refused comment ${row.remoteId} (${error.status})`);
          await this.comments.markSent(row.inboundShareId, row.remoteId, row.revision);
        } else {
          const wait = Math.min(COMMENT_RETRY_MS * 2 ** Math.min(row.attempts, 8), COMMENT_RETRY_MAX_MS);
          await this.comments.retryLater(
            row.inboundShareId,
            row.remoteId,
            row.attempts + 1,
            new Date(Date.now() + wait),
          );
          // the peer is not answering: one timeout per tick, so it cannot hold up the other households
          return;
        }
      }
    }
  }

  private async sendComment(
    client: HouseholdClient,
    row: Awaited<ReturnType<HouseholdCommentRepository['getDue']>>[number],
  ) {
    const route = `shares/${row.remoteShareId}/comments`;
    let reply: unknown;
    if (row.pending === 'delete') {
      reply = await client.send('DELETE', `${route}/${row.remoteId}`, { userId: row.userId });
    } else {
      const activity = row.activityId ? await this.comments.getActivity(row.activityId) : undefined;
      if (!activity) {
        return; // removed meanwhile: its delete is queued by the same change
      }
      if (row.pending === 'put') {
        reply = await client.send('PUT', `${route}/${row.remoteId}`, {
          userId: row.userId,
          comment: activity.comment,
        });
      } else {
        const assetId = activity.assetId
          ? await this.comments.getRemoteAsset(row.linkId, row.userId, row.inboundShareId, activity.assetId)
          : null;
        if (assetId === undefined) {
          return;
        }
        reply = await client.send('POST', route, {
          id: row.remoteId,
          userId: row.userId,
          assetId,
          isLiked: activity.isLiked,
          comment: activity.isLiked ? null : activity.comment,
        });
      }
    }
    const parsed = HouseholdCommentReply.safeParse(reply);
    if (!parsed.success || parsed.data.id !== row.remoteId) {
      throw new HouseholdPeerError(502, 'The other household sent a reply that breaks the protocol');
    }
  }

  /* --------------------------------------- people --------------------------------------- */

  private async applyPerson(pull: Pull, key: HouseholdOriginKey, rawName: string, faces: HouseholdFaceBox[]) {
    const origin = await this.receive.getOrigin(key);
    if (origin && !origin.followUntilEdited) {
      return;
    }
    const name = cleanHouseholdLine(rawName, 100);
    if (origin) {
      await this.receive.markSeen(key);
      if (!origin.shareIds.includes(pull.share.id)) {
        await this.receive.addOriginShare(key, pull.share.id);
      }
      if (origin.isCopy && !origin.overriddenFields.includes('name')) {
        const person = await this.people.getByGroupId({ ownerId: key.userId, personGroupId: origin.localId });
        if (person && person.name !== name) {
          await this.people.update({ ownerId: key.userId, personGroupId: origin.localId, name });
          await this.events.emit('PersonChanged', { ownerId: key.userId, personGroupId: origin.localId });
        }
      }
    }
    if ((await this.receive.countPendingPeople(key.linkId, key.userId)) >= MAX_PENDING_PEOPLE) {
      pull.refusal = 'too-many-people';
      return;
    }
    await this.receive.savePendingPerson(key.linkId, key.userId, key.remoteId, name, faces);
    await this.resolvePerson(key.linkId, key.userId, key.remoteId, name, faces, pull.share.id);
  }

  /**
   * Only names and boxes cross, and only on copies this link delivered. A face this account's recognition already
   * placed is never moved. Where it placed them on one of the recipient's people, the sender's person is that
   * person: the name is not touched, and a further face joins only within the recipient's own recognition
   * threshold, recorded in the correction history, which undoes it (T20). Otherwise a new person of theirs is made.
   */
  async resolvePerson(
    linkId: string,
    userId: string,
    remoteId: string,
    name: string,
    faces: HouseholdFaceBox[],
    shareId?: string,
  ) {
    const key: HouseholdOriginKey = { linkId, remoteId, kind: 'person', userId };
    const remoteAssets = [...new Set(faces.map(({ assetId }) => assetId))];
    const matched = matchFaces(faces, await this.receive.getLocalFaces(linkId, userId, remoteAssets));
    const undecided = matched.filter(({ personGroupId, correctedAt }) => !personGroupId && !correctedAt);
    let origin = await this.receive.getOrigin(key);
    if (origin && !origin.followUntilEdited) {
      await this.receive.deletePendingPerson(linkId, userId, remoteId);
      return;
    }

    if (!origin) {
      const counts = new Map<string, number>();
      for (const { personGroupId } of matched) {
        if (personGroupId) {
          counts.set(personGroupId, (counts.get(personGroupId) ?? 0) + 1);
        }
      }
      const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      let own: string | undefined;
      for (const [personGroupId] of ranked) {
        if (await this.people.getByGroupId({ ownerId: userId, personGroupId })) {
          own = personGroupId;
          break;
        }
      }
      if (own) {
        await this.receive.createOrigin({ ...key, localId: own, isCopy: false, shareIds: shareId ? [shareId] : [] });
      } else if (undecided.length > 0) {
        const localId = await this.receive.createPerson(userId, name);
        await this.receive.createOrigin({ ...key, localId, isCopy: true, shareIds: shareId ? [shareId] : [] });
      }
      origin = await this.receive.getOrigin(key);
    }

    if (origin && undecided.length > 0) {
      await this.placeFaces(origin, undecided);
    }
    // ponytail: boxes wait until local detection has run on every item they name; a face found later is not re-read
    if (await this.receive.facesDone(linkId, userId, remoteAssets)) {
      await this.receive.deletePendingPerson(linkId, userId, remoteId);
    }
  }

  private async placeFaces(origin: HouseholdOrigin, faces: HouseholdLocalFace[]) {
    const { userId, localId: personGroupId } = origin;
    if (origin.isCopy) {
      await this.people.withMergeWrite(
        () =>
          this.people.reassignFaces({
            faceIds: faces.map(({ id }) => id),
            newPersonGroupId: personGroupId,
            ownerId: userId,
            onlyUndecided: true,
          }),
        userId,
      );
    } else {
      const person = await this.people.getByGroupId({ ownerId: userId, personGroupId });
      const user = await this.users.get(userId, {});
      if (!person || !user?.clusterGroupId) {
        return;
      }
      const config = await getConfig(
        { configRepo: this.configRepo, metadataRepo: this.metadataRepo, logger: this.logger },
        { withCache: true },
      );
      const { maxDistance } = config.machineLearning.facialRecognition;
      const within: HouseholdLocalFace[] = [];
      for (const face of faces) {
        const embedding = await this.people.getFaceEmbedding(face.id);
        const near = embedding
          ? await this.search.searchFaces({
              clusterGroupId: user.clusterGroupId,
              embedding,
              maxDistance,
              numResults: 10,
              hasPerson: true,
            })
          : [];
        if (near.some((candidate) => candidate.personGroupId === personGroupId)) {
          within.push(face);
        }
      }
      if (within.length === 0) {
        return;
      }
      await this.people.withMergeWrite(async () => {
        await this.people.reassignFaces({
          faceIds: within.map(({ id }) => id),
          newPersonGroupId: personGroupId,
          ownerId: userId,
          onlyUndecided: true,
        });
        await this.people.recordFaceCorrections(
          within.map(({ id }) => ({
            ownerId: userId,
            actorId: userId,
            action: 'reassign' as const,
            faceId: id,
            fromPersonId: null,
            toPersonId: personGroupId,
            fromPersonName: null,
            toPersonName: person.name,
          })),
        );
      }, userId);
    }
    const selected = await this.people
      .selectionForThumbnails(false, userId)
      .where('person.personGroupId', '=', personGroupId)
      .where('person.faceAssetId', 'is', null)
      .execute();
    if (selected.length > 0) {
      await this.jobs.queueAll(selected.map(({ data }) => ({ name: JobName.PersonGenerateThumbnail as const, data })));
    }
  }
}
