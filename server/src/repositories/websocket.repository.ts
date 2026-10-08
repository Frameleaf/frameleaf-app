import { Injectable } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AlbumUserRole } from 'src/enum.js';
import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { NotificationDto } from 'src/dtos/notification.dto.js';
import { ReleaseEventV1, ServerVersionResponseDto } from 'src/dtos/server.dto.js';
import { SyncAssetEditV1, SyncAssetExifV1, SyncAssetV2 } from 'src/dtos/sync.dto.js';
import { withSocketPublication } from 'src/middleware/websocket.adapter.js';
import { type AppRestartEvent, type ArgsOf, EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { handlePromiseError } from 'src/utils/misc.js';

export const serverEvents = [
  'ConfigUpdate',
  'AppRestart',
  'HlsSegmentRequest',
  'HlsSegmentResult',
  'HlsHeartbeat',
  'HlsSessionRequest',
  'HlsSessionResult',
  'HlsSessionEnd',
  'LibraryWatchUpdate',
  'CloudBackupKeyShare',
  'CloudBackupKeyRequest',
] as const;
export type ServerEvents = (typeof serverEvents)[number];

export interface ClientEventMap {
  /** Complete local sequence; never translated into broad Trash/Delete handlers. */
  AssetLocalEffectsV1: [
    { streamEpoch: string; sequence: string; effectId: string; assetIds: string[]; revokedOperationIds: string[] },
  ];
  on_upload_success: [AssetResponseDto];
  on_user_delete: [string];
  on_asset_delete: [string];
  on_asset_trash: [string[]];
  on_asset_update: [AssetResponseDto];
  on_asset_hidden: [string];
  on_asset_restore: [string[]];
  on_asset_stack_update: string[];
  on_album_update: [string];
  on_person_thumbnail: [string];
  on_server_version: [ServerVersionResponseDto];
  on_config_update: [];
  on_new_release: [ReleaseEventV1];
  on_notification: [NotificationDto];
  on_session_delete: [string];
  /** FL-34: the elevated (PIN-unlocked) access of the receiving session(s) was revoked. */
  on_session_lock: [];
  /**
   * FL-43: one of the receiving account's jobs changed state. Only the id travels; the client asks the
   * owner-scoped job list again, so nothing about the job is revealed by the event itself.
   */
  on_media_operation_update: [string];
  /**
   * FL-155: the Frameleaf Cloud link, licence or a person's Frameleaf account changed. Sent to
   * administrators (and, for `account`, to that person); only the topic travels, and the client
   * reads the admin-only status again.
   */
  on_frameleaf_cloud: [{ topic: FrameleafCloudTopic }];
  /**
   * FL-146 (FL-77, owner decision 2026-09-29): an administrator changed the receiving account's
   * preferences. Nothing else travels; the account's open sessions read their preferences again.
   */
  on_user_preferences_update: [];

  AssetUploadReadyV2: [{ asset: SyncAssetV2; exif: SyncAssetExifV1 }];
  AppRestartV1: [AppRestartEvent];
  AssetEditReadyV2: [{ asset: SyncAssetV2; edit: SyncAssetEditV1[] }];
  /**
   * Fork-only (FL-39): a video edit render settled without publishing anything. Official clients
   * never subscribe to it, so a failure never looks like an "edit ready" to them.
   */
  VideoEditVersionFailedV1: [{ assetId: string; versionId: string | null }];
  /**
   * Fork-only (FL-53): somebody's role in an album changed, or they left or were removed (`role:
   * null`). Sent to that person and to the album's remaining members, so open pages drop controls
   * and dialogs the new role no longer allows without waiting for a reload.
   */
  AlbumUserUpdateV1: [{ albumId: string; userId: string; role: AlbumUserRole | null }];
  /**
   * Fork-only (FL-54): `sharedById` stopped sharing their library with `sharedWithId`. Sent to both,
   * so the recipient's open timeline, partner page and viewer drop what they held at once.
   */
  PartnerRevokeV1: [{ sharedById: string; sharedWithId: string }];
  /**
   * FL-111: a committed shelf or audience change invalidates generated content for this project.
   * Sent only to its authenticated owner's room; null invalidates all after emptying their trash.
   * Discard admitted content immediately and reauthorize before displaying it again.
   */
  StudioProjectInvalidatedV1: [{ projectId: string | null }];
}

export type FrameleafCloudTopic = 'link' | 'license' | 'account';

export type AuthFn = (client: Socket) => Promise<AuthDto>;

// FL-161: no permissive `cors`. Only the websocket transport is offered, and each handshake's
// `Origin` is checked against this server's own names in `AuthService.authenticateWebsocket()`
// before the socket joins any room.
@WebSocketGateway({
  path: '/api/socket.io',
  transports: ['websocket'],
})
@Injectable()
export class WebsocketRepository implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
  private authFn?: AuthFn;

  @WebSocketServer()
  private server?: Server;

  constructor(
    private eventRepository: EventRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(WebsocketRepository.name);
  }

  afterInit(server: Server) {
    this.logger.log('Initialized websocket server');

    for (const event of serverEvents) {
      server.on(event, (...args: ArgsOf<any>) => {
        this.logger.debug(`Server event: ${event} (receive)`);
        handlePromiseError(this.eventRepository.onEvent({ name: event, args, server: true }), this.logger);
      });
    }
  }

  async handleConnection(client: Socket) {
    try {
      this.logger.log(`Websocket Connect:    ${client.id}`);
      const auth = await this.authenticate(client);
      await client.join(auth.user.id);
      if (auth.session) {
        await client.join(auth.session.id);
      }
      await this.eventRepository.emit('WebsocketConnect', { userId: auth.user.id });
    } catch (error: any) {
      this.logger.error(`Websocket connection error: ${error}`, error?.stack);
      client.emit('error', 'unauthorized');
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Websocket Disconnect: ${client.id}`);
    await client.leave(client.nsp.name);
  }

  clientSend<T extends keyof ClientEventMap>(event: T, room: string, ...data: ClientEventMap[T]) {
    this.server?.to(room).emit(event, ...data);
  }

  clientBroadcast<T extends keyof ClientEventMap>(event: T, ...data: ClientEventMap[T]) {
    this.server?.emit(event, ...data);
  }

  async clientBroadcastAndFlush(event: 'AppRestartV1', ...data: ClientEventMap['AppRestartV1']): Promise<void> {
    const server = this.requireServer();
    await withSocketPublication(server, () =>
      server.sockets.adapter.broadcast(
        { type: 2, nsp: server.sockets.name, data: [event, ...data] },
        { rooms: new Set(), except: new Set(), flags: {} },
      ),
    );
  }

  async serverSendAndFlush(event: 'AppRestart', ...args: ArgsOf<'AppRestart'>): Promise<void> {
    const server = this.requireServer();
    await withSocketPublication(server, () => {
      server.serverSideEmit(event, ...args);
    });
  }

  async acknowledgeRestart(ack?: (ok: 'ok') => void): Promise<void> {
    if (ack) {
      await withSocketPublication(this.requireServer(), () => ack('ok'));
    }
  }

  private requireServer(): Server {
    if (!this.server) {
      throw new Error('Websocket server is unavailable for restart publication');
    }
    return this.server;
  }

  serverSend<T extends ServerEvents>(event: T, ...args: ArgsOf<T>): void {
    this.logger.debug(`Server event: ${event} (send)`);
    this.server?.serverSideEmit(event, ...args);
  }

  setAuthFn(fn: (client: Socket) => Promise<AuthDto>) {
    this.authFn = fn;
  }

  private async authenticate(client: Socket) {
    if (!this.authFn) {
      throw new Error('Auth function not set');
    }

    return this.authFn(client);
  }
}
