import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import z from 'zod';
import type { Selectable } from 'kysely';
import type { HouseholdLinkDto } from 'src/dtos/household-link.dto.js';
import type { HouseholdLinkTable } from 'src/schema/tables/household-link.table.js';
import { OnEvent } from 'src/decorators.js';
import { FrameleafWorker } from 'src/enum.js';
import { HouseholdLinkRepository } from 'src/repositories/household-link.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { buddyCloudClientError } from 'src/services/buddy-backup.service.js';
import { HouseholdPeerService } from 'src/services/household-peer.service.js';
import { FrameleafCloudError, cloudErrorCode } from 'src/utils/frameleaf-cloud.js';
import {
  HouseholdGrantResponse,
  HouseholdInvitationPreview,
  HouseholdInviteResponse,
  HouseholdLink,
  HouseholdLinkList,
} from 'src/utils/frameleaf-household.js';
import { HouseholdClient, HouseholdKeyChanged } from 'src/utils/household-client.js';
import { HOUSEHOLD_PROTOCOL_VERSION } from 'src/utils/household-protocol.js';

type Link = Selectable<HouseholdLinkTable>;

const CHECK_EVERY_MS = 5 * 60_000;
// The inviting server only learns its invitation was accepted from this list, so it is read at every check.
const RECONCILE_EVERY_MS = CHECK_EVERY_MS;
const Handshake = z.strictObject({
  version: z.literal(HOUSEHOLD_PROTOCOL_VERSION),
  name: z.string().max(100),
  maxOriginalBytes: z.number().int().positive(),
});

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());
const toDto = (link: Link): HouseholdLinkDto => ({
  id: link.id,
  householdName: link.householdName,
  peerName: link.peerName,
  state: link.state,
  active: link.state === 'active',
  paused: link.state === 'paused',
  ended: link.state === 'ended',
  reason: link.pausedReason,
  connectionPath: link.connectionPath,
  lastSeenAt: iso(link.lastSeenAt),
  createdAt: iso(link.createdAt)!,
  endedAt: iso(link.endedAt),
});

/**
 * Linked Households (FL-952): an administrator links this server with another household's server through a
 * Frameleaf Cloud invitation, and a timer keeps each link's state and reachability current. Ending a link, from
 * either side, only changes its state: nothing else is deleted.
 */
@Injectable()
export class HouseholdLinkService {
  private clients = new Map<string, HouseholdClient>();
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  private reconcileAt = 0;

  constructor(
    private links: HouseholdLinkRepository,
    private peer: HouseholdPeerService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(HouseholdLinkService.name);
  }

  /** A call an administrator made: a refusal by Cloud keeps Cloud's status, code and message (FL-506). */
  private asked<T extends z.ZodType>(schema: T, path: string, body?: unknown) {
    return this.peer.cloud(schema, path, body).catch((error: unknown) => {
      throw buddyCloudClientError(error);
    });
  }

  async invite() {
    const invitation = await this.asked(HouseholdInviteResponse, 'invitations', { version: 1 });
    return {
      invitationId: invitation.invitationId,
      token: invitation.token,
      code: invitation.code,
      expiresAt: invitation.expiresAt,
    };
  }

  /** `code` is the invitation's token or its short code; Cloud takes either. */
  async preview(code: string) {
    const { name } = await this.asked(HouseholdInvitationPreview, `invitations/${code}`);
    return { name };
  }

  async accept(code: string, householdName?: string): Promise<HouseholdLinkDto> {
    const link = await this.adopt(
      await this.asked(HouseholdLink, 'invitations/accept', { version: 1, token: code }),
      householdName,
    );
    if (!link) throw new ForbiddenException('Frameleaf Cloud did not return a usable household link.');
    return toDto(link);
  }

  /** Cloud is asked first, so a link the other household accepted or ended shows without waiting for the timer. */
  async list(): Promise<HouseholdLinkDto[]> {
    await this.reconcile().catch(() => this.logger.warn('Household links could not be checked with Frameleaf Cloud'));
    const links = await this.links.getAll();
    return links.map((link) => toDto(link));
  }

  async refresh(id: string): Promise<HouseholdLinkDto> {
    const link = await this.require(id);
    return toDto(link.state === 'ended' ? link : await this.check(link));
  }

  /** The name is this administrator's own: it is stored here and sent nowhere. */
  async rename(id: string, householdName: string): Promise<HouseholdLinkDto> {
    const link = await this.links.rename(id, householdName);
    if (!link) throw new NotFoundException('Household link not found');
    return toDto(link);
  }

  /** Always ends the link here, even when Cloud cannot be told now; `reconcile` tells it later. */
  async end(id: string): Promise<void> {
    const link = await this.require(id);
    await this.endLocally(link);
    await this.tellCloudEnded(link);
  }

  private async require(id: string) {
    const link = await this.links.get(id);
    if (!link) throw new NotFoundException('Household link not found');
    return link;
  }

  private async endLocally(link: Link) {
    this.clients.delete(link.id);
    await this.links.update(link.id, { state: 'ended', endedAt: new Date(), pausedReason: null, connectionPath: null });
  }

