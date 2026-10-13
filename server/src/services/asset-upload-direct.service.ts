import { ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { RTCDataChannel, RTCPeerConnection } from 'werift';
import type { IncomingHttpHeaders } from 'node:http';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import { Permission } from 'src/enum.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { AuthService } from 'src/services/auth.service.js';
import {
  DIRECT_UPLOAD_CHANNEL,
  DIRECT_UPLOAD_LIMITS,
  DirectAppend,
  parseDirectAppend,
  validateDirectOffer,
} from 'src/utils/asset-upload-direct.js';

@Injectable()
export class AssetUploadDirectService {
  private peers = new Map<RTCPeerConnection, { ownerId: string; close: () => void }>();
  private releases = new Set<Promise<void>>();

  constructor(
    private uploads: AssetUploadResourceService,
    private auth: AuthService,
    private admission: RateLimitRepository,
  ) {}

  private createPeer() {
    return new RTCPeerConnection({
      iceServers: [{ urls: ['stun:us1.relays.frameleaf.cloud:3478', 'stun:ca1.relays.frameleaf.cloud:3478'] }],
      maxMessageSize: DIRECT_UPLOAD_LIMITS.frameBytes,
    });
  }

  async negotiate(
    auth: AuthDto,
    id: string,
    input: unknown,
    headers: IncomingHttpHeaders,
    queryParams: Record<string, string> = {},
  ) {
    const ownerId = auth.user.id;
    const offer = validateDirectOffer(input);
    // Authenticate as WAN even when the signaling HTTPS route was local or relayed.
    const credentials: IncomingHttpHeaders = {};
    for (const name of ['authorization', 'cookie', 'x-api-key', 'x-immich-user-token', 'x-immich-session-token']) {
      if (typeof headers[name] === 'string') credentials[name] = headers[name];
    }
    const query = Object.fromEntries(
      Object.entries(queryParams).filter(([name]) => ['sessionKey', 'apiKey'].includes(name)),
    );
    const authenticate = async () => {
      const current = await this.auth.authenticate({
        headers: credentials,
        queryParams: query,
        metadata: {
          permission: Permission.AssetUpload,
          sharedLinkRoute: false,
          adminRoute: false,
          uri: '/assets/uploads/:id/direct',
          via: 'wan',
          refreshElevation: false,
        },
      });
      if (current.user.id !== ownerId) throw new ForbiddenException();
      return current;
    };
    const currentAuth = await authenticate();
    const resource = await this.uploads.head(currentAuth, id);
    const maxAppendSize = Math.min(resource.maxAppendSize, DIRECT_UPLOAD_LIMITS.appendBytes);
    if (
      this.peers.size >= DIRECT_UPLOAD_LIMITS.peers ||
      this.peers
        .values()
        .filter((peer) => peer.ownerId === ownerId)
        .toArray().length >= DIRECT_UPLOAD_LIMITS.peersPerOwner
    ) {
      throw new HttpException('Direct upload capacity unavailable', 429);
    }
    const peerId = randomUUID();
    let acquired: boolean;
    try {
      acquired = await this.admission.claimDirectUploadPeer(peerId, ownerId);
    } catch {
      throw new ServiceUnavailableException('Direct upload admission unavailable');
    }
    if (!acquired) throw new HttpException('Direct upload capacity unavailable', 429);
    const release = () => {
      const operation = this.admission
        .releaseDirectUploadPeer(peerId, ownerId)
        .catch(() => {})
        .finally(() => {
          this.releases.delete(operation);
        });
      this.releases.add(operation);
    };
    let peer: RTCPeerConnection;
    try {
      peer = this.createPeer();
    } catch {
      release();
      throw new ServiceUnavailableException('Direct upload unavailable');
    }
    let channel: RTCDataChannel | undefined;
    let pending: { append: DirectAppend; bytes: Buffer[]; received: number } | undefined;
    let committing = false;
    let closed = false;
    let failed = false;
    let negotiationFailure: ((error: ServiceUnavailableException) => void) | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const timer = (callback: () => void, ms: number) => {
      const handle = setTimeout(callback, ms);
      handle.unref();
      timers.add(handle);
      return handle;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      negotiationFailure?.(new ServiceUnavailableException('Direct upload unavailable'));
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
      pending = undefined;
      for (const name of Object.keys(credentials)) delete credentials[name];
      for (const name of Object.keys(query)) delete query[name];
      this.peers.delete(peer);
      release();
      void peer.close().catch(() => {});
    };
    this.peers.set(peer, { ownerId, close });
    let idle = timer(close, DIRECT_UPLOAD_LIMITS.idleMs);
    const touch = () => {
      clearTimeout(idle);
      timers.delete(idle);
      idle = timer(close, DIRECT_UPLOAD_LIMITS.idleMs);
    };
    timer(close, DIRECT_UPLOAD_LIMITS.lifetimeMs);
    const reject = (requestId: string | undefined, status: number) => {
      if (closed || failed) return;
      failed = true;
      pending = undefined;
      if (channel?.readyState === 'open' && requestId) {
        try {
          channel.send(JSON.stringify({ version: 1, type: 'error', requestId, status }));
          // Give SCTP the bounded opportunity to deliver a refusal before teardown.
          timer(close, 1000);
          return;
        } catch {
          close();
          return;
        }
      }
      close();
    };
    const commit = async () => {
      const batch = pending!;
      committing = true;
      try {
        const liveAuth = await authenticate();
        const live = await this.uploads.head(liveAuth, id);
        if (closed || failed) return;
        if (batch.append.length > Math.min(live.maxAppendSize, DIRECT_UPLOAD_LIMITS.appendBytes)) {
          throw new HttpException('Invalid direct upload control', 400);
        }
        const body = Buffer.concat(batch.bytes, batch.received);
        batch.bytes = [];
        let eofFailure: unknown;
        const source = Readable.from(
          (async function* () {
            if (closed || failed) throw new ServiceUnavailableException();
            if (body.length > 0) yield body;
            // A credential revoked while bytes arrived cannot trigger native publication at EOF.
            try {
              await authenticate();
            } catch (error) {
              eofFailure = error;
              throw error;
            }
            if (closed || failed) throw new ServiceUnavailableException();
          })(),
        );
        const outcome = await this.uploads.append(
          liveAuth,
          id,
          {
            'content-type': 'application/partial-upload',
            'upload-draft-interop-version': '9',
            'upload-offset': String(batch.append.offset),
            'upload-complete': batch.append.complete ? '?1' : '?0',
          },
          source,
        );
        // Native interruption retains bytes; it must not turn an EOF authorization refusal into an ACK.
        if (eofFailure !== undefined) throw eofFailure;
        if (closed || failed) return;
        channel!.send(
          JSON.stringify({
            version: 1,
            type: 'ack',
            requestId: batch.append.requestId,
            status: outcome.result ? 200 : outcome.resource.state === 'published' ? 202 : 204,
            offset: outcome.resource.offset,
            complete: outcome.resource.state === 'published' && outcome.resource.ingested,
            ...(outcome.result && { result: outcome.result }),
          }),
        );
        pending = undefined;
        touch();
      } catch (error) {
        reject(batch.append.requestId, error instanceof HttpException ? error.getStatus() : 500);
      } finally {
        committing = false;
      }
    };
    peer.onDataChannel.subscribe((incoming) => {
      if (
        closed ||
        channel ||
        incoming.label !== DIRECT_UPLOAD_CHANNEL ||
        !incoming.ordered ||
        incoming.maxRetransmits !== null ||
        incoming.maxPacketLifeTime !== null ||
        incoming.negotiated
      ) {
        incoming.close();
        close();
        return;
      }
      channel = incoming;
      touch();
      incoming.stateChange.subscribe((state) => {
        if (state === 'closed' || state === 'closing') close();
      });
      incoming.error.subscribe(() => close());
      incoming.onMessage.subscribe((message) => {
        if (closed || failed) return;
        try {
          if (committing) throw new HttpException('Overlapping direct upload', 400);
          if (typeof message === 'string') {
            if (pending) throw new HttpException('Overlapping direct upload', 400);
            const append = parseDirectAppend(message, maxAppendSize);
            pending = { append, bytes: [], received: 0 };
          } else {
            if (
              !pending ||
              message.length === 0 ||
              message.length > DIRECT_UPLOAD_LIMITS.frameBytes ||
              message.length > pending.append.length - pending.received
            ) {
              throw new HttpException('Invalid direct upload frame', 400);
            }
            pending.bytes.push(message);
            pending.received += message.length;
          }
          touch();
          if (pending && pending.received === pending.append.length) void commit();
        } catch {
          reject(pending?.append.requestId, 400);
        }
      });
    });
    peer.connectionStateChange.subscribe((state) => {
      if (['failed', 'closed', 'disconnected'].includes(state)) close();
    });
    let negotiation: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
          if (closed) throw new ServiceUnavailableException();
          await peer.setLocalDescription(await peer.createAnswer());
        })(),
        new Promise<never>((_, rejectPromise) => {
          negotiationFailure = rejectPromise;
          negotiation = timer(() => {
            close();
            rejectPromise(new ServiceUnavailableException('Direct upload unavailable'));
          }, DIRECT_UPLOAD_LIMITS.negotiationMs);
        }),
      ]);
      const sdp = peer.localDescription?.sdp;
      if (closed || !sdp || Buffer.byteLength(sdp) > DIRECT_UPLOAD_LIMITS.sdpBytes) {
        throw new ServiceUnavailableException('Direct upload unavailable');
      }
      return { version: 1 as const, sdp };
    } catch (error) {
      close();
      if (error instanceof HttpException) throw error;
      throw new HttpException('Invalid direct upload offer', 400);
    } finally {
      negotiationFailure = undefined;
      if (negotiation) {
        clearTimeout(negotiation);
        timers.delete(negotiation);
      }
    }
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    for (const session of this.peers.values()) session.close();
    await Promise.all(this.releases);
  }
}
