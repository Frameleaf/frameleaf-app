import {
  type AlbumUserRole,
  MaintenanceAction,
  type AssetResponseDto,
  type MaintenanceStatusResponseDto,
  type NotificationDto,
  type ReleaseEventV1,
  type ServerVersionResponseDto,
  type SyncAssetEditV1,
  type SyncAssetV2,
} from '@immich/sdk';
import { io, type Socket } from 'socket.io-client';
import { get, writable } from 'svelte/store';
import { page } from '$app/state';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { maintenanceStore } from '$lib/stores/maintenance.store';
import { notificationManager } from '$lib/stores/notification-manager.svelte';
import { createEventEmitter } from '$lib/utils/eventemitter';

interface AppRestartEvent {
  isMaintenanceMode: boolean;
}

export interface Events {
  on_upload_success: (asset: AssetResponseDto) => void;
  on_user_delete: (id: string) => void;
  on_asset_delete: (assetId: string) => void;
  on_asset_trash: (assetIds: string[]) => void;
  on_asset_update: (asset: AssetResponseDto) => void;
  on_asset_hidden: (assetId: string) => void;
  on_asset_restore: (assetIds: string[]) => void;
  on_asset_stack_update: (assetIds: string[]) => void;
  on_person_thumbnail: (personId: string) => void;
  on_server_version: (serverVersion: ServerVersionResponseDto) => void;
  on_config_update: () => void;
  on_new_release: (event: ReleaseEventV1) => void;
  on_session_delete: (sessionId: string) => void;
  // FL-34: this session's elevated (PIN-unlocked) access was revoked, here or in another tab
  on_session_lock: () => void;
  on_notification: (notification: NotificationDto) => void;
  /** FL-43: one of this account's jobs changed. Only the id arrives; Activity asks for the list again. */
  on_media_operation_update: (id: string) => void;
  /** FL-155: the Frameleaf Cloud link, licence or a Frameleaf account changed; only the topic arrives. */
  on_frameleaf_cloud: (event: { topic: 'link' | 'license' | 'account' }) => void;

  AppRestartV1: (event: AppRestartEvent) => void;

  MaintenanceStatusV1: (event: MaintenanceStatusResponseDto) => void;
  AssetEditReadyV2: (data: { asset: SyncAssetV2; edit: SyncAssetEditV1[] }) => void;
  /** Fork-only (FL-39): a video edit render settled without publishing anything. */
  VideoEditVersionFailedV1: (data: { assetId: string; versionId: string | null }) => void;
  /** Fork-only (FL-53): somebody's album role changed, or they left or were removed (`role: null`). */
  AlbumUserUpdateV1: (data: { albumId: string; userId: string; role: AlbumUserRole | null }) => void;
  /** Fork-only (FL-54): a partner stopped sharing their library. */
  PartnerRevokeV1: (data: { sharedById: string; sharedWithId: string }) => void;
}

const websocket: Socket<Events> = io({
  path: '/api/socket.io',
  transports: ['websocket'],
  reconnection: true,
  forceNew: true,
  autoConnect: false,
});

export const websocketStore = {
  connected: writable<boolean>(false),
  serverVersion: writable<ServerVersionResponseDto>(),
  serverRestarting: writable<undefined | AppRestartEvent>(),
};

export const websocketEvents = createEventEmitter(websocket);

// eslint-disable-next-line unicorn/no-top-level-side-effects
websocket
  .on('connect', () => {
    eventManager.emit('WebsocketConnect');
    websocketStore.connected.set(true);
  })
  .on('disconnect', () => websocketStore.connected.set(false))
  .on('on_server_version', (serverVersion) => websocketStore.serverVersion.set(serverVersion))
  .on('AppRestartV1', (mode) => websocketStore.serverRestarting.set(mode))
  .on('MaintenanceStatusV1', (status) => {
    maintenanceStore.status.set(status);

    if (status.action === MaintenanceAction.End) {
      websocketStore.serverRestarting.set({
        isMaintenanceMode: false,
      });
    }
  })
  .on('on_new_release', (event) => eventManager.emit('ReleaseEvent', event))
  .on('on_session_delete', () => eventManager.emit('SessionDelete'))
  .on('on_session_lock', () => eventManager.emit('SessionLockedRemote'))
  .on('on_user_delete', (id) => eventManager.emit('UserAdminDeleted', { id }))
  .on('on_asset_delete', (asset) => eventManager.emit('AssetsDelete', [asset]))
  .on('on_asset_trash', (assets) => eventManager.emit('AssetsDelete', assets))
  .on('on_asset_update', (asset) => eventManager.emit('AssetUpdate', asset))
  .on('on_person_thumbnail', (id) => eventManager.emit('PersonThumbnailReady', { id }))
  .on('on_notification', () => notificationManager.refresh())
  .on('on_media_operation_update', (id) => eventManager.emit('MediaOperationUpdate', { id }))
  .on('on_frameleaf_cloud', (event) => eventManager.emit('FrameleafCloudUpdate', event))
  // FL-53: a role change made elsewhere reaches this page as the same event a local change raises.
  .on('PartnerRevokeV1', (data) => eventManager.emit('PartnerRevoke', data))
  .on('AlbumUserUpdateV1', ({ albumId, userId, role }) =>
    role
      ? eventManager.emit('AlbumUserUpdate', { albumId, userId, role })
      : eventManager.emit('AlbumUserDelete', { albumId, userId }),
  )
  .on('connect_error', (e) => console.log('Websocket Connect Error', e));

export const openWebsocketConnection = () => {
  try {
    if (
      authManager.authenticated ||
      get(websocketStore.serverRestarting) ||
      page.url.pathname.startsWith(Route.maintenanceMode())
    ) {
      websocket.connect();
    }
  } catch (error) {
    console.log('Cannot connect to websocket', error);
  }
};

export const closeWebsocketConnection = () => {
  websocket.disconnect();
};

export const waitForWebsocketEvent = <T extends keyof Events>(
  event: T,
  predicate?: (...args: Parameters<Events[T]>) => boolean,
  timeout: number = 10_000,
): Promise<Parameters<Events[T]>> => {
  return new Promise((resolve, reject) => {
    // @ts-expect-error: The typings are weird on this?
    const cleanup = websocketEvents.on(event, (...args: Parameters<Events[T]>) => {
      if (predicate && !predicate(...args)) {
        return;
      }

      cleanup();
      clearTimeout(timer);
      resolve(args);
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeout);
  });
};
