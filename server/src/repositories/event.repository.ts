import { Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { orderBy } from 'lodash-es';
import { Socket } from 'socket.io';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { JobItem, JobSource, UploadFile } from 'src/types.js';
import { Asset } from 'src/database.js';
import { EventConfig } from 'src/decorators.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import {
  ImmichWorker,
  JobStatus,
  MetadataKey,
  NotificationLevel,
  NotificationType,
  QueueName,
  UserAvatarColor,
  UserStatus,
} from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

type EmitHandlers = Partial<{ [T in EmitEvent]: Array<EventItem<T>> }>;

type Item<T extends EmitEvent> = {
  event: T;
  handler: EmitHandler<T>;
  priority: number;
  server: boolean;
  label: string;
};

type EventMap = {
  // app events
  AppBootstrap: [];
  AppShutdown: [];
  AppRestart: [AppRestartEvent];

  ConfigInit: [{ newConfig: SystemConfig }];
  // config events
  ConfigUpdate: [
    {
      newConfig: SystemConfig;
      oldConfig: SystemConfig;
    },
  ];
  ConfigValidate: [{ newConfig: SystemConfig; oldConfig: SystemConfig }];

  // album events
  AlbumUpdate: [{ id: string; userIds: string[]; recipientIds: string[] }];
  AlbumInvite: [{ id: string; userId: string; senderName: string }];
  /** FL-90: a member left, or was taken out of, an album or shared space; their access ended. */
  AlbumUserRemove: [{ albumId: string; userId: string }];

  // cluster group events
  ClusterGroupRequest: [{ clusterGroupId: string; userId: string; senderName: string }];

  // shared space events (FL-55): members named in a comment
  SharedSpaceMention: [
    { id: string; assetId: string | null; activityId: string; userIds: string[]; senderName: string },
  ];
  // shared space events (FL-55): somebody answered a member's comment
  SharedSpaceReply: [
    {
      id: string;
      assetId: string | null;
      activityId: string;
      parentActivityId: string;
      userId: string;
      senderName: string;
    },
  ];

  // asset events
  AssetCreate: [{ asset: Pick<Asset, 'id' | 'ownerId'>; file?: UploadFile }];
  AssetTag: [{ assetId: string; userId: string }];
  AssetUntag: [{ assetId: string }];
  AssetHide: [{ assetId: string; userId: string }];
  AssetShow: [{ assetId: string; userId: string }];
  AssetTrash: [{ assetId: string; userId: string }];
  AssetDelete: [{ assetId: string; userId: string }];
  AssetMetadataExtracted: [{ assetId: string; userId: string; source?: JobSource }];

  // asset bulk events
  AssetTrashAll: [{ assetIds: string[]; userId: string }];
  AssetDeleteAll: [{ assetIds: string[]; userId: string }];
  AssetRestoreAll: [{ assetIds: string[]; userId: string }];
  /** FL-34: assets were locked outside a service's own lock path (the iCloud reconciler); run the follow-up */
  AssetLockAll: [{ assetIds: string[]; userId: string }];
  /** FL-90: a move into the Locked space committed (every lock path); interactive reads must stop. */
  AssetLocked: [{ assetIds: string[] }];

  /** a worker receives a job and emits this event to run it */
  JobRun: [QueueName, JobItem];
  /** job pre-hook */
  JobStart: [QueueName, JobItem];
  /** job post-hook */
  JobComplete: [QueueName, JobItem];
  /** job finishes without error */
  JobSuccess: [JobSuccessEvent];
  /** job finishes with error */
  JobError: [JobErrorEvent];

  // queue events
  QueueStart: [QueueStartEvent];
  /** the nightly jobs ran with database cleanup on; in-process cleanups that are not queue jobs (FL-32) */
  NightlyDatabaseCleanup: [];

  // library events
  /** FL-78: a library's folders, exclusions or existence changed; the watching worker re-reads it. */
  LibraryWatchUpdate: [{ id: string }];
  /** FL-78: stop the library's scan, if it has one: its folders changed or it is being removed. */
  LibraryScanStop: [{ libraryId: string; reason: 'paths_changed' | 'library_removed' }];

  // session events
  SessionDelete: [{ sessionId: string }];

  // stack events
  StackCreate: [{ stackId: string; userId: string }];
  StackUpdate: [{ stackId: string; userId: string }];
  StackDelete: [{ stackId: string; userId: string }];

  // stack bulk events
  StackDeleteAll: [{ stackIds: string[]; userId: string }];

  // user events
  UserSignup: [{ notify: boolean; id: string; password?: string }];
  UserCreate: [UserEvent];
  /** user is soft deleted */
  UserTrash: [UserEvent];
  /** user is permanently deleted */
  UserDelete: [UserEvent];
  UserRestore: [UserEvent];

  AuthChangePassword: [{ userId: string; currentSessionId?: string; invalidateSessions?: boolean }];

  // hls streaming events
  HlsSegmentRequest: [{ sessionId: string; assetId: string; variantIndex: number; segmentIndex: number }];
  HlsSegmentResult: [{ sessionId: string; variantIndex: number; segmentIndex: number; error?: string }];
  HlsHeartbeat: [{ sessionId: string; variantIndex?: number; segmentIndex?: number }];
  HlsSessionRequest: [{ sessionId: string; assetId: string; ownerId: string }];
  HlsSessionResult: [{ sessionId: string; error?: string }];
  HlsSessionEnd: [{ sessionId: string }];

  // websocket events
  WebsocketConnect: [{ userId: string }];

  /**
   * FL-160: an own-memory cloud backup key was loaded on one worker and is handed to the others, which
   * keep it in memory only. Server-to-server over the event bus; never stored, logged or sent to a client.
   */
  CloudBackupKeyShare: [{ key: string }];
  /** FL-160: a worker needs the own-memory cloud backup key; a worker holding it shares it again. */
  CloudBackupKeyRequest: [];

  /** FL-155: tell every administrator once per `dedupeDays` (at most 30) for the same `dedupeKey`. */
  AdminNotify: [AdminNotice];
};

