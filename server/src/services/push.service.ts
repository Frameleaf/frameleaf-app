import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { PushGatewayTarget } from 'src/repositories/frameleaf-cloud-push.repository.js';
import type {
  PushDeviceWithActivities,
  PushTokenRef,
  UnifiedPushEndpointRef,
} from 'src/repositories/push-device.repository.js';
import type { UnifiedPushSubscription } from 'src/repositories/unified-push.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { UNIFIED_PUSH_DEFAULTS } from 'src/dtos/config.dto.js';
import {
  PushActivityTokenDto,
  PushDeviceListResponseDto,
  PushDeviceRegisterDto,
  PushDeviceResponseDto,
  PushDeviceTestResponseDto,
  PushDeviceUpdateDto,
  PushPreferencesDto,
  PushStatusResponseDto,
} from 'src/dtos/push.dto.js';
import {
  JobName,
  JobStatus,
  PushEventType,
  PushPlatform,
  PushUnavailableReason,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafCloudPushRepository } from 'src/repositories/frameleaf-cloud-push.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PushDeviceRepository } from 'src/repositories/push-device.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UnifiedPushRepository } from 'src/repositories/unified-push.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { getConfig } from 'src/utils/config.js';
import { loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { isLicensed } from 'src/utils/frameleaf-license.js';
import {
  PUSH_GATEWAY_CONCURRENCY,
  PUSH_GATEWAY_MAX_ATTEMPTS,
  PushNotice,
  PushSendRequest,
  PushSendResult,
  PushTargetKind,
  buildPushPayload,
  collapseIdOf,
  isGatewayToken,
  liveActivityPlanOf,
  pushTtlSec,
  unifiedPushPlaintextOf,
} from 'src/utils/frameleaf-push.js';
import { type HiddenContentFilter, hasHiddenContentFilter } from 'src/utils/hidden-content.js';
import { notificationLocaleOf } from 'src/utils/notification-locale.js';
import { getPreferences } from 'src/utils/preferences.js';
import { parsePushPublicKey, pushKeyFingerprint, sealPushEnvelope } from 'src/utils/push-crypto.js';
import { parseWebPushAuth, parseWebPushPublicKey } from 'src/utils/web-push.js';
/** How long a phone backup may go without a reported success before the device is woken. */
export const PUSH_BACKUP_STALE_AFTER_MS = 48 * 60 * 60 * 1000;
/** At most one stale-backup wake-up per device in this window (the nightly job runs once a day). */
export const PUSH_BACKUP_WAKE_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** Album additions wait this long, so photos added one by one become one notice. */
export const PUSH_ALBUM_UPDATE_DELAY_MS = 60_000;

/** The API's preference names and the event each one switches. */
const PREFERENCE_EVENTS: Record<keyof PushPreferencesDto, PushEventType> = {
  backupNeedsAttention: PushEventType.BackupNeedsAttention,
  backupStale: PushEventType.BackupStale,
  cloudBackupActivation: PushEventType.CloudBackupActivation,
  sharedActivity: PushEventType.SharedActivity,
  memories: PushEventType.Memories,
  renderFinished: PushEventType.RenderFinished,
  renderProgress: PushEventType.RenderProgress,
  accessChanged: PushEventType.AccessChanged,
};

const disabledEventsOf = (preferences: PushPreferencesDto | undefined, current: string[] = []): string[] => {
  const disabled = new Set(current);
  for (const [name, event] of Object.entries(PREFERENCE_EVENTS) as Array<[keyof PushPreferencesDto, PushEventType]>) {
    const value = preferences?.[name];
    if (value === true) {
      disabled.delete(event);
    } else if (value === false) {
      disabled.add(event);
    }
  }
  return Object.values(PushEventType).filter((event) => disabled.has(event));
};

/** FL-926: whether this server delivers to UnifiedPush now, and the administrator's address rule. */
type UnifiedPushAccess = { available: boolean; reason: string | null; allowLocalTargets: boolean };

/** How a device is reached: `unifiedpush` when it registered an endpoint, else `cloud` (the gateway). */
type PushTransport = 'cloud' | 'unifiedpush';

const endpointHostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
};

const mapDevice = (
  device: PushDeviceWithActivities,
  currentSessionId: string | undefined,
  unifiedPush: Pick<UnifiedPushAccess, 'available' | 'reason'>,
): PushDeviceResponseDto => ({
  id: device.id,
  platform: device.platform,
  current: device.sessionId === currentSessionId,
  publicKeyFingerprint: pushKeyFingerprint(device.publicKey),
  hasPushToStartToken: !!device.pushToStartToken,
  apnsEnvironment: device.platform === PushPlatform.Ios ? (device.apnsEnvironment ?? 'production') : null,
  backupDeviceKey: device.backupDeviceKey,
  preferences: Object.fromEntries(
    Object.entries(PREFERENCE_EVENTS).map(([name, event]) => [name, !device.disabledEvents.includes(event)]),
  ) as PushDeviceResponseDto['preferences'],
  activities: device.activities.map(({ activityId, kind, updatedAt }) => ({
    activityId,
    kind,
    updatedAt: new Date(updatedAt).toISOString(),
  })),
  createdAt: new Date(device.createdAt).toISOString(),
  updatedAt: new Date(device.updatedAt).toISOString(),
  lastDeliveredAt: device.lastDeliveredAt ? new Date(device.lastDeliveredAt).toISOString() : null,
  transport: device.unifiedPushEndpoint ? 'unifiedpush' : 'cloud',
  unifiedPush: device.unifiedPushEndpoint
    ? {
        endpointHost: endpointHostOf(device.unifiedPushEndpoint),
        available: unifiedPush.available,
        reason: unifiedPush.reason,
      }
    : null,
});

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

type PlannedMessage = {
  request: PushSendRequest;
  deviceId: string;
  kind: PushTargetKind;
  activityRowId?: string;
  /** FL-926: set when this target goes to the device's UnifiedPush endpoint instead of the gateway. */
  unifiedPush?: UnifiedPushSubscription;
};