  private tellCloudEnded(link: Link) {
    return this.peer
      .cloud(HouseholdLink, `links/${link.cloudLinkId}/end`, { version: 1 })
      .catch(() => this.logger.warn(`Household link ${link.id} ended here; Frameleaf Cloud has not confirmed it yet`));
  }

  /** The local row for a link Cloud introduced. The peer's key is stored once, here, and never replaced. */
  private async adopt(remote: HouseholdLink, householdName?: string) {
    const identity = await this.peer.identity();
    if (remote.state !== 'active' || !remote.peerPublicKey || remote.peerInstanceId === identity.instanceId) return;
    return this.links.create({
      cloudLinkId: remote.linkId,
      peerInstanceId: remote.peerInstanceId,
      peerName: remote.peerName,
      // until the administrator names the household, it goes by its server's name
      householdName: householdName ?? (remote.peerName.trim().slice(0, 80) || 'Frameleaf server'),
      peerPublicKey: remote.peerPublicKey.x,
    });
  }

  /** Local rows follow Cloud's list: a link accepted elsewhere appears, a link ended elsewhere ends. */
  async reconcile() {
    if (!(await this.peer.linked())) return;
    const { links: remote } = await this.peer.cloud(HouseholdLinkList, 'links');
    const local = new Map((await this.links.getAll()).map((link) => [link.cloudLinkId, link]));
    for (const link of remote) {
      const row = local.get(link.linkId);
      if (!row) {
        await this.adopt(link);
      } else if (row.state === 'ended') {
        if (link.state === 'active') await this.tellCloudEnded(row);
      } else if (link.state === 'ended') {
        await this.endLocally(row);
      } else if (link.peerName !== row.peerName) {
        await this.links.update(row.id, { peerName: link.peerName });
      }
    }
  }

  private client(link: Link) {
    let client = this.clients.get(link.id);
    if (!client) {
      client = new HouseholdClient(
        link,
        () => this.peer.cloud(HouseholdGrantResponse, 'grants', { version: 1, linkId: link.cloudLinkId }),
        () => this.peer.signer(),
      );
      this.clients.set(link.id, client);
    }
    return client;
  }

  /** FL-979: a signed read from the other household. The caller parses the reply with a strict schema. */
  readPeer(link: Link, path: string) {
    return this.client(link).get<unknown>(path);
  }

  /** One grant and one handshake: the link's state, its addresses and the path that answered. */
  async check(link: Link): Promise<Link> {
    const client = this.client(link);
    let change: Partial<Pick<Link, 'state' | 'pausedReason' | 'connectionPath' | 'lastSeenAt'>>;
    try {
      Handshake.parse(await client.get('handshake'));
      change = { state: 'active', pausedReason: null, connectionPath: client.connection, lastSeenAt: new Date() };
    } catch (error) {
      const reason = this.problem(error, client);
      if (reason === 'ended') {
        await this.endLocally(link);
        return (await this.links.get(link.id)) ?? link;
      }
      change = { ...reason, connectionPath: null };
    }
    const addresses = client.connections.map(({ kind, uri }) => ({ kind, uri }));
    return (await this.links.update(link.id, { ...change, addresses })) ?? (await this.require(link.id));
  }

  /** Why a check failed, as the state and the short machine word the link then carries. */
  private problem(error: unknown, client: HouseholdClient) {
    const paused = (pausedReason: string) => ({ state: 'paused', pausedReason });
    if (error instanceof FrameleafCloudError) {
      // No answer or a 5xx: no new grant, so nothing can be sent until Cloud is back.
      if (error.status === null || error.status >= 500) return paused('cloud');
      if (error.envelope?.detail === 'link-ended') return 'ended' as const;
      if (cloudErrorCode(error) === 'entitlement-missing') return paused('licence');
      if (error.envelope?.detail === 'peer-unavailable') return paused('peer-unlinked');
      return paused(error.status === 401 || cloudErrorCode(error) === 'clone_suspected' ? 'unlinked' : 'cloud');
    }
    // this server is not linked to Frameleaf Cloud (`cloudTarget`)
    if (error instanceof ForbiddenException) return paused('unlinked');
    if (error instanceof HouseholdKeyChanged) return paused('key');
    // Cloud issued the grant but no listed address answered as the peer. Home addresses alone mean the other
    // household has no remote access plan, so it can only be reached on its own network.
    return {
      state: 'active',
      pausedReason: client.connections.every((connection) => connection.local) ? 'home-network' : 'unreachable',
    };
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.timer = setInterval(() => this.tick(), CHECK_EVERY_MS);
    this.tick();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }

  tick() {
    if (this.active || this.stopped) return;
    this.active = this.run()
      .catch(() => this.logger.warn('Household links could not be checked'))
      .finally(() => {
        this.active = undefined;
      });
  }

  private async run() {
    if (Date.now() >= this.reconcileAt) {
      this.reconcileAt = Date.now() + RECONCILE_EVERY_MS;
      await this.reconcile().catch(() => this.logger.warn('Household links could not be checked with Frameleaf Cloud'));
    }
    for (const link of await this.links.getAll()) {
      if (this.stopped) return;
      if (link.state !== 'ended')
        await this.check(link).catch(() => this.logger.warn(`Household link ${link.id} could not be checked`));
    }
  }
}