export type AdminNotice = {
  type: NotificationType;
  level: NotificationLevel;
  title: string;
  description: string;
  /** Notices with the same key are sent once per window; omit to always send. */
  dedupeKey?: string;
  dedupeDays?: number;
};

export type AppRestartEvent = {
  isMaintenanceMode: boolean;
};

type JobSuccessEvent = { job: JobItem; response?: JobStatus };
type JobErrorEvent = { job: JobItem; error: Error | any };

type QueueStartEvent = {
  name: QueueName;
};

type UserEvent = {
  name: string;
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  status: UserStatus;
  email: string;
  profileImagePath: string;
  isAdmin: boolean;
  shouldChangePassword: boolean;
  avatarColor: UserAvatarColor | null;
  oauthId: string | null;
  storageLabel: string | null;
  quotaSizeInBytes: number | null;
  quotaUsageInBytes: number;
  profileChangedAt: Date;
};

export type EmitEvent = keyof EventMap;
export type EmitHandler<T extends EmitEvent> = (...args: ArgsOf<T>) => Promise<void> | void;
export type ArgOf<T extends EmitEvent> = EventMap[T][0];
export type ArgsOf<T extends EmitEvent> = EventMap[T];

export type EventItem<T extends EmitEvent> = {
  event: T;
  handler: EmitHandler<T>;
  server: boolean;
  label?: string;
};

/**
 * FL-169: events announced after something irreversible, whose handlers each do their own part of
 * the follow-up (revoking Studio access, clearing move history, telling clients). Every handler runs
 * even when an earlier one throws; a failure is logged and never reaches the emitter, which could not
 * repeat the change anyway. Other events keep stopping at, and rethrowing, the first failure.
 */
const ISOLATED_EVENTS: ReadonlySet<EmitEvent> = new Set<EmitEvent>(['AssetDelete']);

export type AuthFn = (client: Socket) => Promise<AuthDto>;

@Injectable()
export class EventRepository {
  private emitHandlers: EmitHandlers = {};

  constructor(
    private moduleRef: ModuleRef,
    private configRepository: ConfigRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(EventRepository.name);
  }

  setup({ services }: { services: (new (...args: any[]) => unknown)[] }) {
    const reflector = this.moduleRef.get(Reflector, { strict: false });
    const items: Item<EmitEvent>[] = [];
    const worker = this.configRepository.getWorker();
    if (!worker) {
      throw new Error('Unable to determine worker type');
    }

    // discovery
    for (const Service of services) {
      const instance = this.moduleRef.get<any>(Service);
      const ctx = Object.getPrototypeOf(instance);
      for (const property of Object.getOwnPropertyNames(ctx)) {
        const descriptor = Object.getOwnPropertyDescriptor(ctx, property);
        if (!descriptor || descriptor.get || descriptor.set) {
          continue;
        }

        const handler = instance[property];
        if (typeof handler !== 'function') {
          continue;
        }

        const event = reflector.get<EventConfig>(MetadataKey.EventConfig, handler);
        if (!event) {
          continue;
        }

        const workers = event.workers ?? Object.values(ImmichWorker);
        if (!workers.includes(worker)) {
          continue;
        }

        items.push({
          event: event.name,
          priority: event.priority || 0,
          server: event.server ?? false,
          handler: handler.bind(instance),
          label: `${Service.name}.${handler.name}`,
        });
      }
    }

    const handlers = orderBy(items, ['priority'], ['asc']);

    // register by priority
    for (const handler of handlers) {
      this.addHandler(handler);
    }
  }

  private addHandler<T extends EmitEvent>(item: Item<T>): void {
    const event = item.event;

    if (!Object.hasOwn(this.emitHandlers, event)) {
      this.emitHandlers[event] = [];
    }

    this.emitHandlers[event]!.push(item);
  }

  emit<T extends EmitEvent>(event: T, ...args: ArgsOf<T>): Promise<void> {
    return this.onEvent({ name: event, args, server: false });
  }

  async onEvent<T extends EmitEvent>(event: { name: T; args: ArgsOf<T>; server: boolean }): Promise<void> {
    const handlers = this.emitHandlers[event.name] || [];
    const isolated = ISOLATED_EVENTS.has(event.name);
    for (const { handler, server, label } of handlers) {
      // exclude handlers that ignore server events
      if (!server && event.server) {
        continue;
      }

      if (!isolated) {
        await handler(...event.args);
        continue;
      }

      try {
        await handler(...event.args);
      } catch (error: any) {
        this.logger.error(`Event ${event.name} handler ${label ?? 'unknown'} failed: ${error}`, error?.stack);
      }
    }
  }
}