/** One send's outcome: the gateway's answer, a UnifiedPush endpoint that is gone, or a refusal. */
type DeliveryResult = PushSendResult | { status: 'gone' } | { status: 'rejected'; reason?: string };

/** FL-926: the test notification (`POST /push/devices/:id/test`); it names nothing and links nowhere. */
const TEST_NOTICE: PushNotice = {
  type: PushEventType.SharedActivity,
  title: 'Test notification',
  body: 'Push notifications from Frameleaf reach this device',
  data: { action: 'test' },
};

/** One target of a notice: which device, which of its tokens. A retry names the targets it is for. */
const deliveryKeyOf = ({ deviceId, kind, activityRowId }: Omit<PlannedMessage, 'request' | 'unifiedPush'>) =>
  `${deviceId}:${kind}:${activityRowId ?? ''}`;

/** The collapse id of a notice: from its dedupe key, or the one its first attempt had. */
const collapseIdOfNotice = (notice: Pick<PushNotice, 'dedupeKey' | 'retry'>) =>
  notice.retry?.collapseId ?? collapseIdOf(notice.dedupeKey);

/** A 429 or 503 from the gateway may say when to come back (`Retry-After`, or the error's `retryAfterSec`). */
const retryAfterOf = (error: unknown): { retryAfterSec?: number } => {
  if (!(error instanceof FrameleafCloudError)) {
    return {};
  }
  const fromData = error.envelope?.data?.retryAfterSec;
  const seconds = error.retryAfterSeconds ?? (typeof fromData === 'number' ? fromData : null);
  return seconds && Number.isFinite(seconds) && seconds > 0 ? { retryAfterSec: Math.ceil(seconds) } : {};
};

/** Wait before retry `attempt` (2, 3, …): 30 s, 2 min, 8 min, …, or the gateway's own `retryAfterSec` when longer. */
const retryDelayMs = (attempt: number, retryAfterSec?: number) =>
  Math.max(30_000 * 4 ** (attempt - 2), (retryAfterSec ?? 0) * 1000);

/**
 * FL-228: push notifications for the native apps. Devices register a push token and a per-device key;
 * events become notices, and each notice is delivered as an encrypted blob per device through the
 * Frameleaf push gateway. Only a linked server delivers through the gateway; an unlinked one reports
 * push as unavailable. FL-926: a device that registered a UnifiedPush endpoint is reached there instead
 * (Web Push encrypted, `UnifiedPushRepository`), with or without a Cloud link.
 */
@Injectable()
export class PushService {
  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private databaseRepository: DatabaseRepository,
    private instanceIdentityRepository: InstanceIdentityRepository,
    private frameleafCloudRepository: FrameleafCloudRepository,
    private devices: PushDeviceRepository,
    private gateway: FrameleafCloudPushRepository,
    private jobRepository: JobRepository,
    private userRepository: UserRepository,
    private albumRepository: AlbumRepository,
    private unifiedPush: UnifiedPushRepository,
  ) {
    this.logger.setContext(PushService.name);
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */

  async getStatus(auth: AuthDto): Promise<PushStatusResponseDto> {
    const { reason } = await this.availability();
    const registered = auth.session ? !!(await this.devices.getBySession(auth.session.id)) : false;
    const unifiedPush = await this.unifiedPushAccess();
    return {
      available: reason === null,
      reason,
      encryption: { scheme: 'frameleaf-push-v1', keyAgreement: 'X25519', kdf: 'HKDF-SHA256', cipher: 'AES-256-GCM' },
      events: Object.values(PushEventType),
      registered,
      unifiedPush: { available: unifiedPush.available, reason: unifiedPush.reason, encoding: 'aes128gcm' },
    };
  }

  async listDevices(auth: AuthDto): Promise<PushDeviceListResponseDto> {
    this.requireUser(auth);
    const devices = await this.devices.getByUser(auth.user.id);
    const unifiedPush = devices.some((device) => device.unifiedPushEndpoint)
      ? await this.unifiedPushAccess()
      : { available: true, reason: null };
    return { devices: devices.map((device) => mapDevice(device, auth.session?.id, unifiedPush)) };
  }

  async register(auth: AuthDto, dto: PushDeviceRegisterDto): Promise<PushDeviceResponseDto> {
    const sessionId = this.requireSession(auth);
    const pushToStartToken = dto.pushToStartToken ?? null;
    if (dto.platform !== PushPlatform.Ios && (pushToStartToken || dto.apnsEnvironment)) {
      throw new BadRequestException('Only iOS devices have an ActivityKit push-to-start token or an APNs environment');
    }
    const unifiedPush = await this.parseUnifiedPush(dto, dto.platform);
    if (!dto.pushToken && !unifiedPush) {
      throw new BadRequestException(
        'A push token is needed, unless an Android device registers a UnifiedPush endpoint',
      );
    }
    this.requireTokens(dto.pushToken, pushToStartToken);
    const publicKey = this.parseKey(dto.publicKey);
    const current = await this.devices.getBySession(sessionId);
    const device = await this.devices.upsert({
      userId: auth.user.id,
      sessionId,
      platform: dto.platform,
      pushToken: dto.pushToken ?? null,
      pushToStartToken,
      apnsEnvironment: dto.apnsEnvironment === 'sandbox' ? 'sandbox' : null,
      publicKey,
      backupDeviceKey: dto.backupDeviceKey ?? null,
      disabledEvents: disabledEventsOf(dto.preferences, current?.disabledEvents),
      unifiedPushEndpoint: unifiedPush?.endpoint ?? null,
      unifiedPushPublicKey: unifiedPush?.p256dh ?? null,
      unifiedPushAuth: unifiedPush?.auth ?? null,
    });
    this.logger.log(
      `Push device ${device.id} (${device.platform}${unifiedPush ? ', UnifiedPush' : ''}) registered for user ${auth.user.id}`,
    );
    return mapDevice({ ...device, activities: current?.activities ?? [] }, sessionId, {
      available: true,
      reason: null,
    });
  }

  async update(auth: AuthDto, dto: PushDeviceUpdateDto): Promise<PushDeviceResponseDto> {
    const sessionId = this.requireSession(auth);
    const current = await this.devices.getBySession(sessionId);
    if (!current) {
      throw new NotFoundException('This device is not registered for push notifications');
    }
    if (current.platform !== PushPlatform.Ios && (dto.pushToStartToken || dto.apnsEnvironment)) {
      throw new BadRequestException('Only iOS devices have an ActivityKit push-to-start token or an APNs environment');
    }
    this.requireTokens(dto.pushToken, dto.pushToStartToken);
    const touchesUnifiedPush = [dto.unifiedPushEndpoint, dto.unifiedPushPublicKey, dto.unifiedPushAuth].some(
      (value) => value !== undefined,
    );
    let unifiedPushChanges = {};
    if (touchesUnifiedPush) {
      const unifiedPush = dto.unifiedPushEndpoint === null ? null : await this.parseUnifiedPush(dto, current.platform);
      if (!unifiedPush && !(dto.pushToken ?? current.pushToken)) {
        throw new BadRequestException('Without a UnifiedPush endpoint this device needs a push token');
      }
      unifiedPushChanges = {
        unifiedPushEndpoint: unifiedPush?.endpoint ?? null,
        unifiedPushPublicKey: unifiedPush?.p256dh ?? null,
        unifiedPushAuth: unifiedPush?.auth ?? null,
      };
    }
    const changes = {
      ...(dto.apnsEnvironment !== undefined && {
        apnsEnvironment: dto.apnsEnvironment === 'sandbox' ? ('sandbox' as const) : null,
      }),
      ...(dto.pushToken !== undefined && { pushToken: dto.pushToken }),
      ...(dto.pushToStartToken !== undefined && { pushToStartToken: dto.pushToStartToken }),
      ...(dto.publicKey !== undefined && { publicKey: this.parseKey(dto.publicKey) }),
      ...(dto.backupDeviceKey !== undefined && { backupDeviceKey: dto.backupDeviceKey }),
      ...(dto.preferences !== undefined && {
        disabledEvents: disabledEventsOf(dto.preferences, current.disabledEvents),
      }),
      ...unifiedPushChanges,
    };
    const device = await this.devices.update(sessionId, changes);
    if (!device) {
      throw new NotFoundException('This device is not registered for push notifications');
    }
    return mapDevice({ ...device, activities: current.activities }, sessionId, await this.unifiedPushStateOf(device));
  }

  async unregisterCurrent(auth: AuthDto): Promise<void> {
    const sessionId = this.requireSession(auth);
    await this.devices.deleteBySession(sessionId);
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    this.requireUser(auth);
    if (!(await this.devices.deleteForUser(auth.user.id, id))) {
      throw new NotFoundException('Push device not found');
    }
  }

  /**
   * FL-926: send a test notification to one device now, the way the device is reached (UnifiedPush or
   * the Cloud gateway), and say what happened. Its owner or an administrator may; the device's event
   * preferences do not apply. A device its push service reports gone is unregistered.
   */
  async sendTest(auth: AuthDto, id: string): Promise<PushDeviceTestResponseDto> {
    this.requireUser(auth);
    const device = await this.devices.getById(id);
    if (!device || (device.userId !== auth.user.id && !auth.user.isAdmin)) {
      throw new NotFoundException('Push device not found');
    }
    const registered: PushTransport = device.unifiedPushEndpoint ? 'unifiedpush' : 'cloud';
    const availability = await this.availability();
    const access = device.unifiedPushEndpoint ? await this.unifiedPushAccess() : undefined;
    const transport = this.transportOf(device, availability.reason === null, access);
    if (!transport) {
      return {
        transport: registered,
        status: 'unavailable',
        message:
          access && !access.available
            ? 'UnifiedPush needs a licensed server'
            : `Push through Frameleaf Cloud is unavailable (${availability.reason ?? 'the device has no push token'})`,
      };
    }
    const locale = notificationLocaleOf(
      getPreferences((await this.userRepository.getMetadata(device.userId).catch(() => [])) ?? []),
      device.sessionId,
    );
    const [entry] = this.plan(
      { ...device, disabledEvents: [], activities: [] },
      TEST_NOTICE,
      new Set(),
      new Date().toISOString(),
      locale,
      transport,
    );
    if (!entry) {
      return { transport, status: 'refused', message: 'The test notification could not be built for this device' };
    }
    let target: PushGatewayTarget | null = null;
    if (transport === 'cloud') {
      try {
        target = await this.gatewayTarget(availability.instanceId!, availability.cloudUrl!);
      } catch (error) {
        return { transport, status: 'retry', message: errorMessage(error) };
      }
      if (!target) {
        return { transport, status: 'unavailable', message: 'Frameleaf Cloud publishes no push gateway address' };
      }
    }
    const result = await this.sendPlanned(entry, target, access, 'test');
    switch (result.status) {
      case 'sent': {
        await this.devices.markDelivered([device.id]);
        return { transport, status: 'sent', message: null };
      }
      case 'gone': {
        await this.devices.deleteGoneUnifiedPush([{ id: device.id, endpoint: entry.unifiedPush!.endpoint }]);
        return { transport, status: 'gone', message: 'The UnifiedPush server no longer knows this device' };
      }
      case 'invalid-token': {
        await this.devices.deleteByIds([
          { id: device.id, token: entry.request.token, platform: entry.request.platform },
        ]);
        return { transport, status: 'gone', message: 'The push service no longer knows this device' };
      }
      case 'retry':
      case 'throttled': {
        return { transport, status: 'retry', message: 'The push service is busy; try again later' };
      }
      default: {
        return { transport, status: 'refused', message: result.reason ?? 'The push service refused the notification' };
      }
    }
  }

  async setActivityToken(auth: AuthDto, activityId: string, dto: PushActivityTokenDto): Promise<PushDeviceResponseDto> {
    const sessionId = this.requireSession(auth);
    const current = await this.devices.getBySession(sessionId);
    if (!current) {
      throw new NotFoundException('This device is not registered for push notifications');
    }
    if (current.platform !== PushPlatform.Ios) {
      throw new BadRequestException('Only iOS devices have Live Activity push tokens');
    }
    this.requireTokens(dto.token);
    if (dto.kind === 'studio-render' && !dto.operationId) {
      throw new BadRequestException('Studio render activity requires its operationId');
    }
    await this.devices.setActivity(current.id, {
      activityId,
      kind: dto.kind,
      token: dto.token,
      ...(dto.operationId && { operationId: dto.operationId }),
    });
    const device = await this.devices.getBySession(sessionId);
    return mapDevice(device ?? current, sessionId, await this.unifiedPushStateOf(device ?? current));
  }

  async removeActivityToken(auth: AuthDto, activityId: string): Promise<void> {
    const sessionId = this.requireSession(auth);
    const current = await this.devices.getBySession(sessionId);
    if (!current || !(await this.devices.deleteActivity(current.id, activityId))) {
      throw new NotFoundException('Live Activity not found');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Token lifecycle                                                     */
  /* ------------------------------------------------------------------ */

  /** Logout and session revocation; the foreign key already removed the row, this covers any path. */
  @OnEvent({ name: 'SessionDelete' })
  async onSessionDelete({ sessionId }: ArgOf<'SessionDelete'>) {
    await this.devices.deleteBySession(sessionId);
  }

  /** Account removal: a trashed account gets nothing more, long before it is deleted for good. */
  @OnEvent({ name: 'UserTrash' })
  async onUserTrash({ id }: ArgOf<'UserTrash'>) {
    const removed = await this.devices.deleteAllForUser(id);
    if (removed > 0) {
      this.logger.log(`Removed ${removed} push device(s) of removed user ${id}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Event selection                                                     */
  /* ------------------------------------------------------------------ */

  @OnEvent({ name: 'PushNotify' })
  async onPushNotify(notice: ArgOf<'PushNotify'>) {
    await this.queue(notice);
  }

  /** Items were added to a shared album or space: one coalesced notice per member who did not add them. */
  @OnEvent({ name: 'AlbumUpdate' })
  async onAlbumUpdate({ id, recipientIds }: ArgOf<'AlbumUpdate'>) {
    if (recipientIds.length === 0 || !(await this.canDeliver())) {
      return;
    }
    const album = await this.albumInfo(id);
    if (!album) {
      return;
    }
    for (const recipientId of recipientIds) {
      await this.queue({
        type: PushEventType.SharedActivity,
        userIds: [recipientId],
        title: album.albumName,
        body: `New items were added to ${album.albumName}`,
        systemTemplate: { version: 1, key: 'push-album-update', args: { albumName: album.albumName } },
        data: { albumId: id, action: 'items-added' },
        assetIds: album.albumThumbnailAssetId ? [album.albumThumbnailAssetId] : [],
        dedupeKey: `album-update/${id}/${recipientId}`,
        delayMs: PUSH_ALBUM_UPDATE_DELAY_MS,
      });
    }
  }

  @OnEvent({ name: 'AlbumInvite' })
  async onAlbumInvite({ id, userId, senderName }: ArgOf<'AlbumInvite'>) {
    if (!(await this.canDeliver())) {
      return;
    }
    const album = await this.albumInfo(id);
    if (!album) {
      return;
    }
    await this.queue({
      type: PushEventType.SharedActivity,
      userIds: [userId],
      title: 'Shared with you',
      body: `${senderName} shared ${album.albumName} with you`,
      systemTemplate: { version: 1, key: 'push-album-invite', args: { senderName, albumName: album.albumName } },
      data: { albumId: id, action: 'invited' },
      assetIds: album.albumThumbnailAssetId ? [album.albumThumbnailAssetId] : [],
    });
  }

  @OnEvent({ name: 'ItemShare' })
  async onItemShare({ ownerId, userId, senderName, count }: ArgOf<'ItemShare'>) {
    // like the in-app notification, it never names or shows an item (FL-83)
    await this.queue({
      type: PushEventType.SharedActivity,
      userIds: [userId],
      title: 'Shared with you',
      body: count === 1 ? `${senderName} shared an item with you` : `${senderName} shared ${count} items with you`,
      systemTemplate:
        count === 1
          ? { version: 1, key: 'item-share-one', args: { senderName } }
          : { version: 1, key: 'item-share-many', args: { senderName, count } },
      data: { ownerId, count, action: 'items-shared' },
    });
  }

  @OnEvent({ name: 'SharedSpaceMention' })
  async onSharedSpaceMention({ id, assetId, activityId, userIds, senderName }: ArgOf<'SharedSpaceMention'>) {
    if (userIds.length === 0 || !(await this.canDeliver())) {
      return;
    }
    const album = await this.albumInfo(id);
    if (!album) {
      return;
    }
    await this.queue({
      type: PushEventType.SharedActivity,
      userIds,
      title: 'Mentioned in a shared space',
      body: `${senderName} mentioned you in ${album.albumName}`,
      systemTemplate: { version: 1, key: 'space-mention', args: { senderName, albumName: album.albumName } },
      data: { albumId: id, activityId, action: 'mentioned', ...(assetId && { assetId }) },
      assetIds: assetId ? [assetId] : [],
    });
  }

  @OnEvent({ name: 'SharedSpaceReply' })
  async onSharedSpaceReply({ id, assetId, activityId, userId, senderName }: ArgOf<'SharedSpaceReply'>) {
    if (!(await this.canDeliver())) {
      return;
    }
    const album = await this.albumInfo(id);
    if (!album) {
      return;
    }
    await this.queue({
      type: PushEventType.SharedActivity,
      userIds: [userId],
      title: 'New reply',
      body: `${senderName} replied to your comment in ${album.albumName}`,
      systemTemplate: { version: 1, key: 'push-space-reply', args: { senderName, albumName: album.albumName } },
      data: { albumId: id, activityId, action: 'replied', ...(assetId && { assetId }) },
      assetIds: assetId ? [assetId] : [],
    });
  }

  /** A member was taken out of an album or shared space: their access ended. Leaving by oneself is silent. */
  @OnEvent({ name: 'AlbumUserRemove' })
  async onAlbumUserRemove({ albumId, userId, removedById }: ArgOf<'AlbumUserRemove'>) {
    if (removedById === userId || !(await this.canDeliver())) {
      return;
    }
    const album = await this.albumInfo(albumId);
    await this.queue({
      type: PushEventType.AccessChanged,
      userIds: [userId],
      title: 'Access changed',
      body: album ? `You no longer have access to ${album.albumName}` : 'You no longer have access to an album',
      systemTemplate: album
        ? { version: 1, key: 'access-removed', args: { albumName: album.albumName } }
        : { version: 1, key: 'access-removed-unknown', args: {} },
      data: { albumId, change: 'removed' },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Delivery                                                            */
  /* ------------------------------------------------------------------ */

  @OnJob({ name: JobName.PushDeliver, queue: QueueName.Notification })
  async handleDeliver({ notice }: JobOf<JobName.PushDeliver>): Promise<JobStatus> {
    const availability = await this.availability();
    const cloudReady = availability.reason === null;
    // FL-926: an unlinked server still delivers to devices that registered a UnifiedPush endpoint
    if (!cloudReady && !(await this.devices.hasUnifiedPushDevices())) {
      this.logger.debug(`Push ${notice.type} not delivered: push is unavailable (${availability.reason})`);
      return JobStatus.Skipped;
    }

    const recipients = new Set(notice.userIds);
    if (notice.admins) {
      for (const admin of await this.userRepository.getAdmins()) {
        recipients.add(admin.id);
      }
    }
    let devices = (await this.devices.getDeliveryTargets([...recipients])).filter(
      (device) => !device.disabledEvents.includes(notice.type) || !!(notice.render && liveActivityPlanOf(notice)?.end),
    );
    if (notice.backupDeviceKey) {
      const linked = devices.filter((device) => device.backupDeviceKey === notice.backupDeviceKey);
      // a wake-up is for that device alone; anything else may go to all of the owner's devices
      devices = linked.length > 0 || notice.background ? linked : devices;
    }
    // FL-926: each device by its own way: its UnifiedPush endpoint, else the gateway when linked
    const access = devices.some((device) => device.unifiedPushEndpoint) ? await this.unifiedPushAccess() : undefined;
    const routed = devices.flatMap((device) => {
      const transport = this.transportOf(device, cloudReady, access);
      return transport ? [{ device, transport }] : [];
    });
    if (routed.length === 0) {
      if (!cloudReady) {
        this.logger.debug(`Push ${notice.type} not delivered: push is unavailable (${availability.reason})`);
      }
      return JobStatus.Skipped;
    }
    devices = routed.map(({ device }) => device);
    const transports = new Map(routed.map(({ device, transport }) => [device.id, transport]));

    // a recipient's hidden people, pets and tags hide an item from that recipient's push alone (FL-293)
    const assetIds = [...new Set(notice.assetIds)];
    const safeForAll = await this.devices.getPreviewSafeAssetIds(assetIds);
    const safeAssetIds = new Map<string, Set<string>>();
    const locales = new Map<string, ReturnType<typeof getPreferences>>();
    for (const userId of new Set(devices.map((device) => device.userId))) {
      // Read at delivery, including retries; queued notices never freeze a device's language.
      locales.set(userId, getPreferences((await this.userRepository.getMetadata(userId).catch(() => [])) ?? []));
      const hiddenContent = safeForAll.size > 0 ? await this.hiddenContentOf(userId) : undefined;
      safeAssetIds.set(
        userId,
        hiddenContent ? await this.devices.getPreviewSafeAssetIds(assetIds, hiddenContent) : safeForAll,
      );
    }
    const sentAt = new Date().toISOString();
    let planned = devices.flatMap((device) =>
      this.plan(
        device,
        notice,
        safeAssetIds.get(device.userId)!,
        sentAt,
        notificationLocaleOf(locales.get(device.userId)!, device.sessionId),
        transports.get(device.id)!,
      ),
    );
    if (notice.retry) {
      const wanted = new Set(notice.retry.targets);
      planned = planned.filter((entry) => wanted.has(deliveryKeyOf(entry)));
    }
    if (planned.length === 0) {
      return JobStatus.Skipped;
    }

    const results: Array<{ entry: PlannedMessage; result: DeliveryResult }> = [];
    let target: PushGatewayTarget | null = null;
    if (planned.some((entry) => !entry.unifiedPush)) {
      try {
        target = await this.gatewayTarget(availability.instanceId!, availability.cloudUrl!);
      } catch (error) {
        this.logger.warn(`Push ${notice.type} to ${planned.length} target(s) failed: ${errorMessage(error)}`);
        if (planned.every((entry) => !entry.unifiedPush)) {
          return JobStatus.Failed;
        }
        // the UnifiedPush targets go now; the gateway's are tried again with the next attempt
        const gatewayTargets = planned.filter((entry) => !entry.unifiedPush);
        results.push(...gatewayTargets.map((entry) => ({ entry, result: { status: 'retry' as const } })));
        planned = planned.filter((entry) => entry.unifiedPush);
      }
      if (!target && planned.some((entry) => !entry.unifiedPush)) {
        this.logger.debug(
          `Push ${notice.type} not delivered: Frameleaf Cloud publishes no push gateway address and FRAMELEAF_PUSH_URL is unset`,
        );
        planned = planned.filter((entry) => entry.unifiedPush);
        if (planned.length === 0) {
          return JobStatus.Skipped;
        }
      }
    }

    // one push per request, a few at a time; a failed request is a `retry` or a refusal
    const queue = [...planned];
    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        results.push({ entry, result: await this.sendPlanned(entry, target, access, notice.type) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUSH_GATEWAY_CONCURRENCY, planned.length) }, () => worker()));

    const delivered = new Set<string>();
    const goneDevices = new Map<string, PushTokenRef>();
    const goneStartTokens = new Map<string, PushTokenRef>();
    const goneActivities = new Map<string, PushTokenRef>();
    const goneUnifiedPush = new Map<string, UnifiedPushEndpointRef>();
    const again: PlannedMessage[] = [];
    let retryAfterSec = 0;
    let rejected = 0;
    for (const { entry, result } of results) {
      switch (result.status) {
        case 'rejected': {
          rejected++;
          break;
        }
        case 'gone': {
          // FL-926: the UnifiedPush endpoint no longer exists; the app registers a new one
          goneUnifiedPush.set(entry.deviceId, { id: entry.deviceId, endpoint: entry.unifiedPush!.endpoint });
          break;
        }
        case 'sent': {
          delivered.add(entry.deviceId);
          break;
        }
        case 'invalid-token': {
          const invalid = { id: entry.deviceId, token: entry.request.token, platform: entry.request.platform };
          if (entry.kind === PushTargetKind.Device) {
            goneDevices.set(entry.deviceId, invalid);
          } else if (entry.kind === PushTargetKind.ActivityStart) {
            goneStartTokens.set(entry.deviceId, invalid);
          } else if (entry.activityRowId) {
            goneActivities.set(entry.activityRowId, { ...invalid, id: entry.activityRowId });
          }
          break;
        }
        default: {
          if (entry.request.type === 'live-activity-update') {
            // never retried: a later attempt could show an older step, and the next update replaces it anyway
            rejected++;
          } else {
            again.push(entry);
            retryAfterSec = Math.max(retryAfterSec, result.retryAfterSec ?? 0);
          }
        }
      }
    }
    await this.devices.deleteByIds(goneDevices.values().toArray());
    await this.devices.clearPushToStartTokens(
      goneStartTokens
        .values()
        .filter(({ id }) => !goneDevices.has(id))
        .toArray(),
    );
    await this.devices.deleteActivitiesByIds(goneActivities.values().toArray());
    await this.devices.deleteGoneUnifiedPush(goneUnifiedPush.values().toArray());
    await this.devices.markDelivered([...delivered].filter((id) => !goneDevices.has(id)));

    const attempt = (notice.retry?.attempt ?? 1) + 1;
    const retrying = again.length > 0 && attempt <= PUSH_GATEWAY_MAX_ATTEMPTS;
    if (retrying) {
      // only the targets the gateway asked to retry; a fresh job id, as the first one may still be kept
      await this.jobRepository.queue({
        name: JobName.PushDeliver,
        data: {
          notice: {
            ...notice,
            dedupeKey: undefined,
            delayMs: retryDelayMs(attempt, retryAfterSec),
            retry: {
              targets: again.map((entry) => deliveryKeyOf(entry)),
              attempt,
              ...(collapseIdOfNotice(notice) && { collapseId: collapseIdOfNotice(notice) }),
            },
          },
        },
      });
    }
    if (rejected > 0 || goneDevices.size > 0 || goneUnifiedPush.size > 0 || again.length > 0) {
      this.logger.warn(
        `Push ${notice.type}: ${delivered.size} device(s) reached, ${rejected} target(s) refused, ${goneDevices.size} invalid device token(s) reported, ${goneUnifiedPush.size} UnifiedPush endpoint(s) gone, ${again.length} to retry${retrying || again.length === 0 ? '' : ' (given up)'}`,
      );
    }
    return JobStatus.Success;
  }

  /** The nightly wake-up of devices whose phone backup has not succeeded for two days. */
  @OnJob({ name: JobName.PushBackupStaleCheck, queue: QueueName.BackgroundTask })
  async handleBackupStaleCheck(): Promise<JobStatus> {
    if (!(await this.canDeliver())) {
      return JobStatus.Skipped;
    }
    const now = Date.now();
    const targets = await this.devices.getStaleBackupWakeTargets(
      new Date(now - PUSH_BACKUP_STALE_AFTER_MS),
      new Date(now - PUSH_BACKUP_WAKE_INTERVAL_MS),
    );
    for (const target of targets) {
      const days = Math.max(1, Math.floor((now - new Date(target.lastSuccessfulBackupAt).getTime()) / 86_400_000));
      await this.queue({
        type: PushEventType.BackupStale,
        userIds: [target.userId],
        title: 'Backup is out of date',
        body: `${target.displayName} has not backed up for ${days} day${days === 1 ? '' : 's'}`,
        systemTemplate:
          days === 1
            ? { version: 1, key: 'backup-stale-one', args: { deviceName: target.displayName } }
            : { version: 1, key: 'backup-stale-many', args: { deviceName: target.displayName, count: days } },
        data: {
          backupDeviceKey: target.backupDeviceKey,
          pendingCount: target.pendingCount,
          lastSuccessfulBackupAt: new Date(target.lastSuccessfulBackupAt).toISOString(),
        },
        backupDeviceKey: target.backupDeviceKey,
        background: true,
      });
    }
    await this.devices.markStaleWake(targets.map(({ deviceId }) => deviceId));
    return JobStatus.Success;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The gateway requests for one device: one per token the notice goes to. Alerts and wake-ups carry
   * the payload sealed to the device key; a Live Activity carries only its fixed, non-personal state.
   */
  private plan(
    device: PushDeviceWithActivities,
    notice: PushNotice,
    safeAssetIds: ReadonlySet<string>,
    sentAt: string,
    locale: string,
    transport: PushTransport = 'cloud',
  ): PlannedMessage[] {
    const platform =
      device.platform === PushPlatform.Android
        ? ('fcm' as const)
        : device.apnsEnvironment === 'sandbox'
          ? ('apns-sandbox' as const)
          : ('apns' as const);
    const collapseId = collapseIdOfNotice(notice);
    const planned: PlannedMessage[] = [];
    const live = liveActivityPlanOf(notice);
    // FL-926: UnifiedPush is Android only, so it never carries a Live Activity
    const unifiedPush: UnifiedPushSubscription | undefined =
      transport === 'unifiedpush' && device.unifiedPushEndpoint && device.unifiedPushPublicKey && device.unifiedPushAuth
        ? { endpoint: device.unifiedPushEndpoint, p256dh: device.unifiedPushPublicKey, auth: device.unifiedPushAuth }
        : undefined;
    if (live && device.platform === PushPlatform.Ios && !unifiedPush) {
      const base = {
        platform,
        priority: 'high' as const,
        ttlSec: pushTtlSec(notice, true),
        liveActivity: { state: live.state, staleAfterSec: 3600 },
      };
      const activities = device.activities.filter(
        ({ kind, operationId }) => kind === live.kind && (!notice.render || operationId === notice.render.job),
      );
      for (const activity of activities) {
        planned.push({
          deviceId: device.id,
          kind: PushTargetKind.ActivityUpdate,
          activityRowId: activity.id,
          request: {
            ...base,
            token: activity.token,
            type: live.end ? 'live-activity-end' : 'live-activity-update',
          },
        });
      }
      if (activities.length === 0 && device.pushToStartToken && live.start) {
        planned.push({
          deviceId: device.id,
          kind: PushTargetKind.ActivityStart,
          request: {
            ...base,
            token: device.pushToStartToken,
            type: 'live-activity-start',
            liveActivity: { ...base.liveActivity, attributesType: live.attributesType },
          },
        });
      }
    }
    // While the chain runs, iOS follows it in the Live Activity alone; Android shows it as a progress
    // notification, and the end of the chain (complete or failed) is an alert everywhere. A render's
    // progress works the same way, except that its start also reaches iOS (naming the job).
    const silentRenderEnd = !!(
      notice.render &&
      live?.end &&
      device.platform === PushPlatform.Android &&
      !device.disabledEvents.includes(PushEventType.RenderProgress) &&
      device.disabledEvents.includes(notice.type)
    );
    if (
      (!live?.liveOnly || device.platform !== PushPlatform.Ios) &&
      (!device.disabledEvents.includes(notice.type) || silentRenderEnd) &&
      (unifiedPush || device.pushToken)
    ) {
      const id = randomUUID();
      try {
        // the same payload either way (FL-926): UnifiedPush carries no more than the gateway gets
        const payload = buildPushPayload(notice, { id, sentAt, safeAssetIds, locale });
        planned.push({
          deviceId: device.id,
          kind: PushTargetKind.Device,
          request: {
            platform,
            token: device.pushToken ?? '',
            type: notice.background || silentRenderEnd ? 'background' : 'alert',
            priority: notice.background || silentRenderEnd ? 'normal' : 'high',
            ttlSec: pushTtlSec(notice, false),
            payload: sealPushEnvelope(device.publicKey, Buffer.from(JSON.stringify(payload), 'utf8')),
            ...(collapseId && { collapseId }),
          },
          ...(unifiedPush && { unifiedPush }),
        });
      } catch (error) {
        this.logger.warn(`Push device ${device.id} could not receive this notice: ${errorMessage(error)}`);
      }
    }
    return planned;
  }

  private async queue(notice: PushNotice) {
    if (!(await this.canDeliver())) {
      return;
    }
    await this.jobRepository.queue({ name: JobName.PushDeliver, data: { notice } });
  }

  /**
   * One planned push, by its device's way: the device's UnifiedPush endpoint (FL-926) or the gateway.
   * Never logs the request, the token or the endpoint.
   */
  private async sendPlanned(
    entry: PlannedMessage,
    target: PushGatewayTarget | null,
    access: UnifiedPushAccess | undefined,
    label: string,
  ): Promise<DeliveryResult> {
    if (entry.unifiedPush) {
      const result = await this.unifiedPush.send(
        entry.unifiedPush,
        {
          plaintext: unifiedPushPlaintextOf(entry.request),
          ttlSec: entry.request.ttlSec,
          urgency: entry.request.priority,
          topic: entry.request.collapseId,
        },
        { allowLocalTargets: access?.allowLocalTargets ?? UNIFIED_PUSH_DEFAULTS.allowLocalTargets },
      );
      if (result.status === 'refused') {
        this.logger.warn(`Push ${label}: UnifiedPush refused a send to device ${entry.deviceId}: ${result.reason}`);
        return { status: 'rejected', reason: result.reason };
      }
      return result;
    }
    if (!target) {
      return { status: 'rejected', reason: 'Frameleaf Cloud publishes no push gateway address' };
    }
    if (!isGatewayToken(entry.request.token)) {
      // registered before tokens were checked: the gateway could never deliver to it
      return { status: 'invalid-token' };
    }
    try {
      return await this.gateway.send(target, entry.request);
    } catch (error) {
      // a request this server built wrongly is refused, never retried
      const status = error instanceof FrameleafCloudError ? error.status : error instanceof ZodError ? 400 : null;
      // never the request: it holds the device token
      this.logger.warn(`Push ${label}: the gateway refused a send: ${errorMessage(error)}`);
      return status === null || status >= 500 || status === 429
        ? { status: 'retry', ...retryAfterOf(error) }
        : { status: 'rejected', reason: errorMessage(error) };
    }
  }

  /** FL-926: how a device is reached now, or null when it cannot be. */
  private transportOf(
    device: Pick<PushDeviceWithActivities, 'unifiedPushEndpoint' | 'pushToken'>,
    cloudReady: boolean,
    access: Pick<UnifiedPushAccess, 'available'> | undefined,
  ): PushTransport | null {
    if (device.unifiedPushEndpoint && access?.available) {
      return 'unifiedpush';
    }
    // a device whose UnifiedPush is unavailable (not licensed) still has the gateway, if it has a token
    return cloudReady && device.pushToken ? 'cloud' : null;
  }

  /** Whether anything can be delivered: a linked server, or UnifiedPush devices this server may use. */
  private async canDeliver() {
    if (await this.isLinked()) {
      return true;
    }
    return (await this.devices.hasUnifiedPushDevices()) && (await this.unifiedPushAccess()).available;
  }

  /**
   * FL-926: whether UnifiedPush may be used (`notifications.unifiedPush.availability`: `all`, or
   * `licensed` for a server with an active licence, pending the pricing decision FL-908), and whether
   * push servers on this network may be reached (`allowLocalTargets`).
   */
  private async unifiedPushAccess(): Promise<UnifiedPushAccess> {
    const config = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
    const settings = { ...UNIFIED_PUSH_DEFAULTS, ...config.notifications.unifiedPush };
    if (
      settings.availability === 'licensed' &&
      !isLicensed(await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense))
    ) {
      return { available: false, reason: 'licence-required', allowLocalTargets: settings.allowLocalTargets };
    }
    return { available: true, reason: null, allowLocalTargets: settings.allowLocalTargets };
  }

  private async unifiedPushStateOf(device: Pick<PushDeviceWithActivities, 'unifiedPushEndpoint'>) {
    return device.unifiedPushEndpoint ? await this.unifiedPushAccess() : { available: true, reason: null };
  }

  /**
   * FL-926: the UnifiedPush fields of a registration: none, or all three (endpoint and Web Push keys),
   * from an Android device, on a server that may use UnifiedPush, at an address it may reach.
   */
  private async parseUnifiedPush(
    fields: {
      unifiedPushEndpoint?: string | null;
      unifiedPushPublicKey?: string | null;
      unifiedPushAuth?: string | null;
    },
    platform: PushPlatform,
  ): Promise<UnifiedPushSubscription | null> {
    const { unifiedPushEndpoint: endpoint, unifiedPushPublicKey: p256dh, unifiedPushAuth: auth } = fields;
    if (!endpoint && !p256dh && !auth) {
      return null;
    }
    if (!endpoint || !p256dh || !auth) {
      throw new BadRequestException('A UnifiedPush endpoint needs its unifiedPushPublicKey and unifiedPushAuth');
    }
    if (platform !== PushPlatform.Android) {
      throw new BadRequestException('Only Android devices use UnifiedPush');
    }
    const access = await this.unifiedPushAccess();
    if (!access.available) {
      throw new ForbiddenException('UnifiedPush needs a licensed server');
    }
    try {
      this.unifiedPush.checkEndpoint(endpoint, { allowLocalTargets: access.allowLocalTargets });
      return {
        endpoint,
        p256dh: parseWebPushPublicKey(p256dh).toString('base64url'),
        auth: parseWebPushAuth(auth).toString('base64url'),
      };
    } catch (error) {
      throw new BadRequestException(errorMessage(error));
    }
  }

  /** The recipient's hidden people, pets and tags (the Locked rules), as every ordinary read applies them. */
  private async hiddenContentOf(userId: string): Promise<HiddenContentFilter | undefined> {
    const { suppression } = getPreferences(await this.userRepository.getMetadata(userId)).privacy;
    const filter = { userId, includeNsfw: false, ...suppression };
    return hasHiddenContentFilter(filter) ? filter : undefined;
  }

  private async albumInfo(id: string) {
    const album = await this.albumRepository.getById(id, { withAssets: false });
    return album ? { albumName: album.albumName, albumThumbnailAssetId: album.albumThumbnailAssetId } : null;
  }

  private gatewayDeps() {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    };
  }

  /** Whether push can be delivered now, without contacting anything. */
  private async availability(): Promise<{
    reason: PushUnavailableReason | null;
    cloudUrl?: string;
    instanceId?: string;
  }> {
    const { cloudUrl, link, linked } = await readCloudLink(this.gatewayDeps());
    if (!cloudUrl) {
      return { reason: PushUnavailableReason.NotConfigured };
    }
    if (!linked || !link?.instanceId) {
      return { reason: PushUnavailableReason.NotLinked };
    }
    if (link.heartbeat?.cloneSuspected) {
      return { reason: PushUnavailableReason.CloneSuspected };
    }
    return { reason: null, cloudUrl, instanceId: link.instanceId };
  }

  private async isLinked() {
    return (await this.availability()).reason === null;
  }

  private async gatewayTarget(instanceId: string, cloudUrl: string) {
    const document = await this.frameleafCloudRepository.discovery(cloudUrl);
    await loadInstanceIdentity(this.gatewayDeps());
    return this.gateway.target(
      document,
      instanceId,
      this.instanceIdentityRepository.currentSigner(),
      this.configRepository.getEnv().frameleafCloud.pushUrl,
    );
  }

  private requireUser(auth: AuthDto) {
    if (auth.sharedLink) {
      throw new ForbiddenException('Push notifications need a signed-in account');
    }
  }

  private requireSession(auth: AuthDto): string {
    this.requireUser(auth);
    if (!auth.session) {
      throw new BadRequestException('Push registration needs a signed-in device session, not an API key');
    }
    return auth.session.id;
  }

  /** A token the push gateway could never deliver to is refused at once, never stored. */
  private requireTokens(...tokens: Array<string | null | undefined>) {
    if (tokens.some((token) => typeof token === 'string' && !isGatewayToken(token))) {
      throw new BadRequestException(
        'A push token is an APNs, ActivityKit or FCM token (32 or more letters, digits, -, _ or :)',
      );
    }
  }

  private parseKey(value: string): string {
    try {
      return parsePushPublicKey(value);
    } catch (error) {
      throw new BadRequestException(errorMessage(error));
    }
  }
}
